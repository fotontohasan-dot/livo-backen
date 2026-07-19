const { pool } = require('../db');

const RAPID_WINDOW_MINUTES = 10;
const RAPID_REGISTRATION_THRESHOLD = 3; // একই IP থেকে ১০ মিনিটে ৩+ রেজিস্ট্রেশন
const RAPID_TX_THRESHOLD = 3;           // একই ইউজারের ১০ মিনিটে ৩+ ডিপোজিট/উইথড্র রিকোয়েস্ট

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
  const hasRapid = signals.some(s => s.type === 'rapid_registration' || s.type === 'rapid_transaction');
  const sharedSignalCount = signals.filter(s => s.type.startsWith('shared_')).length;

  if (maxRelated >= 3 || (hasRapid && sharedSignalCount > 0)) return 'high';
  if (maxRelated >= 1 || hasRapid) return 'medium';
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
  getUserFraudStatus,
  logAdminAction
};
