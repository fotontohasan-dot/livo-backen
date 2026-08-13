// services/referral.js
// রেফারেল সিস্টেমের সব লজিক — প্রোগ্রেসিভ বোনাস + মাল্টি-লেভেল কমিশন।
//
// নিয়ম:
//  প্রথম ডিপোজিট বোনাস (রেফারার কতজন সফল রেফার করেছে তার উপর প্রোগ্রেসিভ):
//    ১ম জন        → ১০০
//    ২–৫ জন       → ২০০ (প্রতি জন)
//    ৬–১৫ জন      → ৪০০
//    ১৬–৫০ জন     → ৮০০
//    ৫০+ জন       → ১৫০০
//  শর্ত: রেফার করা ইউজারকে ন্যূনতম ৫০০ টাকা ডিপোজিট করতে হবে।
//
//  মাল্টি-লেভেল কমিশন (আজীবন, বাজির উপর):
//    Tier 1 (সরাসরি)  → ২.৫%
//    Tier 2           → ১.৫%
//    Tier 3           → ০.৮%

const { pool } = require('../db');
const { getSetting } = require('./settings');

const MIN_DEPOSIT_FOR_BONUS = 500;          // বোনাস পেতে রেফারের ন্যূনতম ডিপোজিট
// ডিফল্ট রেট (Tier 1,2,3) — অ্যাডমিন প্যানেল থেকে (/admin/settings) পরিবর্তন করা না থাকলে এই মানই ব্যবহার হয়।
// আসল মান services/settings.js-এর DEFAULTS-এও (referral_commission_tierN_percent) সিঙ্কে রাখা আছে।
const DEFAULT_COMMISSION_RATES = [0.025, 0.015, 0.008]; // Tier 1,2,3

// অ্যাডমিন-কনফিগারড কমিশন রেট (fraction, যেমন 0.025 = 2.5%) — site_settings থেকে,
// ৩০ সেকেন্ড ক্যাশড getSetting() দিয়ে, তাই প্রতি বাজিতে আলাদা DB কল লাগে না।
async function getCommissionRates() {
  const keys = [
    'referral_commission_tier1_percent',
    'referral_commission_tier2_percent',
    'referral_commission_tier3_percent'
  ];
  const rates = [];
  for (let i = 0; i < keys.length; i++) {
    const raw = await getSetting(keys[i]);
    const n = parseFloat(raw);
    rates.push(Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : DEFAULT_COMMISSION_RATES[i]);
  }
  return rates;
}

// সফল রেফার সংখ্যা অনুযায়ী প্রথম-ডিপোজিট বোনাস
function signupBonusFor(successfulCount) {
  // successfulCount = এই রেফারটি ধরে কতজন হলো (১ম, ২য়...)
  if (successfulCount <= 1) return 100;
  if (successfulCount <= 5) return 200;
  if (successfulCount <= 15) return 400;
  if (successfulCount <= 50) return 800;
  return 1500;
}

// ==================== ১. রেফারেল রেকর্ড তৈরি (রেজিস্টারের সময়) ====================
// নতুন ইউজার রেফার কোড দিয়ে রেজিস্টার করলে এটা ডাকা হবে।
async function createReferral(client, referrerId, referredId) {
  // সেল্ফ-রেফারেল প্রতিরোধ
  if (!referrerId || referrerId === referredId) return;
  const db = client || pool;
  try {
    await db.query(
      `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)
       ON CONFLICT (referred_id) DO NOTHING`,
      [referrerId, referredId]
    );
  } catch (e) {
    console.error('createReferral error:', e.message);
  }
}

// ==================== ২. প্রথম ডিপোজিট প্রসেস ====================
// ডিপোজিট approve হওয়ার সময় ডাকা হবে।
// রেফার করা ইউজার প্রথমবার (৫০০+) ডিপোজিট করলে — রেফারারকে প্রোগ্রেসিভ বোনাস।
async function processReferralDeposit(client, referredUserId, depositAmount) {
  try {
    // এই ইউজার কারো রেফার কিনা, আর বোনাস আগে দেওয়া হয়েছে কিনা
    const refRes = await client.query(
      `SELECT * FROM referrals WHERE referred_id = $1`,
      [referredUserId]
    );
    const ref = refRes.rows[0];
    if (!ref) return;                         // কেউ রেফার করেনি
    if (ref.signup_bonus_paid) return;        // আগেই বোনাস দেওয়া হয়েছে
    if (depositAmount < MIN_DEPOSIT_FOR_BONUS) return; // ৫০০-র কম, বোনাস নেই

    // রেফারার এ পর্যন্ত কতজনকে সফল রেফার করেছে (বোনাস পাওয়া) — তার পরের জন এইটি
    const cntRes = await client.query(
      `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND signup_bonus_paid = true`,
      [ref.referrer_id]
    );
    const alreadyPaid = parseInt(cntRes.rows[0].count);
    const thisIsNumber = alreadyPaid + 1;     // এই রেফারটি ধরে কতজন হলো

    const bonus = signupBonusFor(thisIsNumber);

    // রেফারারকে বোনাস কয়েন
    await client.query(
      `UPDATE users SET coins = coins + $1 WHERE id = $2`,
      [bonus, ref.referrer_id]
    );
    // রেফারেল রেকর্ড আপডেট
    await client.query(
      `UPDATE referrals SET first_deposit_done = true, signup_bonus_paid = true WHERE id = $1`,
      [ref.id]
    );
    // কমিশন হিস্ট্রি (অডিট)
    await client.query(
      `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason)
       VALUES ($1, $2, 0, $3, 'signup')`,
      [ref.referrer_id, referredUserId, bonus]
    );
    // কয়েন লেনদেন
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'referral_bonus', 'রেফারেল প্রথম-ডিপোজিট বোনাস')`,
      [ref.referrer_id, bonus]
    );
    // নোটিফিকেশন
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'রেফারেল বোনাস!', $2, 'success')`,
      [ref.referrer_id, `আপনার রেফার করা বন্ধু ডিপোজিট করেছে! আপনি ${bonus} কয়েন বোনাস পেয়েছেন।`]
    );
  } catch (e) {
    console.error('processReferralDeposit error:', e.message);
  }
}
// ==================== ৩. মাল্টি-লেভেল কমিশন বিতরণ ====================
// বাজি ধরার সময় ডাকা হবে (গেম ও স্পোর্টস দুই জায়গায়)।
// বাজি যে ধরল তার উপরে ৩ ধাপ পর্যন্ত রেফারারদের কমিশন দেয়।
// নিজে আলাদা transaction ব্যবহার করে (pool থেকে), যাতে মূল বেট আটকে না যায়।
async function distributeCommission(bettorId, stake) {
  if (!stake || stake <= 0) return;

  const rates = await getCommissionRates();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let currentUserId = bettorId;

    // ৩ লেভেল উপরে যাওয়া
    for (let level = 1; level <= 3; level++) {
      // currentUser কে রেফার করেছে?
      const r = await client.query(
        `SELECT referrer_id FROM referrals WHERE referred_id = $1`,
        [currentUserId]
      );
      const referrerId = r.rows[0] ? r.rows[0].referrer_id : null;
      if (!referrerId) break; // আর উপরে কেউ নেই

      const rate = rates[level - 1];
      const commission = Math.floor(stake * rate);

      if (commission > 0) {
        // কমিশন কয়েন যোগ
        await client.query(
          `UPDATE users SET coins = coins + $1 WHERE id = $2`,
          [commission, referrerId]
        );
        // হিস্ট্রি (অডিট লগ)
        await client.query(
          `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason)
           VALUES ($1, $2, $3, $4, 'commission')`,
          [referrerId, bettorId, level, commission]
        );
        // কয়েন লেনদেন
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description)
           VALUES ($1, $2, 'referral_commission', $3)`,
          [referrerId, commission, `রেফারেল কমিশন (লেভেল ${level})`]
        );
      }

      // পরের লেভেলের জন্য উপরে ওঠা
      currentUserId = referrerId;
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('distributeCommission error:', e.message);
  } finally {
    client.release();
  }
}

// ==================== ৪. রেফারেল পরিসংখ্যান ====================
async function getReferralStats(userId) {
  // মোট রেফার, সফল (বোনাস পাওয়া) রেফার
  const totalRes = await pool.query(
    `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`,
    [userId]
  );
  const successRes = await pool.query(
    `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND signup_bonus_paid = true`,
    [userId]
  );
  // মোট আয় (সব কমিশন + বোনাস)
  const earnRes = await pool.query(
    `SELECT COALESCE(SUM(amount),0) as total FROM referral_commissions WHERE earner_id = $1`,
    [userId]
  );
  // সাম্প্রতিক আয়ের হিস্ট্রি
  const historyRes = await pool.query(
    `SELECT rc.*, u.username AS from_username
       FROM referral_commissions rc
       LEFT JOIN users u ON rc.from_user_id = u.id
      WHERE rc.earner_id = $1
      ORDER BY rc.created_at DESC LIMIT 20`,
    [userId]
  );
  // আমার টিম (যাদের সরাসরি রেফার করেছি)
  const teamRes = await pool.query(
    `SELECT u.username, u.created_at, r.first_deposit_done, r.signup_bonus_paid
       FROM referrals r
       JOIN users u ON r.referred_id = u.id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC LIMIT 50`,
    [userId]
  );

  const successCount = parseInt(successRes.rows[0].count);
  return {
    totalReferrals: parseInt(totalRes.rows[0].count),
    successfulReferrals: successCount,
    totalEarnings: Number(earnRes.rows[0].total),
    nextBonus: signupBonusFor(successCount + 1),
    history: historyRes.rows,
    team: teamRes.rows
  };
}

module.exports = {
  createReferral,
  processReferralDeposit,
  distributeCommission,
  getReferralStats,
  signupBonusFor,
  getCommissionRates,
  DEFAULT_COMMISSION_RATES,
  MIN_DEPOSIT_FOR_BONUS
};
