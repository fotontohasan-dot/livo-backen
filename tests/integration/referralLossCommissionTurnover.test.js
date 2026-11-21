const { pool } = require('../../db');
const engine = require('../../services/referralRewards');
const payment = require('../../routes/payment');
const { makeUser, link, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

// হার-কমিশন (০.৮%) টার্নওভার-লকসহ যায় — আসল Postgres
jest.setTimeout(60000);

const created = [];
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
  `SELECT * FROM deposit_turnovers WHERE user_id=$1 AND source='referral_commission'`, [uid])).rows;
const count = async (sql, p) => Number((await pool.query(sql, p)).rows[0].count);

afterAll(async () => { await cleanup(created); });

describe('লস-কমিশন + টার্নওভার', () => {
  test('হারলে ০.৮% যায় ও ৫x টার্নওভার-লক বসে; দ্বিগুণ settle-এ একবারই', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const before = await coins(referrer);
    await goBroke(referred);
    await engine.settleLossCycles();
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before + 4);
    const l = await locks(referrer);
    expect(l).toHaveLength(1);
    expect(Number(l[0].bonus_amount)).toBe(4);
    expect(Number(l[0].required)).toBe(20); // ৪ × ৫
    expect(l[0].status).toBe('active');
    expect(await count(`SELECT COUNT(*) FROM referral_commissions WHERE earner_id=$1 AND reason='loss_commission' AND cycle_id IS NOT NULL`, [referrer])).toBe(1);
    expect(await count(`SELECT COUNT(*) FROM coin_transactions WHERE user_id=$1 AND type='referral_commission'`, [referrer])).toBe(1);
  });

  test('জিতলে (ব্যালেন্স থাকলে) কমিশন ও লক নেই', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const before = await coins(referrer);
    await pool.query(`UPDATE users SET coins = 900 WHERE id = $1`, [referred]);
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before);
    expect(await locks(referrer)).toHaveLength(0);
  });

  test('উইথড্র হলে কমিশন ০, লক নেই', async () => {
    const { referrer, referred } = await pair();
    await depositAndApprove(referred, 500);
    const before = await coins(referrer);
    await pool.query(`INSERT INTO payment_requests (user_id, type, amount, status, method) VALUES ($1,'withdraw',100,'approved','bkash')`, [referred]);
    await goBroke(referred);
    await engine.settleLossCycles();
    expect(await coins(referrer)).toBe(before);
    expect(await locks(referrer)).toHaveLength(0);
  });

  test('DB UNIQUE: একই cycle_id-তে দ্বিতীয় loss_commission প্রত্যাখ্যাত', async () => {
    const { referrer, referred } = await pair();
    const ins = () => pool.query(
      `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason, cycle_id) VALUES ($1,$2,1,4,'loss_commission',987654321)`,
      [referrer, referred]);
    await ins();
    await expect(ins()).rejects.toMatchObject({ code: '23505' });
  });
});
