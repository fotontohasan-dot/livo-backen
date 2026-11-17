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
const { tierFor, getTiers, DEFAULT_TIERS, DEFAULT_MIN_DEPOSIT } = require('./referralRewards');

const MIN_DEPOSIT_FOR_BONUS = DEFAULT_MIN_DEPOSIT; // ডিফল্ট; আসল মান settings.referral_min_deposit (referralRewards.getMinDeposit)
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

// ডিফল্ট টিয়ার অনুযায়ী বোনাস (কনফিগযোগ্য মান: referralRewards.getTiers())
function signupBonusFor(successfulCount) {
  return tierFor(successfulCount, DEFAULT_TIERS).amount;
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

// ==================== ২. প্রথম ডিপোজিট বোনাস (V2) ====================
// রেফারার বোনাস এখন services/referralRewards.js-এর ইঞ্জিন দেয় — ডিপোজিট COMMIT-এর পরে আলাদা
// ট্রানজ্যাকশনে (routes/payment.js creditApprovedDeposit-এর কলাররা afterDepositCommit ডাকে)।
// আগের processReferralDeposit (ডিপোজিট ট্রানজ্যাকশনের ভেতরে, signup_bonus_paid ফ্ল্যাগ, খালি-তথ্যের
// duplicate গেট) সরানো হয়েছে।

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
  // সফল = V2 রেফারেল 'paid' (legacy_paid আলাদা — টিয়ারে গোনা হয় না)
  const successRes = await pool.query(
    `SELECT COUNT(*) FROM referral_rewards WHERE referrer_id = $1 AND status = 'paid'`,
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
    `SELECT u.username, u.created_at, r.first_deposit_done,
            COALESCE(rr.status IN ('paid','legacy_paid'), false) AS signup_bonus_paid,
            rr.status AS reward_status
       FROM referrals r
       JOIN users u ON r.referred_id = u.id
       LEFT JOIN referral_rewards rr ON rr.referred_user_id = r.referred_id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC LIMIT 50`,
    [userId]
  );

  const successCount = parseInt(successRes.rows[0].count);
  return {
    totalReferrals: parseInt(totalRes.rows[0].count),
    successfulReferrals: successCount,
    totalEarnings: Number(earnRes.rows[0].total),
    nextBonus: tierFor(successCount + 1, await getTiers()).amount,
    history: historyRes.rows,
    team: teamRes.rows
  };
}

module.exports = {
  createReferral,
  distributeCommission,
  getReferralStats,
  signupBonusFor,
  getCommissionRates,
  DEFAULT_COMMISSION_RATES,
  MIN_DEPOSIT_FOR_BONUS
};
