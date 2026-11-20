// ==================== First Deposit Bonus: একই ইউজারের দুটি pending ডিপোজিট একসাথে অনুমোদন (আসল Postgres) ====================
// প্রত্যাশিত আচরণ: ১০০% "প্রথম ডিপোজিট" বোনাস ইউজার-প্রতি ঠিক একবার। একই ইউজারের দুটি pending ডিপোজিট
// (want_bonus=true) সমান্তরালে অনুমোদন করলে একটি ১০০% পাবে, অন্যটি ৫০% (শুক্রবারে ৮০%) — দুটোই ১০০% নয়।
//
// পদ্ধতি: routes/payment.js-এর আসল approvePaymentRequestById (অ্যাডমিন একক/বাল্ক/গেটওয়ে — সব পথের মূল) দুটো
// আলাদা DB-কানেকশনে একসাথে চালানো; interleaving ধরা পড়ার জন্য একাধিক ট্রায়াল (প্রতিটিতে নতুন ইউজার)।
// এই ফাইল ওয়ালেট/ডিপোজিট কোড বদলায় না — শুধু আচরণ পরিমাপ করে।
const { pool } = require('../../db');
const { approvePaymentRequestById } = require('../../routes/payment');
const { makeUser, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

const AMOUNT = 1000;
const TRIALS = 12;

async function bonusRows(userId) {
  const r = await pool.query(
    `SELECT amount FROM coin_transactions WHERE user_id = $1 AND type = 'deposit_bonus' ORDER BY id`, [userId]);
  return r.rows.map((x) => Number(x.amount));
}

describe('First Deposit Bonus — একই ইউজারের দুটি সমান্তরাল অনুমোদন', () => {
  jest.setTimeout(120000);
  const users = [];
  afterAll(async () => { await cleanup(users); });

  test(`${TRIALS}টি ট্রায়ালের প্রতিটিতে ১০০% বোনাস (${AMOUNT}) সর্বোচ্চ একবার`, async () => {
    const doubled = [];
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
      const full = bonuses.filter((b) => b === AMOUNT).length; // ১০০% = ১০০০
      detail.push({ trial: i + 1, bonuses, balance: await coins(uid) });
      if (full > 1) doubled.push(i + 1);
    }
    // প্রমাণের জন্য প্রতিটি ট্রায়ালের ফল লগে থাকে
    // eslint-disable-next-line no-console
    console.log('FDB_CONCURRENT_RESULT ' + JSON.stringify({ trials: TRIALS, doubledTrials: doubled, detail }));
    expect(doubled).toEqual([]);
  });
});
