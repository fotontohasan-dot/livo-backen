// ==================== First Deposit Bonus: একই ইউজারের দুটি pending ডিপোজিট একসাথে অনুমোদন (আসল Postgres) ====================
// প্রত্যাশিত আচরণ: প্রতিটি ট্রায়ালে ঠিক একটি ডিপোজিট ১০০% পাবে, অন্যটি ৫০% (শুক্রবারে ৮০%) — দুটোই ১০০% কখনো নয়।
// সঙ্গে: ফ্রি বেট (user_id, reason)-প্রতি একবারই — সমান্তরাল দুই grantFreeBet-এ একটিই সারি।
// এই ফাইল ওয়ালেট/ডিপোজিট কোড বদলায় না — শুধু আচরণ পরিমাপ করে; কোনো শর্ত শিথিল করা হয়নি।
const { pool } = require('../../db');
const { approvePaymentRequestById } = require('../../routes/payment');
const { grantFreeBet } = require('../../services/freebet');
const { makeUser, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

const AMOUNT = 1000;
const TRIALS = 12;
const IS_FRIDAY = new Date().getDay() === 5;
const SECOND_PCT = IS_FRIDAY ? 80 : 50;

async function bonusRows(userId) {
  const r = await pool.query(
    `SELECT amount FROM coin_transactions WHERE user_id = $1 AND type = 'deposit_bonus' ORDER BY amount DESC`, [userId]);
  return r.rows.map((x) => Number(x.amount));
}

describe('First Deposit Bonus — একই ইউজারের দুটি সমান্তরাল অনুমোদন', () => {
  jest.setTimeout(180000);
  const users = [];
  afterAll(async () => { await cleanup(users); });

  test(`${TRIALS}টি ট্রায়ালের প্রতিটিতে একটা ১০০%, অন্যটা ${SECOND_PCT}%; দুটো ১০০% কখনো নয়`, async () => {
    const bad = [];
    const detail = [];
    for (let i = 0; i < TRIALS; i++) {
      const uid = await makeUser('fdb');
      users.push(uid);
      const d1 = await makeDeposit(uid, AMOUNT, { status: 'pending', wantBonus: true });
      const d2 = await makeDeposit(uid, AMOUNT, { status: 'pending', wantBonus: true });
      const [r1, r2] = await Promise.all([approvePaymentRequestById(d1), approvePaymentRequestById(d2)]);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      const bonuses = await bonusRows(uid);
      detail.push({ trial: i + 1, bonuses, balance: await coins(uid) });
      const ok = bonuses.length === 2 && bonuses[0] === AMOUNT && bonuses[1] === AMOUNT * SECOND_PCT / 100;
      if (!ok) bad.push(i + 1);
    }
    // eslint-disable-next-line no-console
    console.log('FDB_CONCURRENT_RESULT ' + JSON.stringify({ trials: TRIALS, badTrials: bad, detail }));
    expect(bad).toEqual([]);
  });

  test('ফ্রি বেট একই কারণে সমান্তরালে দুইবার দিলেও ঠিক একটি সারি', async () => {
    for (let i = 0; i < TRIALS; i++) {
      const uid = await makeUser('fdbfb');
      users.push(uid);
      await Promise.all([grantFreeBet(uid, 100, 'first_deposit'), grantFreeBet(uid, 100, 'first_deposit')]);
      const r = await pool.query(`SELECT COUNT(*)::int AS c FROM free_bets WHERE user_id = $1 AND reason = 'first_deposit'`, [uid]);
      expect(r.rows[0].c).toBe(1);
    }
  });
});
