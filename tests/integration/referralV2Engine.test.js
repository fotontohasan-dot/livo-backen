const { pool } = require('../../db');
const engine = require('../../services/referralRewards');
const walletCallback = require('../../services/walletCallback');
const payment = require('../../routes/payment');
const referral = require('../../services/referral');
const { makeUser, link, makeDeposit, coins, reward, cleanup } = require('../helpers/referralDeposit');

// ==================== Referral V2 পেআউট ইঞ্জিন (আসল Postgres) ====================
// docs/REFERRAL_V2_DESIGN.md। সব টেস্ট আসল approve পথ (approvePaymentRequestById →
// creditApprovedDeposit → COMMIT → afterDepositCommit) বা ইঞ্জিন সরাসরি চালায়।

jest.setTimeout(60000);

const created = [];
async function user(prefix, opts) { const id = await makeUser(prefix, opts); created.push(id); return id; }
async function pair() {
  const referrer = await user('rf');
  const referred = await user('rd');
  await link(referrer, referred);
  return { referrer, referred };
}
async function approve(depositId) { return payment.approvePaymentRequestById(depositId); }
async function depositAndApprove(userId, amount, opts) {
  const id = await makeDeposit(userId, amount, opts);
  const r = await approve(id);
  expect(r.success).toBe(true);
  return id;
}
async function count(sql, params) { return Number((await pool.query(sql, params)).rows[0].count); }

afterAll(async () => { await cleanup(created); });

describe('কনফিগ ও টিয়ার', () => {
  test('tierFor সীমানা: ১=১০০, ২-৫=২০০, ৬-১৫=৪০০, ১৬-৫০=৮০০, ৫১+=১৫০০', () => {
    const exp = { 1: 100, 2: 200, 5: 200, 6: 400, 15: 400, 16: 800, 50: 800, 51: 1500, 500: 1500 };
    for (const [n, amt] of Object.entries(exp)) expect(engine.tierFor(Number(n)).amount).toBe(amt);
    expect(engine.tierFor(1).tier).toBe(1);
    expect(engine.tierFor(51).tier).toBe(5);
  });

  test('ডিফল্ট কনফিগ: ন্যূনতম ১০০ ও টিয়ার settings-এ সিডেড', async () => {
    expect(await engine.getMinDeposit()).toBe(100);
    expect(await engine.getTiers()).toEqual(engine.DEFAULT_TIERS);
    expect(engine.parseTiers('not json')).toBeNull();
    expect(engine.parseTiers('[{"max":5,"amount":10}]')).toBeNull(); // শেষ টিয়ারে max থাকলে অবৈধ
  });
});

describe('পেআউট নিয়ম', () => {
  test('৫০০-তে রেফারার বোনাস (৭৫) পায়: কয়েন, লেজার, রেকর্ড, ৩x স্পোর্টস/০x ক্যাসিনো ওয়েজারিং', async () => {
    const { referrer, referred } = await pair();
    const dep = await depositAndApprove(referred, 500);

    expect(await coins(referrer)).toBe(75);
    const rw = await reward(referred);
    expect(rw.status).toBe('paid');
    expect(rw.tier).toBe(3);
    expect(Number(rw.amount)).toBe(75);
    expect(Number(rw.qualifying_deposit_id)).toBe(dep);

    const bonus = (await pool.query(`SELECT * FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referrer])).rows;
    expect(bonus).toHaveLength(1);
    expect(Number(bonus[0].sports_required)).toBe(225);
    expect(Number(bonus[0].casino_required)).toBe(0);
    expect(bonus[0].status).toBe('active');

    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1 AND type='referral_bonus'`, [referrer])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND from_user_id=$2 AND reason='first_deposit'`, [referrer, referred])).toBe(1);
    // পুরোনো signup ফ্ল্যাগ ও 'signup' লেজার আর লেখা হয় না
    const ref = (await pool.query(`SELECT signup_bonus_paid, first_deposit_done FROM referrals WHERE referred_id=$1`, [referred])).rows[0];
    expect(ref.signup_bonus_paid).toBe(false);
    expect(ref.first_deposit_done).toBe(true);
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND reason='signup'`, [referrer])).toBe(0);
  });

  test('সাইন-আপ/রেফারেল তৈরিতে কোনো বোনাস বা রেকর্ড নেই', async () => {
    const referrer = await user('rf');
    const referred = await user('rd');
    await referral.createReferral(null, referrer, referred);
    expect(await coins(referrer)).toBe(0);
    expect(await reward(referred)).toBeNull();
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1`, [referrer])).toBe(0);
  });

  test('১০০-র নিচে (৯৯) বোনাস নেই; পরে ১০০+ ডিপোজিটে ট্রিগার হয়', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 99);
    expect(await coins(referrer)).toBe(0);
    expect(await reward(referred)).toBeNull();

    const big = await depositAndApprove(referred, 700);
    expect(await coins(referrer)).toBe(75);
    const rw = await reward(referred);
    expect(rw.status).toBe('paid');
    expect(Number(rw.qualifying_deposit_id)).toBe(big);
  });

  test('pending/rejected ডিপোজিটে কিছু নয়', async () => {
    const { referrer, referred } = await pair();
    const dep = await makeDeposit(referred, 1000, { status: 'pending' });
    expect((await engine.processReferralReward(referred, dep)).outcome).toBe('not_qualifying');
    await pool.query(`UPDATE payment_requests SET status='rejected' WHERE id=$1`, [dep]);
    expect((await engine.processReferralReward(referred, dep)).outcome).toBe('not_qualifying');
    expect(await coins(referrer)).toBe(0);
    expect(await reward(referred)).toBeNull();
  });

  test('বোনাস ডিপোজিট-অঙ্ক অনুযায়ী (রেফারেলের ক্রম নয়); legacy_paid প্রভাব ফেলে না', async () => {
    const referrer = await user('rf');
    // অন্য এক রেফার্ডের legacy_paid রেকর্ড — টিয়ার গণনায় আসবে না
    const legacyReferred = await user('lg');
    await link(referrer, legacyReferred);
    await pool.query(
      `INSERT INTO referral_rewards (referred_user_id, referrer_id, status, amount) VALUES ($1,$2,'legacy_paid',100)`,
      [legacyReferred, referrer]
    );
    const got = [];
    for (const amount of [100, 200, 500, 150, 300, 499, 5000]) {
      const referred = await user('rd');
      await link(referrer, referred);
      await depositAndApprove(referred, amount);
      got.push(Number((await reward(referred)).amount));
    }
    expect(got).toEqual([20, 50, 75, 20, 50, 50, 75]);
    expect(await coins(referrer)).toBe(20 + 50 + 75 + 20 + 50 + 50 + 75);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referrer_id=$1 AND status='paid'`, [referrer])).toBe(7);
  });

  test('একই রেফারারের ৫টি সমান্তরাল ডিপোজিটে বোনাস রেস নেই (৫×৭৫)', async () => {
    const referrer = await user('rf');
    const deps = [];
    for (let i = 0; i < 5; i++) {
      const referred = await user('rd');
      await link(referrer, referred);
      deps.push(await makeDeposit(referred, 500));
    }
    const results = await Promise.all(deps.map(approve));
    expect(results.every(r => r.success)).toBe(true);
    const rows = (await pool.query(
      `SELECT tier, amount FROM referral_rewards WHERE referrer_id=$1 AND status='paid' ORDER BY tier, amount`, [referrer]
    )).rows;
    expect(rows.map(r => Number(r.amount))).toEqual([75, 75, 75, 75, 75]);
    expect(rows.map(r => r.tier)).toEqual([3, 3, 3, 3, 3]);
    expect(await coins(referrer)).toBe(375);
  });

  test('একই ডিপোজিটে সমান্তরাল অ্যাডমিন অনুমোদন ও ডুপ্লিকেট ইঞ্জিন কল — পেআউট একবারই', async () => {
    const { referrer, referred } = await pair();
    const dep = await makeDeposit(referred, 1000);
    const results = await Promise.all([approve(dep), approve(dep), approve(dep), approve(dep)]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    await Promise.all([1, 2, 3].map(() => engine.processReferralReward(referred, dep)));
    expect(await coins(referrer)).toBe(75);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referred_user_id=$1`, [referred])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1 AND type='referral_bonus'`, [referrer])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referrer])).toBe(1);
  });

  test('ওয়ালেট callback ডুপ্লিকেট + পরে অ্যাডমিন অনুমোদন — ডিপোজিট ও রেফারেল দুটোই একবার', async () => {
    const { referrer, referred } = await pair();
    const dep = await makeDeposit(referred, 800);
    const row = (await pool.query('SELECT transaction_id FROM payment_requests WHERE id=$1', [dep])).rows[0];
    const data = { wallet: 'bkash', trxId: row.transaction_id, amount: 800, currency: 'BDT', isSuccess: true, status: 'success', paymentId: 'pay_' + dep };
    const [a, b] = await Promise.all([
      walletCallback.reconcile(data, payment.creditApprovedDeposit),
      walletCallback.reconcile(data, payment.creditApprovedDeposit)
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['already_processed', 'credited']);
    expect((await approve(dep)).success).toBe(false);
    expect(await coins(referrer)).toBe(75);
    expect(await coins(referred)).toBe(800);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referred_user_id=$1 AND status='paid'`, [referred])).toBe(1);
  });

  test('রেফার-করা ইউজার শুধু First Deposit Bonus পায়, কোনো রেফারেল বোনাস নয়', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 1000, { wantBonus: true });
    // ১ম ডিপোজিট ১০০% বোনাস (বিদ্যমান লজিক): ১০০০ + ১০০০
    expect(await coins(referred)).toBe(2000);
    const types = (await pool.query(`SELECT type FROM coin_transactions WHERE user_id=$1 ORDER BY id`, [referred])).rows.map(r => r.type);
    expect(types).toEqual(['deposit', 'deposit_bonus']);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referred])).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1 AND bonus_type='deposit'`, [referred])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referrer_id=$1`, [referred])).toBe(0);
    // রেফারার তার আলাদা বোনাস পায়
    expect(await coins(referrer)).toBe(75);
    const refBonus = (await pool.query(`SELECT bonus_type FROM bonuses WHERE user_id=$1`, [referrer])).rows.map(r => r.bonus_type);
    expect(refBonus).toEqual(['referral']);
  });
});

describe('জালিয়াতি-গেট', () => {
  test('ফোন মিললে (ফরম্যাট ভিন্ন হলেও) pending_review — কোনো কয়েন/লেজার নয়', async () => {
    const referrer = await user('rf');
    const digits = '1' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9); // 10 অঙ্ক
    const other = await user('ot', { phone: '0' + digits });
    const referred = await user('rd', { phone: '+880' + digits });
    await link(referrer, referred);
    await depositAndApprove(referred, 600);

    const rw = await reward(referred);
    expect(rw.status).toBe('pending_review');
    expect(rw.review_reason).toContain('phone_match');
    expect(rw.evidence.phone_match.related_users).toContain(other);
    expect(Number(rw.amount)).toBe(0);
    expect(await coins(referrer)).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1`, [referrer])).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1`, [referrer])).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1`, [referrer])).toBe(0);
    // রেফার-করা ইউজারের ডিপোজিট স্বাভাবিক
    expect(await coins(referred)).toBe(600);
  });

  test('পেমেন্ট অ্যাকাউন্ট মিললে pending_review', async () => {
    const { referrer, referred } = await pair();
    const stranger = await user('st');
    const acct = '01700' + Math.floor(100000 + Math.random() * 899999);
    await makeDeposit(stranger, 1000, { status: 'approved', account: acct });
    await depositAndApprove(referred, 500, { account: acct });
    const rw = await reward(referred);
    expect(rw.status).toBe('pending_review');
    expect(rw.review_reason).toContain('payment_account_match');
    expect(await coins(referrer)).toBe(0);
  });

  test('শুধু একই IP — স্বয়ংক্রিয় প্রত্যাখ্যান/ফ্ল্যাগ নয়, paid; evidence-এ নোট', async () => {
    const { referrer, referred } = await pair();
    await pool.query(`INSERT INTO login_logs (user_id, ip) VALUES ($1,'203.0.113.77'),($2,'203.0.113.77')`, [referrer, referred]);
    await depositAndApprove(referred, 500);
    const rw = await reward(referred);
    expect(rw.status).toBe('paid');
    expect(rw.evidence.ip_match_note).toBeTruthy();
    expect(await coins(referrer)).toBe(75);
  });

  test('একই device_fingerprint (রেফারার↔রেফার্ড) হলে pending_review; শুধু একই UA-হ্যাশ signature-এ নয়', async () => {
    const a = await pair();
    const fp = 'fp_' + Date.now() + Math.random().toString(36).slice(2);
    await pool.query(`INSERT INTO login_logs (user_id, device_fingerprint) VALUES ($1,$3),($2,$3)`, [a.referrer, a.referred, fp]);
    await depositAndApprove(a.referred, 500);
    expect((await reward(a.referred)).status).toBe('pending_review');
    expect((await reward(a.referred)).review_reason).toContain('device_match');
    expect(await coins(a.referrer)).toBe(0);

    const b = await pair();
    await pool.query(
      `INSERT INTO device_sessions (user_id, sid, device_signature) VALUES ($1,$3,'sig_x'),($2,$4,'sig_x')`,
      [b.referrer, b.referred, 'sid_' + a.referrer, 'sid_' + a.referred]
    );
    await depositAndApprove(b.referred, 500);
    expect((await reward(b.referred)).status).toBe('paid');
  });

  test('নিজেকে রেফার প্রত্যাখ্যাত', async () => {
    const u = await user('self');
    await pool.query(`INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$1)`, [u]);
    const dep = await makeDeposit(u, 1000, { status: 'approved' });
    expect((await engine.processReferralReward(u, dep)).outcome).toBe('rejected');
    expect((await reward(u)).status).toBe('rejected');
    expect(await coins(u)).toBe(0);
  });
});

describe('ত্রুটি ও legacy', () => {
  test('ইঞ্জিন ত্রুটিতে ডিপোজিট অক্ষত, রেকর্ড retry_pending; পরে retry-তে paid', async () => {
    const { referrer, referred } = await pair();
    // ইঞ্জিনের লেজার-লেখায় ইচ্ছাকৃত ব্যর্থতা (শুধু referral_bonus টাইপে)
    await pool.query(`
      CREATE OR REPLACE FUNCTION t_fail_referral_bonus() RETURNS trigger AS $$
      BEGIN IF NEW.type = 'referral_bonus' AND NEW.user_id = ${referrer} THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER t_fail_ref BEFORE INSERT ON coin_transactions FOR EACH ROW EXECUTE FUNCTION t_fail_referral_bonus()`);
    try {
      const dep = await makeDeposit(referred, 500);
      const r = await approve(dep);
      expect(r.success).toBe(true); // ডিপোজিট রোলব্যাক হয়নি
      expect(await coins(referred)).toBe(500);
      expect((await pool.query('SELECT status FROM payment_requests WHERE id=$1', [dep])).rows[0].status).toBe('approved');
      expect(await coins(referrer)).toBe(0);
      const rw = await reward(referred);
      expect(rw.status).toBe('retry_pending');
      expect(Number(rw.qualifying_deposit_id)).toBe(dep);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS t_fail_ref ON coin_transactions');
      await pool.query('DROP FUNCTION IF EXISTS t_fail_referral_bonus()');
    }
    const res = await engine.retryPending();
    expect(res.some(x => x.outcome === 'paid')).toBe(true);
    expect((await reward(referred)).status).toBe('paid');
    expect(await coins(referrer)).toBe(75);
  });

  test('legacy_paid ব্যাকফিল: পুরোনো paid রেফারেল রেকর্ড হয়, ব্যালেন্স/লেজার অপরিবর্তিত, পুনরায় চালালে নিরাপদ', async () => {
    const referrer = await user('rf', { coins: 250 });
    const referred = await user('rd');
    await pool.query(`INSERT INTO referrals (referrer_id, referred_id, first_deposit_done, signup_bonus_paid) VALUES ($1,$2,true,true)`, [referrer, referred]);
    await pool.query(`INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason) VALUES ($1,$2,0,100,'signup')`, [referrer, referred]);
    await pool.query(`INSERT INTO bonuses (user_id, bonus_type, bonus_amount, status) VALUES ($1,'referral',100,'pending_review')`, [referrer]);
    const before = {
      coins: await coins(referrer),
      ledger: await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1`, [referrer]),
      bonuses: await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1`, [referrer])
    };
    await require('../../migrations')();
    await require('../../migrations')();
    const rw = await reward(referred);
    expect(rw.status).toBe('legacy_paid');
    expect(Number(rw.amount)).toBe(100);
    expect(await coins(referrer)).toBe(before.coins);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1`, [referrer])).toBe(before.ledger);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1`, [referrer])).toBe(before.bonuses);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referred_user_id=$1`, [referred])).toBe(1);
    // legacy_paid রেফার্ড নতুন ডিপোজিটে পুনরায় পেআউট ট্রিগার করে না
    await depositAndApprove(referred, 900);
    expect(await coins(referrer)).toBe(before.coins);
    expect((await reward(referred)).status).toBe('legacy_paid');
  });
});

describe('নতুন নিয়ম: ডিপোজিট-অঙ্ক বোনাস ধাপ ও ০.৮% হার-কমিশন', () => {
  test.each([[100, 20, 1], [200, 50, 2], [400, 50, 2], [500, 75, 3]])(
    'প্রথম ডিপোজিট %p → রেফারার বোনাস %p', async (dep, want, tier) => {
      const { referrer, referred } = await pair();
      await depositAndApprove(referred, dep);
      expect(await coins(referrer)).toBe(want);
      const rw = await reward(referred);
      expect(Number(rw.amount)).toBe(want);
      expect(rw.tier).toBe(tier);
    });

  test('ডিপোজিট সম্পূর্ণ হারলে রেফারার ডিপোজিটের ০.৮% পায়; দ্বিতীয়বার সেটেল হলে ডবল নয়', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const before = await coins(referrer);
    // ইউজার সব হেরে ব্যালেন্স শূন্য; শেষ কার্যকলাপ ১ ঘণ্টা আগের
    await pool.query(`UPDATE users SET coins = 0 WHERE id = $1`, [referred]);
    await pool.query(`UPDATE coin_transactions SET created_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [referred]);
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before + 4); // ৫০০ × ০.৮% = ৪
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before + 4);
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND reason='loss_commission'`, [referrer])).toBe(1);
  });

  test('ব্যালেন্স থাকলে বা সাইকেলে উইথড্র থাকলে কমিশন নেই', async () => {
    const a = await pair();
    await depositAndApprove(a.referred, 500);
    const beforeA = await coins(a.referrer);
    await engine.settleLossCycles(); // ইউজারের ব্যালেন্স ≥ ১
    expect(await coins(a.referrer)).toBe(beforeA);

    const b = await pair();
    await depositAndApprove(b.referred, 500);
    const beforeB = await coins(b.referrer);
    await pool.query(`INSERT INTO payment_requests (user_id, type, amount, status, method) VALUES ($1,'withdraw',100,'approved','bkash')`, [b.referred]);
    await pool.query(`UPDATE users SET coins = 0 WHERE id = $1`, [b.referred]);
    await pool.query(`UPDATE coin_transactions SET created_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [b.referred]);
    await engine.settleLossCycles();
    expect(await coins(b.referrer)).toBe(beforeB);
  });
});
