const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const engine = require('../../services/referralRewards');
const payment = require('../../routes/payment');
const settings = require('../../services/settings');
const { canWithdraw, addTurnover } = require('../../services/turnover');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { makeUser, link, makeDeposit, coins, reward, cleanup } = require('../helpers/referralDeposit');

// ==================== রেফারেল ধাপ-ভিত্তিক (slab) বোনাস — আসল Postgres + Redis ====================
// নিয়ম: রেফার-করা Y-এর প্রথম যোগ্য ডিপোজিট (approved, ≥ ৫০০) → রেফারার X ধাপ-অনুযায়ী বোনাস, ঠিক একবার।
// ৫০০–৯৯৯=৭৫; ১,০০০–১,৯৯৯=১০০; ২,০০০–৪,৯৯৯=২০০; ৫,০০০–৯,৯৯৯=৩০০; ১০,০০০–২৯,৯৯৯=৫০০; ৩০,০০০+=১,০০০।

jest.setTimeout(120000);

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
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, value]);
  await settings.invalidateSettingsCache();
  await settings.loadSettings();
}
async function getRaw(key) {
  const r = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

afterAll(async () => { await cleanup(created); });

describe('slabFor / parseSlabs (ইউনিট)', () => {
  const exp = [
    [499, null], [500, 75], [999, 75], [1000, 100], [1999, 100], [2000, 200], [4999, 200],
    [5000, 300], [9999, 300], [10000, 500], [29999, 500], [30000, 1000], [50000, 1000]
  ];
  test.each(exp)('%i → %p', (dep, amt) => {
    const hit = engine.slabFor(dep);
    if (amt === null) expect(hit).toBeNull(); else expect(hit.amount).toBe(amt);
  });
  test('ক্যাপ বোনাস সীমিত করে', () => {
    expect(engine.slabFor(50000, engine.DEFAULT_SLABS, 800).amount).toBe(800);
    expect(engine.slabFor(30000, engine.DEFAULT_SLABS, 1000).amount).toBe(1000);
  });
  test('অবৈধ slab কনফিগ প্রত্যাখ্যাত', () => {
    expect(engine.parseSlabs('not json')).toBeNull();
    expect(engine.parseSlabs('[]')).toBeNull();
    expect(engine.parseSlabs('[{"min":1000,"amount":10},{"min":500,"amount":5}]')).toBeNull(); // min ক্রমবর্ধমান নয়
    expect(engine.parseSlabs('[{"min":500,"amount":-1}]')).toBeNull();
    expect(engine.parseSlabs('[{"min":0,"amount":5}]')).toBeNull();
    expect(engine.parseSlabs('[{"min":500,"amount":75}]')).toEqual([{ min: 500, amount: 75 }]);
  });
});

describe('প্রতি ধাপের সীমা-মান (আসল approve পথ)', () => {
  const below = [499];
  test.each(below)('%i → বোনাস নেই, রেকর্ড নেই', async (amount) => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, amount);
    expect(await coins(referrer)).toBe(0);
    expect(await reward(referred)).toBeNull();
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1`, [referrer])).toBe(0);
  });

  const paid = [[500, 75, 1], [999, 75, 1], [1000, 100, 2], [4999, 200, 3], [5000, 300, 4],
    [9999, 300, 4], [10000, 500, 5], [29999, 500, 5], [30000, 1000, 6], [50000, 1000, 6]];
  test.each(paid)('%i → %i টাকা (ধাপ %i), ৫x/৫x টার্নওভার, আলাদা bonuses সারি', async (amount, bonus, slab) => {
    const { referrer, referred } = await pair();
    const dep = await depositAndApprove(referred, amount);
    expect(await coins(referrer)).toBe(bonus);
    const rw = await reward(referred);
    expect(rw.status).toBe('paid');
    expect(Number(rw.amount)).toBe(bonus);
    expect(rw.tier).toBe(slab);
    expect(Number(rw.qualifying_deposit_id)).toBe(dep);
    const b = (await pool.query(`SELECT * FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referrer])).rows;
    expect(b).toHaveLength(1);
    expect(Number(b[0].bonus_amount)).toBe(bonus);
    expect(Number(b[0].sports_required)).toBe(bonus * 5);
    expect(Number(b[0].casino_required)).toBe(bonus * 5);
    expect(b[0].status).toBe('active');
    // রেফারার-পাশে ডিপোজিট বোনাস সারি তৈরি হয়নি (ওয়েজারিং আলাদা)
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1 AND bonus_type<>'referral'`, [referrer])).toBe(0);
  });
});

describe('ঠিক একবার', () => {
  test('৫০০-র নিচে → পরে ≥৫০০ ডিপোজিটে ট্রিগার; তারপর আর কোনো ডিপোজিটে নয়', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 499);
    expect(await reward(referred)).toBeNull();
    await depositAndApprove(referred, 1200);
    expect(await coins(referrer)).toBe(100);
    await depositAndApprove(referred, 30000);
    await depositAndApprove(referred, 600);
    expect(await coins(referrer)).toBe(100);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referred_user_id=$1`, [referred])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referrer])).toBe(1);
  });

  test('একই Y-এর একাধিক সমান্তরাল ডিপোজিট অনুমোদন → একটাই পেআউট', async () => {
    const { referrer, referred } = await pair();
    const deps = [];
    for (const a of [500, 1000, 2000, 5000]) deps.push(await makeDeposit(referred, a));
    const res = await Promise.all(deps.map(approve));
    expect(res.every(r => r.success)).toBe(true);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referred_user_id=$1 AND status='paid'`, [referred])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1 AND type='referral_bonus'`, [referrer])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referrer])).toBe(1);
    const rw = await reward(referred);
    expect(await coins(referrer)).toBe(Number(rw.amount));
  });

  test('duplicate callback (একই ডিপোজিটে ইঞ্জিন একাধিকবার) + অ্যাডমিন অনুমোদন → দ্বিগুণ নয়', async () => {
    const { referrer, referred } = await pair();
    const dep = await makeDeposit(referred, 2500);
    const results = await Promise.all([approve(dep), approve(dep), approve(dep)]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    await Promise.all([1, 2, 3, 4].map(() => engine.processReferralReward(referred, dep)));
    expect(await coins(referrer)).toBe(200);
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND reason='first_deposit'`, [referrer])).toBe(1);
  });

  test('ভিন্ন Y-দের সমান্তরাল ডিপোজিট (একই X) → প্রত্যেকে নিজের ধাপ, সব ঠিক একবার', async () => {
    const referrer = await user('rf');
    const amounts = [500, 1000, 2000, 5000, 10000];
    const deps = [];
    for (const a of amounts) {
      const referred = await user('rd');
      await link(referrer, referred);
      deps.push(await makeDeposit(referred, a));
    }
    await Promise.all(deps.map(approve));
    const rows = (await pool.query(
      `SELECT amount FROM referral_rewards WHERE referrer_id=$1 AND status='paid' ORDER BY amount`, [referrer])).rows;
    expect(rows.map(r => Number(r.amount))).toEqual([75, 100, 200, 300, 500]);
    expect(await coins(referrer)).toBe(1175);
  });
});

describe('Y শুধু First Deposit Bonus পায়', () => {
  test('Y-এর কোনো রেফারেল বোনাস/bonuses সারি/রিওয়ার্ড নেই; সাইন-আপে কিছু নয়', async () => {
    const { referrer, referred } = await pair();
    expect(await coins(referrer)).toBe(0);
    expect(await coins(referred)).toBe(0);
    await depositAndApprove(referred, 1000, { wantBonus: true });
    expect(await coins(referred)).toBe(2000); // ১০০০ + বিদ্যমান ১ম-ডিপোজিট বোনাস ১০০০ (অপরিবর্তিত)
    const types = (await pool.query(`SELECT type FROM coin_transactions WHERE user_id=$1 ORDER BY id`, [referred])).rows.map(r => r.type);
    expect(types).toEqual(['deposit', 'deposit_bonus']);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referred])).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referrer_id=$1`, [referred])).toBe(0);
    expect(await coins(referrer)).toBe(100);
  });
});

describe('টার্নওভার বাকি থাকতে উত্তোলন লক', () => {
  test('active রেফারেল বোনাসে canWithdraw=false; ৫x স্পোর্টস + ৫x ক্যাসিনো পূর্ণ হলে খোলে', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500); // বোনাস ৭৫ → ৩৭৫ + ৩৭৫
    let c = await canWithdraw(referrer);
    expect(c.allowed).toBe(false);
    const p = c.pending.find(x => x.type === 'referral');
    expect(p.sportsLeft).toBe(375);
    expect(p.casinoLeft).toBe(375);

    await addTurnover(referrer, 'sports', 375);
    c = await canWithdraw(referrer);
    expect(c.allowed).toBe(false); // ক্যাসিনো বাকি
    expect(c.pending.find(x => x.type === 'referral').casinoLeft).toBe(375);

    await addTurnover(referrer, 'casino', 375);
    c = await canWithdraw(referrer);
    expect(c.allowed).toBe(true);
  });

  test('কনফিগযোগ্য টার্নওভার: স্পোর্টস ৩x / ক্যাসিনো ০x সেট করলে নতুন বোনাসে সেটাই', async () => {
    const prevS = await getRaw('referral_turnover_sports');
    const prevC = await getRaw('referral_turnover_casino');
    try {
      await setSetting('referral_turnover_sports', '3');
      await setSetting('referral_turnover_casino', '0');
      const { referrer, referred } = await pair();
      await depositAndApprove(referred, 1000);
      const b = (await pool.query(`SELECT * FROM bonuses WHERE user_id=$1 AND bonus_type='referral'`, [referrer])).rows[0];
      expect(Number(b.sports_required)).toBe(300);
      expect(Number(b.casino_required)).toBe(0);
    } finally {
      await setSetting('referral_turnover_sports', prevS === null ? '5' : prevS);
      await setSetting('referral_turnover_casino', prevC === null ? '5' : prevC);
    }
  });
});

describe('ক্যাপ ও মোড', () => {
  test('ক্যাপ কমালে বোনাস ক্যাপে আটকায়', async () => {
    const prev = await getRaw('referral_bonus_cap');
    try {
      await setSetting('referral_bonus_cap', '150');
      const { referrer, referred } = await pair();
      await depositAndApprove(referred, 30000);
      expect(await coins(referrer)).toBe(150);
      expect(Number((await reward(referred)).amount)).toBe(150);
    } finally {
      await setSetting('referral_bonus_cap', prev === null ? '1000' : prev);
    }
  });

  test('REFERRAL_BONUS_MODE=tier পুরোনো ক্রমিক টিয়ার চালায় (১ম=১০০), সাধারণ অবস্থায় slab', async () => {
    process.env.REFERRAL_BONUS_MODE = 'tier';
    try {
      const { referrer, referred } = await pair();
      await depositAndApprove(referred, 500);
      expect(await coins(referrer)).toBe(100);
      expect((await reward(referred)).evidence.mode).toBe('tier');
    } finally {
      delete process.env.REFERRAL_BONUS_MODE;
    }
    const { referrer: r2, referred: d2 } = await pair();
    await depositAndApprove(d2, 500);
    expect(await coins(r2)).toBe(75);
    expect((await reward(d2)).evidence.mode).toBe('slab');
  });
});

describe('ফ্রড-গেট (slab মোডেও)', () => {
  test('ফোন মিললে pending_review — কয়েন/bonuses/লেজার কিছুই নয়', async () => {
    const referrer = await user('rf');
    const digits = '1' + String(Math.floor(100000000 + Math.random() * 899999999)).slice(0, 9);
    await user('ot', { phone: '0' + digits });
    const referred = await user('rd', { phone: '+880' + digits });
    await link(referrer, referred);
    await depositAndApprove(referred, 5000);
    const rw = await reward(referred);
    expect(rw.status).toBe('pending_review');
    expect(await coins(referrer)).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM bonuses WHERE user_id=$1`, [referrer])).toBe(0);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1`, [referrer])).toBe(0);
  });

  test('শুধু একই IP → paid (slab অনুযায়ী), evidence-এ নোট', async () => {
    const { referrer, referred } = await pair();
    await pool.query(`INSERT INTO login_logs (user_id, ip) VALUES ($1,'203.0.113.99'),($2,'203.0.113.99')`, [referrer, referred]);
    await depositAndApprove(referred, 2000);
    const rw = await reward(referred);
    expect(rw.status).toBe('paid');
    expect(rw.evidence.ip_match_note).toBeTruthy();
    expect(await coins(referrer)).toBe(200);
  });
});

describe('ইঞ্জিন ত্রুটিতে ডিপোজিট অক্ষত (slab)', () => {
  test('লেজার-লেখা ব্যর্থ → ডিপোজিট approved, রেকর্ড retry_pending; retry-তে slab-বোনাস paid', async () => {
    const { referrer, referred } = await pair();
    await pool.query(`
      CREATE OR REPLACE FUNCTION t_fail_slab_bonus() RETURNS trigger AS $$
      BEGIN IF NEW.type = 'referral_bonus' AND NEW.user_id = ${referrer} THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER t_fail_slab BEFORE INSERT ON coin_transactions FOR EACH ROW EXECUTE FUNCTION t_fail_slab_bonus()`);
    try {
      const dep = await makeDeposit(referred, 5000);
      const r = await approve(dep);
      expect(r.success).toBe(true);
      expect(await coins(referred)).toBe(5000);
      expect((await pool.query('SELECT status FROM payment_requests WHERE id=$1', [dep])).rows[0].status).toBe('approved');
      expect(await coins(referrer)).toBe(0);
      expect((await reward(referred)).status).toBe('retry_pending');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS t_fail_slab ON coin_transactions');
      await pool.query('DROP FUNCTION IF EXISTS t_fail_slab_bonus()');
    }
    const res = await engine.retryPending();
    expect(res.some(x => x.outcome === 'paid')).toBe(true);
    expect((await reward(referred)).status).toBe('paid');
    expect(await coins(referrer)).toBe(300); // ৫,০০০ → ৩০০, ডিপোজিটের পরিমাণ ধরে রাখা
  });
});

describe('bonus_held → V2 মাইগ্রেশন (ব্যালেন্স বদল নয়, মোছা নয়)', () => {
  test('bonus_held রেকর্ড pending_review হয়; legacy_paid আলাদা থাকে; কলাম ও ব্যালেন্স অক্ষত; পুনরায় চালালে নিরাপদ', async () => {
    const referrer = await user('rf', { coins: 300 });
    const heldUser = await user('hd');
    const paidUser = await user('pd');
    await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id, first_deposit_done, signup_bonus_paid, bonus_held, hold_reason, bonus_amount)
       VALUES ($1,$2,true,true,true,'same_phone',100), ($1,$3,true,true,false,NULL,100)`, [referrer, heldUser, paidUser]);
    await pool.query(`INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason) VALUES ($1,$2,0,100,'signup')`, [referrer, paidUser]);
    // আগের ভুল ব্যাকফিলে হোল্ড-রেকর্ড legacy_paid হয়ে থাকার ক্ষেত্র — সংশোধন হবে
    await pool.query(
      `INSERT INTO referral_rewards (referred_user_id, referrer_id, status, amount, review_reason)
       VALUES ($1,$2,'legacy_paid',0,'legacy signup-bonus referral (V2 backfill)')`, [heldUser, referrer]);
    const before = {
      coins: await coins(referrer),
      ledger: await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1`, [referrer]),
      refs: await count(`SELECT COUNT(*) FROM referrals WHERE referrer_id=$1`, [referrer])
    };

    await require('../../migrations')();
    await require('../../migrations')();

    const h = await reward(heldUser);
    expect(h.status).toBe('pending_review');
    expect(h.review_reason).toBe('same_phone');
    expect(Number(h.amount)).toBe(100);
    expect((await reward(paidUser)).status).toBe('legacy_paid');
    expect(await coins(referrer)).toBe(before.coins);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1`, [referrer])).toBe(before.ledger);
    expect(await count(`SELECT COUNT(*) FROM referrals WHERE referrer_id=$1`, [referrer])).toBe(before.refs);
    // পুরোনো কলাম মোছা/বদলানো হয়নি
    const row = (await pool.query(`SELECT bonus_held, hold_reason, signup_bonus_paid FROM referrals WHERE referred_id=$1`, [heldUser])).rows[0];
    expect(row).toEqual({ bonus_held: true, hold_reason: 'same_phone', signup_bonus_paid: true });
    expect(await count(`SELECT COUNT(*) FROM referral_rewards WHERE referred_user_id = ANY($1::int[])`, [[heldUser, paidUser]])).toBe(2);
  });
});

describe('দ্বিগুণ-বোনাস পথ নেই (কোড-প্রমাণ)', () => {
  const root = path.join(__dirname, '..', '..');
  function listJs(dir) {
    const out = [];
    for (const f of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) out.push(...listJs(p)); else if (f.name.endsWith('.js')) out.push(p);
    }
    return out;
  }
  const files = ['routes', 'services', 'middleware', 'utils', 'queues'].filter(d => fs.existsSync(path.join(root, d)))
    .flatMap(listJs).concat(['app.js', 'server.js', 'worker.js']);

  test("কোথাও signup_bonus_paid/bonus_held লেখা হয় না (কলাম অব্যবহৃত)", () => {
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      if (/signup_bonus_paid\s*=\s*(true|\$)|bonus_held\s*=\s*(true|\$)|SET[^;`]*signup_bonus_paid|SET[^;`]*bonus_held/i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("পুরোনো payout ফাংশন নেই; 'referral_bonus' লেজার শুধু V2 ইঞ্জিন লেখে", () => {
    const legacy = require('../../services/referral');
    expect(legacy.processReferralDeposit).toBeUndefined();
    const writers = files.filter(f => /INSERT INTO coin_transactions[^;]*'referral_bonus'/.test(fs.readFileSync(path.join(root, f), 'utf8')));
    expect(writers).toEqual([path.join('services', 'referralRewards.js')]);
  });

  test('সব ডিপোজিট-নিশ্চিতকরণ পথ একই V2 afterDepositCommit ডাকে (আর কিছু নয়)', () => {
    const codeOnly = (f) => fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const callers = files.filter(f => /afterDepositCommit/.test(codeOnly(f))).sort();
    expect(callers).toEqual(['routes/admin.js', 'routes/payment.js', 'services/gatewayReconcile.js',
      'services/referralRewards.js', 'services/walletCallback.js'].sort());
  });
});

describe('অ্যাডমিন কনফিগ (/admin/settings/update)', () => {
  async function adminAgent() {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
    created.push(row.id);
    await pool.query("UPDATE users SET role='admin' WHERE id=$1", [row.id]);
    return { agent, token };
  }

  test('বৈধ মান সেভ হয়, অবৈধ মান বাদ যায় (আগের মান থাকে)', async () => {
    const keys = ['referral_slabs', 'referral_bonus_cap', 'referral_min_deposit', 'referral_turnover_sports', 'referral_turnover_casino'];
    const prev = {};
    for (const k of keys) prev[k] = await getRaw(k);
    try {
      const { agent, token } = await adminAgent();
      const good = '[{"min":600,"amount":50},{"min":2000,"amount":150}]';
      let res = await agent.post('/admin/settings/update').type('form').send({
        _csrf: token, referral_slabs: good, referral_bonus_cap: '900', referral_min_deposit: '600',
        referral_turnover_sports: '4', referral_turnover_casino: '6'
      });
      expect([200, 302]).toContain(res.status);
      expect(JSON.parse(await getRaw('referral_slabs'))).toEqual([{ min: 600, amount: 50 }, { min: 2000, amount: 150 }]);
      expect(await getRaw('referral_bonus_cap')).toBe('900');
      expect(await getRaw('referral_min_deposit')).toBe('600');
      expect(await getRaw('referral_turnover_sports')).toBe('4');
      expect(await getRaw('referral_turnover_casino')).toBe('6');

      res = await agent.post('/admin/settings/update').type('form').send({
        _csrf: token, referral_slabs: '[{"min":900,"amount":1},{"min":100,"amount":2}]', referral_bonus_cap: '-5',
        referral_min_deposit: 'abc', referral_turnover_sports: '', referral_turnover_casino: '-1'
      });
      expect([200, 302]).toContain(res.status);
      expect(JSON.parse(await getRaw('referral_slabs'))).toEqual([{ min: 600, amount: 50 }, { min: 2000, amount: 150 }]);
      expect(await getRaw('referral_bonus_cap')).toBe('900');
      expect(await getRaw('referral_min_deposit')).toBe('600');
      expect(await getRaw('referral_turnover_sports')).toBe('4');
      expect(await getRaw('referral_turnover_casino')).toBe('6');
    } finally {
      for (const k of keys) await setSetting(k, prev[k] === null ? '' : prev[k]);
      if (prev.referral_slabs === null) await pool.query("DELETE FROM site_settings WHERE key='referral_slabs'");
      await settings.invalidateSettingsCache();
    }
  });
});

describe('ইউজার রেফারেল পাতা (বাংলা/ইংরেজি কপি)', () => {
  test('ধাপ-ছক, টার্নওভার ও "বন্ধু প্রথম ডিপোজিট করলে বোনাস" দেখায়; ভুল কপি (৩০০০) নেই', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    created.push((await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0].id);

    const bn = await agent.get('/profile/referral');
    expect(bn.status).toBe(200);
    expect(bn.text).toContain('প্রথম ডিপোজিট');
    expect(bn.text).toContain('৭৫');          // ৫০০–৯৯৯ ধাপ
    expect(bn.text).toContain('১,০০০');       // ক্যাপ/শেষ ধাপ
    expect(bn.text).toMatch(/স্পোর্টস ৫x/);
    expect(bn.text).toMatch(/ক্যাসিনো ৫x/);
    expect(bn.text).toContain('আপনার রেফার করা বন্ধু প্রথম ডিপোজিট করলে আপনি বোনাস পাবেন');
    expect(bn.text).not.toContain('৩০০০');

    await agent.get('/lang/en'); // সেশনে ভাষা = en
    const en = await agent.get('/profile/referral');
    expect(en.status).toBe(200);
    expect(en.text).toContain('friend&#39;s first deposit'); // EJS apostrophe escape
    expect(en.text).toContain('First deposit 500 – 999');
    expect(en.text).toContain('First deposit 30,000+');
    expect(en.text).toContain('sports 5x');
    expect(en.text).toContain('casino 5x');
    expect(en.text).toContain('You will get a bonus when your referred friend makes their first deposit');
    expect(en.text).not.toContain('3000 bonus');
  });
});
