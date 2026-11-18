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
//  সময়: সাইন-আপে নয় — রেফার-করা ইউজারের প্রথম নিশ্চিত (অনুমোদিত/সফল) ডিপোজিটে, প্রতি রেফার-করা ইউজারে ঠিক একবার।
//  শর্ত: ডিপোজিট ≥ REFERRAL_MIN_DEPOSIT (env; ডিফল্ট = সাইটের ন্যূনতম ডিপোজিট ১০০)। পরিমাণ ডিপোজিটের অঙ্কের ওপর নির্ভর করে না।
//  গার্ড: রেফারার ও রেফার-করা একই ফোন/IP/ডিভাইসে হলে (বা নিজেকে রেফার) বোনাস আটকে অ্যাডমিন রিভিউয়ে যায়।
//
//  মাল্টি-লেভেল কমিশন (আজীবন, বাজির উপর):
//    Tier 1 (সরাসরি)  → ২.৫%
//    Tier 2           → ১.৫%
//    Tier 3           → ০.৮%

const { pool } = require('../db');
const { getSetting } = require('./settings');
const { tierFor, getTiers, DEFAULT_TIERS, DEFAULT_MIN_DEPOSIT } = require('./referralRewards');

const MIN_DEPOSIT_FOR_BONUS = DEFAULT_MIN_DEPOSIT; // ডিফল্ট; আসল মান settings.referral_min_deposit (referralRewards.getMinDeposit)
// এর উপরে risk score উঠলে রেফারেল বোনাস স্বয়ংক্রিয়ভাবে ছাড় না দিয়ে
// অ্যাডমিন রিভিউয়ের জন্য আটকে রাখা হয়।
const REFERRAL_REVIEW_RISK_THRESHOLD = 50;

// সাইটের বিদ্যমান ন্যূনতম ডিপোজিট (routes/payment.js-এ `amount < 100` প্রত্যাখ্যাত) — রেফারেল ন্যূনতমের ডিফল্ট।
const SITE_MIN_DEPOSIT = 100;
/** রেফারেল বোনাসের ন্যূনতম ডিপোজিট: env REFERRAL_MIN_DEPOSIT (ধনাত্মক সংখ্যা), না থাকলে SITE_MIN_DEPOSIT। */
function getMinDepositForBonus(env = process.env) {
  const n = Number(env.REFERRAL_MIN_DEPOSIT);
  return Number.isFinite(n) && n > 0 ? n : SITE_MIN_DEPOSIT;
}
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

// ==================== ২. প্রথম ডিপোজিট প্রসেস ====================
// নিশ্চিত (অনুমোদিত/সফল) ডিপোজিট ক্রেডিটের সময় ডাকা হবে — creditApprovedDeposit-এর ভেতরে, একই ট্রানজ্যাকশনে।
// (অ্যাডমিন অনুমোদন, বাল্ক, SSLCommerz redirect/IPN, ওয়ালেট callback, gatewayReconcile সব পথ ওই একই ফাংশন ডাকে।)
// রেফার-করা ইউজারের প্রথম যোগ্য ডিপোজিটে রেফারারকে প্রোগ্রেসিভ বোনাস, প্রতি রেফার-করা ইউজারে ঠিক একবার।

const digitsTail = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; };

/**
 * রেফারার ও রেফার-করা ইউজারের মধ্যে অপব্যবহারের মিল — বিদ্যমান ডেটা (users.phone, login_logs, device_sessions) দিয়ে,
 * নতুন ট্র্যাকিং ছাড়া। মিল থাকলে কারণের কোড ফেরত দেয় (self | same_phone | same_ip | same_device), নাহলে null।
 */
async function findReferralPairMatch(db, referrerId, referredId) {
  if (Number(referrerId) === Number(referredId)) return 'self';
  const u = await db.query('SELECT id, phone FROM users WHERE id = ANY($1::int[])', [[referrerId, referredId]]);
  const phones = new Map(u.rows.map((r) => [Number(r.id), digitsTail(r.phone)]));
  const a = phones.get(Number(referrerId)); const b = phones.get(Number(referredId));
  if (a && b && a === b) return 'same_phone';
  const ip = await db.query(
    `SELECT 1 FROM login_logs a JOIN login_logs b ON a.ip = b.ip
      WHERE a.user_id = $1 AND b.user_id = $2 AND a.ip IS NOT NULL AND a.ip <> '' LIMIT 1`,
    [referrerId, referredId]
  );
  if (ip.rowCount) return 'same_ip';
  const dev = await db.query(
    `SELECT 1 FROM login_logs a JOIN login_logs b ON a.device_fingerprint = b.device_fingerprint
      WHERE a.user_id = $1 AND b.user_id = $2 AND a.device_fingerprint IS NOT NULL AND a.device_fingerprint <> ''
     UNION ALL
     SELECT 1 FROM device_sessions a JOIN device_sessions b ON a.device_signature = b.device_signature
      WHERE a.user_id = $1 AND b.user_id = $2 AND a.device_signature IS NOT NULL AND a.device_signature <> ''
     LIMIT 1`,
    [referrerId, referredId]
  );
  if (dev.rowCount) return 'same_device';
  return null;
}

async function processReferralDeposit(client, referredUserId, depositAmount) {
  try {
    const amount = Number(depositAmount);
    if (!Number.isFinite(amount) || amount < getMinDepositForBonus()) return; // ন্যূনতমের নিচে, বোনাস নেই

    // এখনও বোনাস-না-দেওয়া রেফারেল আছে কি (শুধু পড়া)। না থাকলে কেউ রেফার করেনি বা আগেই দেওয়া হয়ে গেছে।
    const pre = await client.query(
      `SELECT referrer_id FROM referrals WHERE referred_id = $1 AND signup_bonus_paid = false`,
      [referredUserId]
    );
    if (!pre.rows[0]) return;

    // ==================== অপব্যবহার-গার্ড (পেআউটের আগে) ====================
    // ১) রেফারার-বনাম-রেফার-করা মিল (নিজে, একই ফোন/IP/ডিভাইস) ২) বিদ্যমান duplicate-account risk score।
    // মিল পেলে বোনাস দেওয়া হয় না; অ্যাডমিন রিভিউ তালিকায় 'আটকানো' দেখায়। যাচাই ব্যর্থ হলেও আটকানো (fail-closed)।
    let holdReason = null;
    try {
      holdReason = await findReferralPairMatch(client, pre.rows[0].referrer_id, referredUserId);
    } catch (e) {
      console.error('referral pair check error:', e.message);
      holdReason = 'check_error';
    }
    if (!holdReason) {
      try {
        const flag = await evaluateDuplicateAccount(referredUserId, {});
        if (flag && Number(flag.risk_score) >= REFERRAL_REVIEW_RISK_THRESHOLD) holdReason = 'duplicate_risk';
      } catch (e) {
        console.error('referral duplicate check error:', e.message);
      }
    }
    const held = !!holdReason;

    // atomic conditional UPDATE: single-statement, তাই একাধিক callback/সমান্তরাল ডিপোজিটেও ঠিক একজন claim পায়
    // (referrals.referred_id UNIQUE + WHERE signup_bonus_paid=false)। rowCount 0 = অন্য কল আগেই claim করেছে।
    const claimRes = await client.query(
      `UPDATE referrals SET first_deposit_done = true, signup_bonus_paid = true, bonus_held = $2, hold_reason = $3
       WHERE referred_id = $1 AND signup_bonus_paid = false
       RETURNING id, referrer_id`,
      [referredUserId, held, holdReason]
    );
    const ref = claimRes.rows[0];
    if (!ref) return; // বোনাস আগেই claim হয়ে গেছে (রেস জেতেনি)

    // রেফারার এ পর্যন্ত কতজনকে সফলভাবে (আটকানো নয়) রেফার করেছে — সেটাই এই রেফারের অবস্থান (বোনাসের স্তর)
    const cntRes = await client.query(
      `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND signup_bonus_paid = true AND bonus_held = false`,
      [ref.referrer_id]
    );
    const thisIsNumber = parseInt(cntRes.rows[0].count) + (held ? 1 : 0);
    const bonus = signupBonusFor(thisIsNumber);
    await client.query(`UPDATE referrals SET bonus_amount = $1 WHERE id = $2`, [bonus, ref.id]);

    // রেফারারকে বোনাস টাকা — আটকানো হলে এখন নয়
    if (!held) {
      await client.query(
        `UPDATE users SET coins = coins + $1 WHERE id = $2`,
        [bonus, ref.referrer_id]
      );
    }

    // টার্নওভার লক — রেফারেল বোনাসেও ওয়েজারিং (RULES.referral); আটকানো হলে pending_review, ওয়েজারিং শুরু হয় না।
    await createBonus(client, ref.referrer_id, 'referral', bonus,
      held ? { status: 'pending_review' } : {});
    if (!held) {
      // কমিশন হিস্ট্রি (অডিট) ও টাকা লেনদেন — শুধু যখন সত্যিই দেওয়া হলো
      await client.query(
        `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason)
         VALUES ($1, $2, 0, $3, 'signup')`,
        [ref.referrer_id, referredUserId, bonus]
      );
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'referral_bonus', 'রেফারেল প্রথম-ডিপোজিট বোনাস')`,
        [ref.referrer_id, bonus]
      );
    }
    // নোটিফিকেশন
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'রেফারেল বোনাস!', $2, 'success')`,
      [ref.referrer_id, held
        ? `আপনার রেফারেল বোনাস (${bonus} টাকা) যাচাইয়ের জন্য অপেক্ষমাণ। অনুমোদনের পর যোগ হবে।`
        : `আপনার রেফার করা বন্ধু প্রথম ডিপোজিট করেছে! আপনি ${bonus} টাকা বোনাস পেয়েছেন। (উইথড্রর আগে টার্নওভার শর্ত পূরণ করতে হবে)`]
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
async function getReferralStats(userId) {
  // মোট রেফার, সফল (বোনাস পাওয়া) রেফার
  const totalRes = await pool.query(
    `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1`,
    [userId]
  );
  // সফল = V2 রেফারেল 'paid' (legacy_paid আলাদা — টিয়ারে গোনা হয় না)
  const successRes = await pool.query(
    `SELECT COUNT(*) FROM referral_rewards WHERE referrer_id = $1 AND status = 'paid'`,
    `SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND signup_bonus_paid = true AND bonus_held = false`,
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
    `SELECT u.username, u.created_at, r.first_deposit_done, r.signup_bonus_paid, r.bonus_held
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
  processReferralDeposit,
  findReferralPairMatch,
  getMinDepositForBonus,
  distributeCommission,
  getReferralStats,
  signupBonusFor,
  getCommissionRates,
  DEFAULT_COMMISSION_RATES,
  SITE_MIN_DEPOSIT
};
