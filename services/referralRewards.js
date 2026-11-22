// services/referralRewards.js
// Referral V2 পেআউট ইঞ্জিন — docs/REFERRAL_V2_DESIGN.md।
//
// নিয়ম:
//  • রেফারার বোনাস পায় রেফার-করা ইউজারের প্রথম যোগ্য (approved, ≥ ন্যূনতম) ডিপোজিটে, সাইন-আপে নয়।
//  • প্রতি রেফার-করা ইউজারে একবারই — referral_rewards.UNIQUE(referred_user_id) + রেফারার-স্তরের advisory lock।
//  • বোনাস = রেফার-করা ইউজারের ডিপোজিটের অঙ্কের ধাপ (১০০→২০, ২০০–৪৯৯→৫০, ৫০০+→৭৫); সেটিং referral_bonus_bands।
//  • ডিপোজিট-হার কমিশন ০.৮%: নিচে 'ডিপোজিট-হার কমিশন' অংশ (referral_deposit_cycles)।
//  • ফোন/পেমেন্ট-অ্যাকাউন্ট/ডিভাইস মিল → pending_review (কোনো কয়েন বা লেজার নয়)। শুধু IP মিল → flag নয়,
//    evidence-এ নোট। নিজেকে রেফার → rejected।
//  • রেফার-করা ইউজার কোনো রেফারেল বোনাস পায় না (First Deposit Bonus আলাদা, অপরিবর্তিত)।
//  • ইঞ্জিন ডিপোজিট কমিটের পরে আলাদা ট্রানজ্যাকশনে চলে; ত্রুটিতে ডিপোজিট অক্ষত, রেকর্ড retry_pending।

const { pool } = require('../db');
const { getSetting } = require('./settings');
const { createBonus } = require('./turnover');

const DEFAULT_MIN_DEPOSIT = 100;
// প্রথম-ডিপোজিট বোনাস এখন রেফার-করা ইউজারের ডিপোজিটের অঙ্কের ওপর নির্ভর করে (সর্বোচ্চ যে ধাপের min ≤ অঙ্ক):
//   ১০০–১৯৯ → ২০, ২০০–৪৯৯ → ৫০, ৫০০+ → ৭৫
const DEFAULT_BANDS = [
  { min: 100, amount: 20 },
  { min: 200, amount: 50 },
  { min: 500, amount: 75 }
];
// ডিপোজিট হারের কমিশন (শতাংশ): রেফার-করা ইউজারের ডিপোজিট করা টাকা সম্পূর্ণ হারলে ডিপোজিটের এই % রেফারার পায়
const DEFAULT_LOSS_COMMISSION_PERCENT = 0.8;
// ব্যালেন্স এর নিচে নামলে "সম্পূর্ণ হারা" ধরা হয়; আর শেষ কার্যকলাপের এতক্ষণ পর পর্যন্ত অপেক্ষা (মিনিট)
const LOSS_BALANCE_THRESHOLD = 1;
const LOSS_QUIET_MINUTES = 10;
const DEFAULT_TIERS = [
  { max: 1, amount: 100 },
  { max: 5, amount: 200 },
  { max: 15, amount: 400 },
  { max: 50, amount: 800 },
  { max: null, amount: 1500 }
];

function advisoryKey(referrerId) {
  return `referral_rewards:${referrerId}`;
}

// ---------------------------------------------------------------- কনফিগ
function parseTiers(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let prev = 0;
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      const amt = Number(t && t.amount);
      if (!Number.isFinite(amt) || amt < 0) return null;
      const last = i === arr.length - 1;
      if (last) {
        if (t.max !== null && t.max !== undefined) return null;
      } else {
        const m = Number(t.max);
        if (!Number.isInteger(m) || m <= prev) return null;
        prev = m;
      }
    }
    return arr.map(t => ({ max: t.max == null ? null : Number(t.max), amount: Number(t.amount) }));
  } catch (_) {
    return null;
  }
}

async function getTiers() {
  return parseTiers(await getSetting('referral_tiers')) || DEFAULT_TIERS;
}

async function getMinDeposit() {
  const fromSetting = Number(await getSetting('referral_min_deposit'));
  if (Number.isFinite(fromSetting) && fromSetting > 0) return fromSetting;
  const fromEnv = Number(process.env.REFERRAL_MIN_DEPOSIT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_MIN_DEPOSIT;
}

// ordinal = এই রেফারেলটি ধরে কততম (১, ২, ...)
function tierFor(ordinal, tiers = DEFAULT_TIERS) {
  const n = Math.max(1, Math.floor(Number(ordinal) || 1));
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i].max === null || n <= tiers[i].max) return { tier: i + 1, amount: tiers[i].amount };
  }
  const last = tiers[tiers.length - 1];
  return { tier: tiers.length, amount: last.amount };
}


// ---------------------------------------------------------------- ডিপোজিট-অঙ্ক ভিত্তিক বোনাস ধাপ
function parseBands(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let prev = -1;
    const out = [];
    for (const b of arr) {
      const min = Number(b && b.min), amt = Number(b && b.amount);
      if (!Number.isFinite(min) || min <= 0 || !Number.isFinite(amt) || amt < 0 || min <= prev) return null;
      prev = min;
      out.push({ min, amount: amt });
    }
    return out;
  } catch (_) { return null; }
}

async function getBands() {
  return parseBands(await getSetting('referral_bonus_bands')) || DEFAULT_BANDS;
}

// ডিপোজিট অঙ্কের জন্য বোনাস; কোনো ধাপের নিচে হলে { tier: 0, amount: 0 }
function bonusForDeposit(depositAmount, bands = DEFAULT_BANDS) {
  const d = Number(depositAmount);
  let hit = { tier: 0, amount: 0 };
  if (!Number.isFinite(d)) return hit;
  for (let i = 0; i < bands.length; i++) {
    if (d >= bands[i].min) hit = { tier: i + 1, amount: bands[i].amount };
  }
  return hit;
}

async function getLossCommissionPercent() {
  const n = parseFloat(await getSetting('referral_loss_commission_percent'));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_LOSS_COMMISSION_PERCENT;
}

// ---------------------------------------------------------------- জালিয়াতি-গেট
// ফোন: শেষ ১০ অঙ্ক দিয়ে মেলানো (+880 / 0 প্রিফিক্সের পার্থক্য উপেক্ষা)।
function phoneKey(phone) {
  const d = String(phone == null ? '' : phone).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

async function collectEvidence(client, referrerId, referredId) {
  const evidence = { checked_at: new Date().toISOString() };
  const reasons = [];

  const users = await client.query(
    `SELECT id, phone FROM users WHERE id = ANY($1::int[])`, [[referrerId, referredId]]
  );
  const phoneOf = {};
  users.rows.forEach(u => { phoneOf[u.id] = phoneKey(u.phone); });

  // ১) ফোন মিল — রেফারার বা অন্য যেকোনো অ্যাকাউন্টের সঙ্গে (ফরম্যাট-নিরপেক্ষ)
  if (phoneOf[referredId]) {
    const m = await client.query(
      `SELECT id FROM users
        WHERE id <> $1
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = $2
        LIMIT 20`,
      [referredId, phoneOf[referredId]]
    );
    if (m.rows.length) {
      reasons.push('phone_match');
      evidence.phone_match = { related_users: m.rows.map(r => r.id), with_referrer: m.rows.some(r => r.id === referrerId) };
    }
  }

  // ২) পেমেন্ট অ্যাকাউন্ট মিল — রেফার-করা ইউজারের ব্যবহৃত অ্যাকাউন্ট অন্য ইউজারের সঙ্গে
  const pay = await client.query(
    `WITH mine AS (
       SELECT DISTINCT account_number AS acc FROM payment_requests
        WHERE user_id = $1 AND account_number IS NOT NULL AND account_number <> ''
       UNION
       SELECT DISTINCT account_number FROM bank_cards
        WHERE user_id = $1 AND account_number IS NOT NULL AND account_number <> ''
     )
     SELECT DISTINCT user_id FROM (
       SELECT pr.user_id FROM payment_requests pr JOIN mine ON pr.account_number = mine.acc
        WHERE pr.user_id IS NOT NULL AND pr.user_id <> $1
       UNION
       SELECT bc.user_id FROM bank_cards bc JOIN mine ON bc.account_number = mine.acc
        WHERE bc.user_id IS NOT NULL AND bc.user_id <> $1
     ) x LIMIT 20`,
    [referredId]
  );
  if (pay.rows.length) {
    reasons.push('payment_account_match');
    evidence.payment_account_match = { related_users: pay.rows.map(r => r.user_id), with_referrer: pay.rows.some(r => r.user_id === referrerId) };
  }

  // ৩) ডিভাইস মিল (রেফারার ↔ রেফার্ড) — শুধু ক্লায়েন্ট-পাঠানো device_fingerprint।
  // device_sessions.device_signature বাদ: fingerprint না থাকলে সেটা শুধু User-Agent-এর হ্যাশ, তাই একই
  // মডেলের ফোন/ব্রাউজারের ভিন্ন মানুষ একই signature পায় — সেটায় ফ্ল্যাগ করলে বৈধ ইউজার আটকাত।
  const dev = await client.query(
    `SELECT 1 FROM login_logs a JOIN login_logs b ON a.device_fingerprint = b.device_fingerprint
      WHERE a.user_id = $1 AND b.user_id = $2
        AND a.device_fingerprint IS NOT NULL AND a.device_fingerprint <> '' LIMIT 1`,
    [referrerId, referredId]
  );
  if (dev.rows.length) {
    reasons.push('device_match');
    evidence.device_match = { with_referrer: true };
  }

  // ৪) শুধু IP মিল — flag নয়, শুধু নোট
  const ip = await client.query(
    `SELECT 1 FROM login_logs a JOIN login_logs b ON a.ip = b.ip
      WHERE a.user_id = $1 AND b.user_id = $2 AND a.ip IS NOT NULL LIMIT 1`,
    [referrerId, referredId]
  );
  if (ip.rows.length) evidence.ip_match_note = 'একই IP — শুধু নোট, স্বয়ংক্রিয় ফ্ল্যাগ নয়';

  return { reasons, evidence };
}

// ---------------------------------------------------------------- মূল ইঞ্জিন
// আলাদা ট্রানজ্যাকশনে চলে (ডিপোজিট COMMIT-এর পরে)। কখনো throw করে না।
async function processReferralReward(referredUserId, depositId) {
  // কনফিগ আগে পড়া — client ধরে রেখে আরেকটা pool connection চাওয়া (settings ক্যাশ-মিস) pool আটকাতে পারে
  let cfg;
  try {
    cfg = { minDeposit: await getMinDeposit(), tiers: await getTiers(), bands: await getBands() };
  } catch (e) {
    console.error('referral reward config error (retry_pending):', e.message);
    await markRetryPending(referredUserId, depositId).catch(() => {});
    return { outcome: 'error' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await runInTx(client, referredUserId, depositId, cfg);
    await client.query('COMMIT');
    return outcome;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('referral reward engine error (retry_pending):', e.message);
    await markRetryPending(referredUserId, depositId).catch(err =>
      console.error('referral retry_pending record error:', err.message));
    return { outcome: 'error' };
  } finally {
    client.release();
  }
}

async function runInTx(client, referredUserId, depositId, cfg) {
  const refRes = await client.query(
    `SELECT referrer_id FROM referrals WHERE referred_id = $1`, [referredUserId]
  );
  if (!refRes.rows[0] || !refRes.rows[0].referrer_id) return { outcome: 'no_referral' };
  const referrerId = refRes.rows[0].referrer_id;

  // রেফারারের সারিতে (advisory) লক — একই রেফারারের সমান্তরাল পেআউটে টিয়ার রেস নেই
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [advisoryKey(referrerId)]);

  const existingRes = await client.query(
    `SELECT * FROM referral_rewards WHERE referred_user_id = $1 FOR UPDATE`, [referredUserId]
  );
  const existing = existingRes.rows[0];
  if (existing && existing.status !== 'retry_pending') {
    return { outcome: 'already_processed', status: existing.status };
  }

  // আগের ব্যর্থ চেষ্টার যোগ্য ডিপোজিটই প্রথম যোগ্য ডিপোজিট
  const qualifyingId = (existing && existing.qualifying_deposit_id) || depositId;
  if (!qualifyingId) return { outcome: 'no_deposit' };
  const depRes = await client.query(
    `SELECT id, user_id, type, status, amount FROM payment_requests WHERE id = $1`, [qualifyingId]
  );
  const dep = depRes.rows[0];
  const minDeposit = cfg.minDeposit;
  if (!dep || dep.type !== 'deposit' || Number(dep.user_id) !== Number(referredUserId)
      || dep.status !== 'approved') {
    return { outcome: 'not_qualifying' };
  }
  if (Number(dep.amount) < minDeposit) return { outcome: 'below_min' }; // পরে ≥ ন্যূনতম ডিপোজিটে ট্রিগার হবে

  // নিজেকে রেফার প্রত্যাখ্যান
  if (Number(referrerId) === Number(referredUserId)) {
    await upsertFinal(client, existing, {
      referredUserId, referrerId, status: 'rejected', tier: null, amount: 0,
      depositId: dep.id, reason: 'self_referral', evidence: null
    });
    return { outcome: 'rejected', reason: 'self_referral' };
  }

  const { reasons, evidence } = await collectEvidence(client, referrerId, referredUserId);
  if (reasons.length) {
    await upsertFinal(client, existing, {
      referredUserId, referrerId, status: 'pending_review', tier: null, amount: 0,
      depositId: dep.id, reason: reasons.join(','), evidence
    });
    return { outcome: 'pending_review', reasons };
  }

  // বোনাস = রেফার-করা ইউজারের যোগ্য (প্রথম) ডিপোজিটের অঙ্ক অনুযায়ী ধাপ (রেফারারের আগের রেফার সংখ্যার ওপর নির্ভর করে না)
  const { tier, amount } = bonusForDeposit(dep.amount, cfg.bands);
  if (!(amount > 0)) return { outcome: 'below_min' };

  const row = await upsertFinal(client, existing, {
    referredUserId, referrerId, status: 'paid', tier, amount,
    depositId: dep.id, reason: null, evidence
  });
  if (!row) return { outcome: 'already_processed' }; // ON CONFLICT DO NOTHING — অন্য কেউ আগেই claim করেছে

  // একই ট্রানজ্যাকশনে: কয়েন, ওয়েজারিং লক (৩x স্পোর্টস / ০x ক্যাসিনো), লেজার, রেকর্ড, নোটিফিকেশন
  await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [amount, referrerId]);
  await createBonus(client, referrerId, 'referral', amount);
  await client.query(
    `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason)
     VALUES ($1, $2, 0, $3, 'first_deposit')`,
    [referrerId, referredUserId, amount]
  );
  await client.query(
    `INSERT INTO coin_transactions (user_id, amount, type, description)
     VALUES ($1, $2, 'referral_bonus', 'রেফারেল প্রথম-ডিপোজিট বোনাস')`,
    [referrerId, amount]
  );
  await client.query(`UPDATE referrals SET first_deposit_done = true WHERE referred_id = $1`, [referredUserId]);
  await client.query(
    `INSERT INTO notifications (user_id, title, message, type)
     VALUES ($1, 'রেফারেল বোনাস!', $2, 'success')`,
    [referrerId, `আপনার রেফার করা বন্ধু প্রথম ডিপোজিট করেছে! আপনি ${amount} টাকা বোনাস পেয়েছেন। (উইথড্রর আগে টার্নওভার শর্ত পূরণ করতে হবে)`]
  );
  return { outcome: 'paid', tier, amount, referrerId };
}

// retry_pending সারি থাকলে UPDATE, নইলে INSERT ... ON CONFLICT DO NOTHING; ব্যর্থ হলে null।
async function upsertFinal(client, existing, d) {
  const paidAt = d.status === 'paid' ? new Date() : null;
  if (existing) {
    const r = await client.query(
      `UPDATE referral_rewards
          SET status = $2, tier = $3, amount = $4, qualifying_deposit_id = $5,
              review_reason = $6, evidence = $7, paid_at = $8
        WHERE id = $1 AND status = 'retry_pending'
        RETURNING id`,
      [existing.id, d.status, d.tier, d.amount, d.depositId, d.reason,
        d.evidence ? JSON.stringify(d.evidence) : null, paidAt]
    );
    return r.rows[0] || null;
  }
  const r = await client.query(
    `INSERT INTO referral_rewards
       (referred_user_id, referrer_id, status, tier, amount, qualifying_deposit_id, review_reason, evidence, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (referred_user_id) DO NOTHING
     RETURNING id`,
    [d.referredUserId, d.referrerId, d.status, d.tier, d.amount, d.depositId, d.reason,
      d.evidence ? JSON.stringify(d.evidence) : null, paidAt]
  );
  return r.rows[0] || null;
}

// ইঞ্জিন ব্যর্থ হলে আলাদা (autocommit) ইনসার্ট — আগে থেকে কোনো সারি থাকলে বদলায় না।
async function markRetryPending(referredUserId, depositId) {
  const ref = await pool.query(`SELECT referrer_id FROM referrals WHERE referred_id = $1`, [referredUserId]);
  if (!ref.rows[0]) return;
  await pool.query(
    `INSERT INTO referral_rewards (referred_user_id, referrer_id, status, qualifying_deposit_id, review_reason)
     VALUES ($1, $2, 'retry_pending', $3, 'engine error — retry pending')
     ON CONFLICT (referred_user_id) DO NOTHING`,
    [referredUserId, ref.rows[0].referrer_id, depositId || null]
  );
}


// ================================================================ ডিপোজিট-হার কমিশন (০.৮%)
// নিয়ম: রেফার-করা ইউজার ডিপোজিট করলে একটা "সাইকেল" খোলে (ব্যালেন্স থাকা পর্যন্ত পরের ডিপোজিট একই সাইকেলে যোগ হয়)।
// ইউজারের ব্যালেন্স শূন্য হয়ে গেলে (কোনো পেন্ডিং বাজি নেই, কিছুক্ষণ কার্যকলাপ নেই, সাইকেলের মধ্যে উইথড্র নেই)
// সাইকেলের মোট ডিপোজিটের ০.৮% রেফারার পায়। মাঝে কত জিতেছে/বাজি ধরেছে তা ধরা হয় না; জিতলে বা শুধু বাজি ধরলে কমিশন নেই।
// লেজার: referral_commissions (reason='loss_commission', level 1) + coin_transactions।

async function recordCycleDeposit(userId, depositId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dep = await client.query(
      `SELECT id, user_id, type, status, amount FROM payment_requests WHERE id = $1`, [depositId]);
    const d = dep.rows[0];
    if (!d || d.type !== 'deposit' || d.status !== 'approved' || Number(d.user_id) !== Number(userId)) {
      await client.query('ROLLBACK'); return { outcome: 'not_qualifying' };
    }
    const ref = await client.query(`SELECT referrer_id FROM referrals WHERE referred_id = $1`, [userId]);
    const referrerId = ref.rows[0] && ref.rows[0].referrer_id;
    if (!referrerId || Number(referrerId) === Number(userId)) { await client.query('ROLLBACK'); return { outcome: 'no_referral' }; }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`referral_cycle:${userId}`]);
    const open = await client.query(
      `SELECT id, deposit_ids FROM referral_deposit_cycles WHERE referred_user_id = $1 AND status = 'open' FOR UPDATE`, [userId]);
    if (open.rows[0]) {
      if ((open.rows[0].deposit_ids || []).map(Number).includes(Number(depositId))) {
        await client.query('ROLLBACK'); return { outcome: 'already_recorded' };
      }
      await client.query(
        `UPDATE referral_deposit_cycles
            SET deposited = deposited + $2, deposit_ids = array_append(deposit_ids, $3)
          WHERE id = $1`, [open.rows[0].id, d.amount, d.id]);
    } else {
      await client.query(
        `INSERT INTO referral_deposit_cycles (referred_user_id, referrer_id, deposited, deposit_ids)
         VALUES ($1, $2, $3, ARRAY[$4::int])`, [userId, referrerId, d.amount, d.id]);
    }
    await client.query('COMMIT');
    return { outcome: 'recorded' };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('recordCycleDeposit error:', e.message);
    return { outcome: 'error' };
  } finally {
    client.release();
  }
}

// ইউজারের সাইকেল এখন "সম্পূর্ণ হারা" কিনা দেখে, হলে কমিশন দেয়। একটা সাইকেল একবারই পেআউট পায়।
async function settleOneCycle(cycleId, percent) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cRes = await client.query(
      `SELECT * FROM referral_deposit_cycles WHERE id = $1 AND status = 'open' FOR UPDATE`, [cycleId]);
    const c = cRes.rows[0];
    if (!c) { await client.query('ROLLBACK'); return { outcome: 'gone' }; }

    const u = await client.query(`SELECT coins FROM users WHERE id = $1 FOR UPDATE`, [c.referred_user_id]);
    if (!u.rows[0] || Number(u.rows[0].coins || 0) >= LOSS_BALANCE_THRESHOLD) {
      await client.query('ROLLBACK'); return { outcome: 'still_has_balance' };
    }
    const busy = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM bets WHERE user_id = $1 AND status = 'pending') AS pending_bets,
         EXISTS (SELECT 1 FROM accumulators WHERE user_id = $1 AND status = 'pending') AS pending_accas,
         GREATEST(
           COALESCE((SELECT MAX(created_at) FROM bets WHERE user_id = $1), 'epoch'::timestamp),
           COALESCE((SELECT MAX(created_at) FROM coin_transactions WHERE user_id = $1), 'epoch'::timestamp),
           COALESCE((SELECT MAX(created_at) FROM provider_transactions WHERE user_id = $1), 'epoch'::timestamp)
         ) > NOW() - ($2 || ' minutes')::interval AS recent_activity`,
      [c.referred_user_id, String(LOSS_QUIET_MINUTES)]);
    const b = busy.rows[0];
    if (b.pending_bets || b.pending_accas || b.recent_activity) {
      await client.query('ROLLBACK'); return { outcome: 'not_settled_yet' };
    }

    // সাইকেলের মধ্যে উইথড্র হলে "সম্পূর্ণ হারা" নয় — কমিশন নেই
    const wd = await client.query(
      `SELECT 1 FROM payment_requests
        WHERE user_id = $1 AND type = 'withdraw' AND status IN ('pending','approved') AND created_at >= $2 LIMIT 1`,
      [c.referred_user_id, c.opened_at]);
    // রেফারেল যদি আটকানো/বাতিল (জালিয়াতি-গেট) হয় — কমিশন নেই
    const rw = await client.query(`SELECT status FROM referral_rewards WHERE referred_user_id = $1`, [c.referred_user_id]);
    const rwStatus = rw.rows[0] && rw.rows[0].status;

    let status = 'lost_paid', commission = Math.round(Number(c.deposited) * percent) / 100;
    if (wd.rows.length) { status = 'closed_withdrawn'; commission = 0; }
    else if (['pending_review', 'rejected', 'reversed'].includes(rwStatus)) { status = 'closed_held'; commission = 0; }
    else if (!(commission > 0)) { status = 'closed_zero'; commission = 0; }

    await client.query(
      `UPDATE referral_deposit_cycles SET status = $2, commission = $3, closed_at = NOW() WHERE id = $1`,
      [c.id, status, commission]);

    if (status === 'lost_paid') {
      await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [commission, c.referrer_id]);
      await client.query(
        `INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason)
         VALUES ($1, $2, 1, $3, 'loss_commission')`, [c.referrer_id, c.referred_user_id, commission]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'referral_commission', $3)`,
        [c.referrer_id, commission, `রেফারেল ডিপোজিট-হার কমিশন (${percent}%)`]);
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'রেফারেল কমিশন!', $2, 'success')`,
        [c.referrer_id, `আপনার রেফার করা বন্ধুর ডিপোজিট করা টাকা সম্পূর্ণ শেষ হওয়ায় আপনি ${commission} টাকা (${percent}%) কমিশন পেয়েছেন।`]);
    }
    await client.query('COMMIT');
    return { outcome: status, commission };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('settleOneCycle error:', e.message);
    return { outcome: 'error' };
  } finally {
    client.release();
  }
}

// শিডিউলার থেকে ডাকা — ব্যালেন্স < ১ সব খোলা সাইকেল যাচাই।
async function settleLossCycles(limit = 100) {
  const percent = await getLossCommissionPercent();
  const r = await pool.query(
    `SELECT c.id FROM referral_deposit_cycles c
       JOIN users u ON u.id = c.referred_user_id
      WHERE c.status = 'open' AND COALESCE(u.coins, 0) < $2
      ORDER BY c.id LIMIT $1`, [limit, LOSS_BALANCE_THRESHOLD]);
  const tally = {};
  for (const row of r.rows) {
    const o = await settleOneCycle(row.id, percent);
    tally[o.outcome] = (tally[o.outcome] || 0) + 1;
  }
  return { scanned: r.rows.length, tally };
}

// ডিপোজিট COMMIT-এর পরে সব নিশ্চিতকরণ পথ থেকে এটাই ডাকা হয়। কখনো throw করে না।
async function afterDepositCommit(userId, depositId) {
  try {
    const out = await processReferralReward(userId, depositId);
    await recordCycleDeposit(userId, depositId); // কখনো throw করে না
    return out;
  } catch (e) {
    console.error('afterDepositCommit referral error:', e.message);
    return { outcome: 'error' };
  }
}

// retry_pending সারিগুলো আবার চালানো (শিডিউলার/ম্যানুয়াল)।
async function retryPending(limit = 50) {
  const r = await pool.query(
    `SELECT referred_user_id, qualifying_deposit_id FROM referral_rewards
      WHERE status = 'retry_pending' ORDER BY id LIMIT $1`, [limit]
  );
  const results = [];
  for (const row of r.rows) {
    results.push(await processReferralReward(row.referred_user_id, row.qualifying_deposit_id));
  }
  return results;
}

module.exports = {
  processReferralReward, afterDepositCommit, retryPending, collectEvidence,
  tierFor, parseTiers, getTiers, getMinDeposit, phoneKey,
  parseBands, getBands, bonusForDeposit, getLossCommissionPercent,
  recordCycleDeposit, settleOneCycle, settleLossCycles,
  DEFAULT_TIERS, DEFAULT_BANDS, DEFAULT_MIN_DEPOSIT, DEFAULT_LOSS_COMMISSION_PERCENT
};
