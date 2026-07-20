const { pool } = require('../db');

const RAPID_WINDOW_MINUTES = 10;
const RAPID_REGISTRATION_THRESHOLD = 3; // একই IP থেকে ১০ মিনিটে ৩+ রেজিস্ট্রেশন
const RAPID_TX_THRESHOLD = 3;           // একই ইউজারের ১০ মিনিটে ৩+ ডিপোজিট/উইথড্র রিকোয়েস্ট

// ==================== Fraud Detection Engine — লগইন-ভিত্তিক থ্রেশহোল্ড ====================
const FAILED_LOGIN_WINDOW_MINUTES = 15;
const FAILED_LOGIN_THRESHOLD = 5;         // ১৫ মিনিটে ৫+ ভুল লগইন — brute-force সন্দেহ
const FAILED_LOGIN_SEVERE_THRESHOLD = 10; // ১৫ মিনিটে ১০+ ভুল লগইন — উচ্চ ঝুঁকি
const IP_CHANGE_WINDOW_HOURS = 24;
const IP_CHANGE_THRESHOLD = 3;            // ২৪ ঘণ্টায় ৩+ আলাদা IP থেকে লগইন
const DEVICE_CHANGE_WINDOW_HOURS = 24;
const DEVICE_CHANGE_THRESHOLD = 3;        // ২৪ ঘণ্টায় ৩+ আলাদা ডিভাইস থেকে লগইন

async function logAdminAction(adminId, adminUsername, actionType, details, ip = null) {
  try {
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, adminUsername, actionType, details, ip]
    );
  } catch (err) {
    console.error('Fraud audit log error:', err.message);
  }
}

async function findRelatedUsersByIp(userId, ip) {
  if (!ip) return [];
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM login_logs WHERE ip = $1 AND user_id IS NOT NULL AND user_id != $2`,
    [ip, userId]
  );
  return r.rows.map(row => row.user_id);
}

async function findRelatedUsersByDevice(userId, deviceFingerprint) {
  if (!deviceFingerprint) return [];
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM login_logs WHERE device_fingerprint = $1 AND user_id IS NOT NULL AND user_id != $2`,
    [deviceFingerprint, userId]
  );
  return r.rows.map(row => row.user_id);
}

async function findRelatedUsersByPaymentAccount(userId, accountNumber) {
  if (!accountNumber) return [];
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM (
       SELECT user_id FROM bank_cards WHERE account_number = $1
       UNION
       SELECT user_id FROM payment_requests WHERE account_number = $1
     ) t WHERE user_id != $2`,
    [accountNumber, userId]
  );
  return r.rows.map(row => row.user_id);
}

// একই IP থেকে অল্প সময়ে একাধিক নতুন রেজিস্ট্রেশন
async function checkRapidRegistrations(ip) {
  if (!ip) return null;
  const r = await pool.query(
    `SELECT COUNT(*) FROM users WHERE last_ip = $1 AND created_at > NOW() - INTERVAL '${RAPID_WINDOW_MINUTES} minutes'`,
    [ip]
  );
  const count = parseInt(r.rows[0].count, 10);
  return count >= RAPID_REGISTRATION_THRESHOLD ? { count, windowMinutes: RAPID_WINDOW_MINUTES } : null;
}

// একজন ইউজারের অল্প সময়ে একাধিক ডিপোজিট/উইথড্র রিকোয়েস্ট
async function checkRapidTransactions(userId, type) {
  const r = await pool.query(
    `SELECT COUNT(*) FROM payment_requests
     WHERE user_id = $1 AND type = $2 AND created_at > NOW() - INTERVAL '${RAPID_WINDOW_MINUTES} minutes'`,
    [userId, type]
  );
  const count = parseInt(r.rows[0].count, 10);
  return count >= RAPID_TX_THRESHOLD ? { count, windowMinutes: RAPID_WINDOW_MINUTES } : null;
}

function computeRiskLevel(signals) {
  const maxRelated = signals.reduce((m, s) => Math.max(m, s.relatedCount || 0), 0);
  const HIGH_SEVERITY_TYPES = ['repeated_failed_login_severe'];
  const MEDIUM_SEVERITY_TYPES = [
    'rapid_registration', 'rapid_transaction', 'repeated_failed_login',
    'multiple_ip_change', 'multiple_device_change', 'unusual_login'
  ];
  const hasHigh = signals.some(s => HIGH_SEVERITY_TYPES.includes(s.type));
  const hasMedium = signals.some(s => MEDIUM_SEVERITY_TYPES.includes(s.type));
  const sharedSignalCount = signals.filter(s => s.type.startsWith('shared_')).length;

  if (maxRelated >= 3 || hasHigh || (hasMedium && sharedSignalCount > 0)) return 'high';
  if (maxRelated >= 1 || hasMedium) return 'medium';
  return signals.length ? 'low' : null;
}

async function createFraudFlag(userId, signals) {
  const riskLevel = computeRiskLevel(signals);
  if (!riskLevel) return null;

  const signalTypes = signals.map(s => s.type);
  const relatedUserIds = [...new Set(signals.flatMap(s => s.relatedUsers || []))];
  const reason = signals.map(s => s.description).join('; ');

  const inserted = await pool.query(
    `INSERT INTO fraud_flags (user_id, risk_level, signal_types, reason, related_user_ids, details, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open') RETURNING *`,
    [userId, riskLevel, signalTypes, reason, relatedUserIds, JSON.stringify(signals)]
  );
  const flag = inserted.rows[0];

  await logAdminAction(
    null,
    'SYSTEM',
    'FRAUD_FLAG_CREATED',
    `ইউজার #${userId} — ঝুঁকি: ${riskLevel.toUpperCase()} — ${reason}`,
    null
  );

  return flag;
}

/**
 * নতুন রেজিস্ট্রেশনের সময় কল হয়। কখনো ব্লক করে না — ব্যর্থ হলে শুধু লগ করে, রেজিস্ট্রেশন চলতে থাকে।
 */
async function evaluateRegistration(userId, { ip, deviceFingerprint, email, phone } = {}) {
  try {
    const signals = [];

    const ipRelated = await findRelatedUsersByIp(userId, ip);
    if (ipRelated.length) {
      signals.push({
        type: 'shared_ip', relatedUsers: ipRelated, relatedCount: ipRelated.length,
        description: `IP (${ip}) আগে ${ipRelated.length}টি অন্য অ্যাকাউন্টে ব্যবহৃত হয়েছে`
      });
    }

    const deviceRelated = await findRelatedUsersByDevice(userId, deviceFingerprint);
    if (deviceRelated.length) {
      signals.push({
        type: 'shared_device', relatedUsers: deviceRelated, relatedCount: deviceRelated.length,
        description: `ডিভাইস ফিঙ্গারপ্রিন্ট ${deviceRelated.length}টি অন্য অ্যাকাউন্টে ব্যবহৃত হয়েছে`
      });
    }

    const rapid = await checkRapidRegistrations(ip);
    if (rapid) {
      signals.push({
        type: 'rapid_registration', relatedUsers: [], relatedCount: 0,
        description: `একই IP থেকে ${rapid.windowMinutes} মিনিটে ${rapid.count}টি রেজিস্ট্রেশন`
      });
    }

    if (signals.length) return await createFraudFlag(userId, signals);
    return null;
  } catch (err) {
    console.error('evaluateRegistration error (non-blocking):', err.message);
    return null;
  }
}

/**
 * ডিপোজিট/উইথড্র রিকোয়েস্ট তৈরির পর কল হয়। কখনো ব্লক করে না।
 * type: 'deposit' | 'withdraw'
 */
async function evaluateTransaction(userId, type, { accountNumber } = {}) {
  try {
    const signals = [];

    const paymentRelated = await findRelatedUsersByPaymentAccount(userId, accountNumber);
    if (paymentRelated.length) {
      signals.push({
        type: 'shared_payment_account', relatedUsers: paymentRelated, relatedCount: paymentRelated.length,
        description: `পেমেন্ট অ্যাকাউন্ট (${accountNumber}) ${paymentRelated.length}টি অন্য অ্যাকাউন্টে ব্যবহৃত হয়েছে`
      });
    }

    const rapid = await checkRapidTransactions(userId, type);
    if (rapid) {
      const label = type === 'deposit' ? 'ডিপোজিট' : 'উইথড্র';
      signals.push({
        type: 'rapid_transaction', relatedUsers: [], relatedCount: 0,
        description: `${rapid.windowMinutes} মিনিটে ${rapid.count}টি ${label} রিকোয়েস্ট`
      });
    }

    if (signals.length) return await createFraudFlag(userId, signals);
    return null;
  } catch (err) {
    console.error('evaluateTransaction error (non-blocking):', err.message);
    return null;
  }
}

// ==================== ব্যর্থ লগইন রেকর্ড ও ব্রুট-ফোর্স শনাক্তকরণ ====================
async function recordFailedLogin(identifier, userId, ip, userAgent) {
  try {
    await pool.query(
      `INSERT INTO failed_login_attempts (identifier, user_id, ip, user_agent) VALUES ($1, $2, $3, $4)`,
      [identifier || null, userId || null, ip || null, userAgent || null]
    );
  } catch (e) {
    console.error('recordFailedLogin error (non-blocking):', e.message);
  }
}

// একই ইউজার (বা না মিললে একই IP) থেকে অল্প সময়ে বারবার ভুল লগইন
async function checkRepeatedFailedLogins(userId, ip) {
  const r = await pool.query(
    userId
      ? `SELECT COUNT(*) FROM failed_login_attempts WHERE (user_id = $1 OR ip = $2) AND created_at > NOW() - INTERVAL '${FAILED_LOGIN_WINDOW_MINUTES} minutes'`
      : `SELECT COUNT(*) FROM failed_login_attempts WHERE ip = $2 AND created_at > NOW() - INTERVAL '${FAILED_LOGIN_WINDOW_MINUTES} minutes'`,
    [userId || null, ip]
  );
  const count = parseInt(r.rows[0].count, 10);
  if (count < FAILED_LOGIN_THRESHOLD) return null;
  return { count, windowMinutes: FAILED_LOGIN_WINDOW_MINUTES, severe: count >= FAILED_LOGIN_SEVERE_THRESHOLD };
}

// অল্প সময়ে একই ইউজার একাধিক আলাদা IP থেকে লগইন করেছে কিনা
async function checkMultipleIpChanges(userId) {
  const r = await pool.query(
    `SELECT COUNT(DISTINCT ip) AS c FROM login_logs WHERE user_id = $1 AND ip IS NOT NULL AND created_at > NOW() - INTERVAL '${IP_CHANGE_WINDOW_HOURS} hours'`,
    [userId]
  );
  const count = parseInt(r.rows[0].c, 10);
  return count >= IP_CHANGE_THRESHOLD ? { count, windowHours: IP_CHANGE_WINDOW_HOURS } : null;
}

// অল্প সময়ে একই ইউজার একাধিক আলাদা ডিভাইস থেকে লগইন করেছে কিনা
async function checkMultipleDeviceChanges(userId) {
  const r = await pool.query(
    `SELECT COUNT(DISTINCT device_signature) AS c FROM login_logs WHERE user_id = $1 AND device_signature IS NOT NULL AND created_at > NOW() - INTERVAL '${DEVICE_CHANGE_WINDOW_HOURS} hours'`,
    [userId]
  );
  const count = parseInt(r.rows[0].c, 10);
  return count >= DEVICE_CHANGE_THRESHOLD ? { count, windowHours: DEVICE_CHANGE_WINDOW_HOURS } : null;
}

/**
 * লগইন ব্যর্থ হলে কল হয় (ভুল পাসওয়ার্ড/অস্তিত্বহীন অ্যাকাউন্ট)। কখনো লগইন ফ্লো ব্লক করে না।
 * userId জানা থাকলে (ইমেইল/ফোন মিলেছে কিন্তু পাসওয়ার্ড ভুল) নির্দিষ্ট অ্যাকাউন্টের বিরুদ্ধে ফ্ল্যাগ হয়,
 * নাহলে শুধু IP-ভিত্তিক ব্রুট-ফোর্স ট্র্যাক করা হয় (কোনো ফ্ল্যাগ তৈরি হয় না, শুধু রেকর্ড থাকে)।
 */
async function evaluateFailedLogin(identifier, userId, ip, userAgent) {
  try {
    await recordFailedLogin(identifier, userId, ip, userAgent);
    if (!userId) return null; // অস্তিত্বহীন অ্যাকাউন্টের বিরুদ্ধে ফ্ল্যাগ তৈরি করা হয় না, শুধু লগ থাকে

    const repeated = await checkRepeatedFailedLogins(userId, ip);
    if (!repeated) return null;

    const signals = [{
      type: repeated.severe ? 'repeated_failed_login_severe' : 'repeated_failed_login',
      relatedUsers: [], relatedCount: 0,
      description: `${repeated.windowMinutes} মিনিটে ${repeated.count}টি ব্যর্থ লগইন প্রচেষ্টা — সম্ভাব্য ব্রুট-ফোর্স`
    }];
    return await createFraudFlag(userId, signals);
  } catch (err) {
    console.error('evaluateFailedLogin error (non-blocking):', err.message);
    return null;
  }
}

/**
 * সফল লগইনের পর কল হয়। অস্বাভাবিক লগইন প্যাটার্ন (নতুন ডিভাইস + নতুন লোকেশন, ঘনঘন IP/ডিভাইস
 * পরিবর্তন) শনাক্ত করে। কখনো লগইন ফ্লো ব্লক করে না।
 */
async function evaluateLogin(userId, { ip, isNewDevice, location } = {}) {
  try {
    const signals = [];

    if (isNewDevice && location && location !== 'Unknown' && location !== 'Local/Unknown') {
      signals.push({
        type: 'unusual_login', relatedUsers: [], relatedCount: 0,
        description: `নতুন ডিভাইস থেকে অস্বাভাবিক লগইন — লোকেশন: ${location}, IP: ${ip}`
      });
    }

    const ipChange = await checkMultipleIpChanges(userId);
    if (ipChange) {
      signals.push({
        type: 'multiple_ip_change', relatedUsers: [], relatedCount: 0,
        description: `${ipChange.windowHours} ঘণ্টায় ${ipChange.count}টি আলাদা IP থেকে লগইন`
      });
    }

    const deviceChange = await checkMultipleDeviceChanges(userId);
    if (deviceChange) {
      signals.push({
        type: 'multiple_device_change', relatedUsers: [], relatedCount: 0,
        description: `${deviceChange.windowHours} ঘণ্টায় ${deviceChange.count}টি আলাদা ডিভাইস থেকে লগইন`
      });
    }

    if (signals.length) return await createFraudFlag(userId, signals);
    return null;
  } catch (err) {
    console.error('evaluateLogin error (non-blocking):', err.message);
    return null;
  }
}

async function getUserFraudStatus(userId) {
  const r = await pool.query(
    `SELECT * FROM fraud_flags WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  const flags = r.rows;
  const order = { high: 3, medium: 2, low: 1 };
  let currentRiskLevel = 'none';
  for (const f of flags) {
    if (f.status !== 'open') continue;
    if (!order[currentRiskLevel] || order[f.risk_level] > order[currentRiskLevel]) {
      currentRiskLevel = f.risk_level;
    }
  }
  return {
    currentRiskLevel,
    openCount: flags.filter(f => f.status === 'open').length,
    flags
  };
}

module.exports = {
  evaluateRegistration,
  evaluateTransaction,
  evaluateFailedLogin,
  evaluateLogin,
  getUserFraudStatus,
  logAdminAction
};
