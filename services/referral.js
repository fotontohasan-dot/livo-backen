// services/referral.js
// রেফারেল: রেকর্ড তৈরি, মাল্টি-লেভেল কমিশন, ইউজারের পরিসংখ্যান।
//
// রেফারেল বোনাস (রেফারারকে) এখন শুধু V2 ইঞ্জিনে — services/referralRewards.js:
//   রেফার-করা ইউজারের প্রথম যোগ্য ডিপোজিটে (approved, ≥ ন্যূনতম) ডিপোজিট-অঙ্ক-ভিত্তিক ধাপে বোনাস, ঠিক একবার।
//   সাইন-আপে কোনো বোনাস নেই; রেফার-করা ইউজার কোনো রেফারেল বোনাস পায় না।
//   পুরোনো signup-বোনাস / bonus_held হোল্ড-মডেল বন্ধ (কলাম DB-তে থাকে, ব্যবহার নেই)।
//
//  মাল্টি-লেভেল কমিশন (আজীবন, বাজির উপর):
//    Tier 1 (সরাসরি)  → ২.৫%
//    Tier 2           → ১.৫%
//    Tier 3           → ০.৮%

const { pool } = require('../db');
const { getSetting } = require('./settings');
const { createBonus } = require('./turnover');
const { evaluateDuplicateAccount } = require('./duplicateDetection');
const { tierFor, getTiers, getBands, getLossCommissionPercent, DEFAULT_TIERS, DEFAULT_MIN_DEPOSIT } = require('./referralRewards');

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

// ==================== ২. প্রথম ডিপোজিট বোনাস ====================
// এখানে নেই — services/referralRewards.js (V2)। সব ডিপোজিট-নিশ্চিতকরণ পথ COMMIT-এর পরে
// referralRewards.afterDepositCommit() ডাকে। পুরোনো processReferralDeposit (signup_bonus_paid/bonus_held) সরানো হয়েছে।

// ==================== ৩. মাল্টি-লেভেল কমিশন বিতরণ ====================
// বাজি ধরার সময় ডাকা হবে (গেম ও স্পোর্টস দুই জায়গায়)।
// বাজি যে ধরল তার উপরে ৩ ধাপ পর্যন্ত রেফারারদের কমিশন দেয়।
// নিজে আলাদা transaction ব্যবহার করে (pool থেকে), যাতে মূল বেট আটকে না যায়।
async function distributeCommission(bettorId, stake) {
  if (!stake || stake <= 0) return;
  // নতুন নিয়ম: বাজি ধরলে কোনো কমিশন নেই — কমিশন শুধু ডিপোজিট সম্পূর্ণ হারলে ০.৮%
  // (services/referralRewards.js settleLossCycles)। পুরোনো প্রতি-বাজি ৩-লেভেল কমিশন ডিফল্টে বন্ধ;
  // site_settings referral_bet_commission_enabled = 'true' দিলে আবার চালু হয়।
  if (String(await getSetting('referral_bet_commission_enabled')) !== 'true') return;

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
        // কমিশন টাকা যোগ
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
        // টাকা লেনদেন
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
// সব পড়া V2 (referral_rewards) থেকে। status: paid | legacy_paid = বোনাস পাওয়া।
async function getReferralStats(userId) {
  const totalRes = await pool.query(
    `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`,
    [userId]
  );
  // সফল = বোনাস পাওয়া রেফারেল (paid + legacy_paid)
  const successRes = await pool.query(
    `SELECT COUNT(*) FROM referral_rewards WHERE referrer_id = $1 AND status IN ('paid','legacy_paid')`,
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
    nextBonus: rewards.tierFor(successCount + 1, await rewards.getTiers()).amount, // পুরোনো; পেজ এখন bonusBands ব্যবহার করে
    bonusBands: await rewards.getBands(),
    lossCommissionPercent: await rewards.getLossCommissionPercent(),
    history: historyRes.rows,
    team: teamRes.rows
  };
}

module.exports = {
  createReferral,
  distributeCommission,
  getReferralStats,
  getCommissionRates,
  DEFAULT_COMMISSION_RATES
};
