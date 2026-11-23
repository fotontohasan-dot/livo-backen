const { pool } = require('../../db');
const engine = require('../../services/referralRewards');
const payment = require('../../routes/payment');
const settings = require('../../services/settings');
const { canWithdraw } = require('../../services/turnover');
const { makeUser, link, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

// ==================== রেফারেল ডিপোজিট-হার (০.৮%) লস-কমিশন — আসল Postgres ====================
// রেফার-করা ইউজার ডিপোজিটের সব টাকা হারালে (ব্যালেন্স <১, pending বাজি নেই, ১০ মিনিট নিষ্ক্রিয়)
// রেফারার সাইকেলের মোট ডিপোজিটের ০.৮% পায় (আজীবন), createBonus দিয়ে ৫x টার্নওভার-লকসহ,
// একই transaction-এ। উইথড্র হলে ০। দ্বিগুণ settle-এ একবারই; DB UNIQUE(cycle_id) ধরে।

jest.setTimeout(120000);

const KEYS = ['referral_loss_commission_percent', 'referral_turnover_sports', 'referral_turnover_casino'];
let saved = [];
const created = [];
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, value]);
}
beforeAll(async () => {
  saved = (await pool.query('SELECT key, value FROM site_settings WHERE key = ANY($1)', [KEYS])).rows;
  await setSetting('referral_loss_commission_percent', '0.8');
  await setSetting('referral_turnover_sports', '5');
  await setSetting('referral_turnover_casino', '5');
  await settings.invalidateSettingsCache();
});
afterAll(async () => {
  await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [KEYS]);
  for (const r of saved) await setSetting(r.key, r.value);
  await settings.invalidateSettingsCache();
  await cleanup(created);
});

async function pair() {
  const referrer = await makeUser('rf'); const referred = await makeUser('rd');
  created.push(referrer, referred);
  await link(referrer, referred);
  return { referrer, referred };
}
async function depositAndApprove(userId, amount) {
  const id = await makeDeposit(userId, amount);
  expect((await payment.approvePaymentRequestById(id)).success).toBe(true);
  return id;
}
async function goBroke(userId) {
  await pool.query(`UPDATE users SET coins = 0 WHERE id = $1`, [userId]);
  await pool.query(`UPDATE coin_transactions SET created_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [userId]);
}
const locks = async (uid) => (await pool.query(
  `SELECT * FROM bonuses WHERE user_id=$1 AND bonus_type='referral_commission'`, [uid])).rows;
const count = async (sql, p) => Number((await pool.query(sql, p)).rows[0].count);

describe('লস-কমিশন ০.৮% + টার্নওভার-লক', () => {
  test('হারলে ০.৮% যায়, ৫x/৫x টার্নওভার-লক বসে, কমিশন-সারি ও coin_transactions সহ; দ্বিগুণ settle-এ একবারই', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const cyc = (await pool.query(`SELECT * FROM referral_deposit_cycles WHERE referred_user_id=$1`, [referred])).rows;
    expect(cyc).toHaveLength(1);
    expect(cyc[0].status).toBe('open');
    expect(Number(cyc[0].deposited)).toBe(500);

    const before = await coins(referrer);
    await goBroke(referred);
    await engine.settleLossCycles();
    await engine.settleLossCycles(); // দ্বিগুণ রান নিরাপদ
    expect(await coins(referrer)).toBe(before + 4); // ৫০০ × ০.৮% = ৪
    const l = await locks(referrer);
    expect(l).toHaveLength(1);
    expect(Number(l[0].bonus_amount)).toBe(4);
    expect(Number(l[0].sports_required)).toBe(20); // ৪ × ৫
    expect(Number(l[0].casino_required)).toBe(20);
    expect(l[0].status).toBe('active');
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND reason='loss_commission' AND cycle_id=$2`, [referrer, cyc[0].id])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1 AND type='referral_commission'`, [referrer])).toBe(1);
    const after = (await pool.query(`SELECT status, commission FROM referral_deposit_cycles WHERE id=$1`, [cyc[0].id])).rows[0];
    expect(after.status).toBe('lost_paid');
    expect(Number(after.commission)).toBe(4);
    // টার্নওভার বাকি থাকায় কমিশনের টাকা উত্তোলন-লকড
    expect((await canWithdraw(referrer)).allowed).toBe(false);
  });

  test('একই সাইকেলে একাধিক ডিপোজিট যোগ হয়; মোট ডিপোজিটের ০.৮%', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    await depositAndApprove(referred, 750);
    expect(await count(`SELECT COUNT(*) FROM referral_deposit_cycles WHERE referred_user_id=$1`, [referred])).toBe(1);
    const before = await coins(referrer);
    await goBroke(referred);
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before + 10); // ১২৫০ × ০.৮% = ১০
    expect(Number((await locks(referrer))[0].sports_required)).toBe(50);
  });

  test('জিতলে (ব্যালেন্স থাকলে) কমিশন ও লক নেই', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const before = await coins(referrer);
    await pool.query(`UPDATE users SET coins = 900 WHERE id = $1`, [referred]);
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before);
    expect(await locks(referrer)).toHaveLength(0);
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND reason='loss_commission'`, [referrer])).toBe(0);
    expect((await pool.query(`SELECT status FROM referral_deposit_cycles WHERE referred_user_id=$1`, [referred])).rows[0].status).toBe('open');
  });

  test('১০ মিনিটের মধ্যে কার্যকলাপ থাকলে এখনই settle হয় না', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const before = await coins(referrer);
    await pool.query(`UPDATE users SET coins = 0 WHERE id = $1`, [referred]); // কার্যকলাপ সদ্য
    const r = await engine.settleLossCycles();
    expect(r.tally.not_settled_yet).toBeGreaterThanOrEqual(1);
    expect(await coins(referrer)).toBe(before);
  });

  test('উইথড্র হলে কমিশন ০, লক নেই', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const before = await coins(referrer);
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, amount, status, method, transaction_id) VALUES ($1,'withdraw',100,'approved','bkash',$2)`,
      [referred, `WD${Date.now()}${referred}`]);
    await goBroke(referred);
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before);
    expect(await locks(referrer)).toHaveLength(0);
    expect((await pool.query(`SELECT status FROM referral_deposit_cycles WHERE referred_user_id=$1`, [referred])).rows[0].status).toBe('closed_withdrawn');
  });

  test('DB UNIQUE: একই cycle_id-তে দ্বিতীয় loss_commission প্রত্যাখ্যাত', async () => {
    const { referrer, referred } = await pair();
    const ins = () => pool.query(
      `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason, cycle_id) VALUES ($1,$2,1,4,'loss_commission',987654321)`,
      [referrer, referred]);
    await ins();
    await expect(ins()).rejects.toMatchObject({ code: '23505' });
    await pool.query(`DELETE FROM referral_commissions WHERE cycle_id = 987654321`);
  });

  test('createBonus-এর মতো একই transaction: কমিশন-সারি ব্যর্থ হলে ব্যালেন্স/লকও রোলব্যাক', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const cyc = (await pool.query(`SELECT id FROM referral_deposit_cycles WHERE referred_user_id=$1`, [referred])).rows[0];
    // একই cycle_id-তে আগে থেকেই একটা loss_commission বসিয়ে UNIQUE ভাঙার চেষ্টা
    await pool.query(
      `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason, cycle_id) VALUES ($1,$2,1,1,'loss_commission',$3)`,
      [referrer, referred, cyc.id]);
    const before = await coins(referrer);
    await goBroke(referred);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await engine.settleOneCycle(cyc.id, 0.8);
    err.mockRestore();
    expect(out.outcome).toBe('error');
    expect(await coins(referrer)).toBe(before);
    expect(await locks(referrer)).toHaveLength(0);
    expect((await pool.query(`SELECT status FROM referral_deposit_cycles WHERE id=$1`, [cyc.id])).rows[0].status).toBe('open');
  });
});
