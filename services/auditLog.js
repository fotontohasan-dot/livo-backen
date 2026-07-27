// services/auditLog.js
// ---------------------------------------------------------------------------
// Unified Logging Service — Admin, Login, Error, Withdraw-PIN, Failed-Login,
// Bot, Fraud, Duplicate-Account, Cron, Security — সব ক্যাটাগরির লগ এখানে একটা
// একক audit_logs টেবিলে জমা হয়, যাতে অ্যাডমিন প্যানেল থেকে একসাথে সার্চ/ফিল্টার/
// এক্সপোর্ট করা যায়।
//
// Backward Compatibility নীতি: বিদ্যমান কোনো Log Table (admin_logs, login_logs,
// error_logs, withdraw_pin_logs, failed_login_attempts, bot_activity_logs,
// fraud_flags, duplicate_account_flags) থেকে ডেটা সরানো বা তাদের schema পরিবর্তন
// করা হয়নি — যেসব admin পেজ এখনো সরাসরি সেই টেবিল পড়ে (Activity Log, Login History,
// Fraud Logs, Bot Logs ইত্যাদি) সেগুলো আগের মতোই কাজ করবে। এই ফাইল শুধু ADDITIONAL
// ভাবে সেই একই ইভেন্ট audit_logs-এও লেখে (dual-write), কোথাও পুরনো insert সরানো হয়নি।
//
// Duplicate Logic Consolidation: admin_logs-এ লেখার জন্য আগে ৪টা আলাদা প্রায়-অভিন্ন
// ফাংশন ছিল (routes/admin.js-এর লোকাল logAdminAction, routes/auth.js-এর
// logSystemEvent, services/fraudDetection.js-এর logAdminAction, services/queue/
// workers.js-এর raw INSERT) — এখন সবগুলো এই ফাইলের logAdminAction()-কে কল করে,
// প্রতিটার বাইরের ফাংশন-সিগনেচার অপরিবর্তিত রেখে (তাই কোনো কল-সাইট বদলাতে হয়নি)।
// ---------------------------------------------------------------------------

const { pool } = require('../db');

const VALID_CATEGORIES = ['admin', 'login', 'error', 'withdraw_pin', 'failed_login', 'bot', 'fraud', 'duplicate_account', 'cron', 'security', 'other'];
const VALID_SEVERITIES = ['info', 'warning', 'critical'];

/** কেন্দ্রীয় একক ফাংশন — সব ক্যাটাগরির লগ এই ফাংশন দিয়েই audit_logs-এ যায়। */
async function logEvent({
  category, severity = 'info', actorType = 'system', actorId = null, actorUsername = null,
  ip = null, device = null, action, resourceType = null, resourceId = null, metadata = null,
  legacySource = null, legacyId = null
}) {
  try {
    const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'other';
    const safeSeverity = VALID_SEVERITIES.includes(severity) ? severity : 'info';
    await pool.query(
      `INSERT INTO audit_logs
        (category, severity, actor_type, actor_id, actor_username, ip_address, device_info, action, resource_type, resource_id, metadata, legacy_source, legacy_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (legacy_source, legacy_id) DO NOTHING`,
      [
        safeCategory, safeSeverity, actorType || 'system', actorId, actorUsername,
        ip, device, action || 'UNKNOWN_ACTION', resourceType, resourceId ? String(resourceId) : null,
        metadata ? JSON.stringify(metadata) : null, legacySource, legacyId
      ]
    );
  } catch (err) {
    // লগিং কখনো মূল ফিচার ব্লক করবে না — ব্যর্থ হলে শুধু কনসোলে জানানো হয়
    console.error('auditLog.logEvent error (non-blocking):', err.message);
  }
}

/** ==================== Admin Activity (একক শেয়ার্ড উৎস) ====================
 *  routes/admin.js, routes/auth.js, services/fraudDetection.js, services/botDetection.js,
 *  services/duplicateDetection.js, services/queue/workers.js — সবাই এই একটা ফাংশন কল করে।
 *  আগের 4-জায়গার duplicate raw-INSERT সরিয়ে এখানে একত্রিত করা হয়েছে। admin_logs-এ
 *  আগের মতোই লেখা হয় (backward compatible), সাথে audit_logs-এও যোগ হয়। */
async function logAdminAction(adminId, adminUsername, actionType, details, ip = null) {
  try {
    const r = await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [adminId, adminUsername, actionType, details, ip]
    );
    const row = r.rows[0];
    await logEvent({
      category: 'admin',
      severity: 'info',
      actorType: (adminUsername === 'SYSTEM' || adminId === null) ? 'system' : 'admin',
      actorId: adminId,
      actorUsername: adminUsername,
      ip,
      action: actionType,
      metadata: { details },
      legacySource: 'admin_logs',
      legacyId: row ? row.id : null
    });
  } catch (err) {
    console.error('logAdminAction error (non-blocking):', err.message);
  }
}

/** ==================== Login ==================== */
async function logLogin({ userId, ip, userAgent, deviceFingerprint = null, metadata = {}, legacyId = null }) {
  await logEvent({
    category: 'login', severity: 'info', actorType: 'user', actorId: userId,
    ip, device: userAgent, action: 'USER_LOGIN', metadata, legacySource: 'login_logs', legacyId
  });
}

/** ==================== Error ==================== */
async function logError({ userId = null, url = null, method = null, message, metadata = {}, legacyId = null }) {
  await logEvent({
    category: 'error', severity: 'critical', actorType: 'system', actorId: userId,
    action: 'UNHANDLED_ERROR', resourceType: url, metadata: { message, method, ...metadata },
    legacySource: 'error_logs', legacyId
  });
}

/** ==================== Withdraw PIN ==================== */
async function logWithdrawPin({ userId, actionType, actorType = 'user', actorId = null, actorUsername = null, ip = null, legacyId = null }) {
  await logEvent({
    category: 'security', severity: 'warning', actorType, actorId, actorUsername, ip,
    action: actionType, resourceType: 'withdraw_pin', resourceId: userId,
    legacySource: 'withdraw_pin_logs', legacyId
  });
}

/** ==================== Failed Login ==================== */
async function logFailedLogin({ userId = null, ip = null, userAgent = null, identifier = null, legacyId = null }) {
  await logEvent({
    category: 'failed_login', severity: 'warning', actorType: 'user', actorId: userId,
    ip, device: userAgent, action: 'FAILED_LOGIN_ATTEMPT', metadata: { identifier },
    legacySource: 'failed_login_attempts', legacyId
  });
}

/** ==================== Bot Activity ==================== */
/** ==================== Rate-Limit / API Abuse Logging ====================
 *  যেকোনো rate limiter 429 রিটার্ন করলে এখানে কল হয় (middleware/rateLimitFactory.js থেকে)।
 *  একই IP অল্প সময়ে বারবার লিমিটে ধরা পড়লে severity স্বয়ংক্রিয়ভাবে বেড়ে যায়
 *  (একবার = সাধারণ ট্রাফিক স্পাইক হতে পারে, বারবার = সম্ভাব্য abuse/আক্রমণ)। */
async function logRateLimitExceeded({ ip, userId = null, path, method, limiterName, userAgent = null }) {
  try {
    let severity = 'warning';
    if (ip) {
      const r = await pool.query(
        `SELECT COUNT(*) FROM audit_logs
         WHERE category = 'security' AND action = 'RATE_LIMIT_EXCEEDED'
           AND ip_address = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [ip]
      );
      const recentCount = parseInt(r.rows[0].count, 10);
      if (recentCount >= 10) severity = 'critical';
    }
    await logEvent({
      category: 'security',
      severity,
      actorType: userId ? 'user' : 'system',
      actorId: userId,
      ip,
      device: userAgent,
      action: 'RATE_LIMIT_EXCEEDED',
      resourceType: 'route',
      resourceId: path,
      metadata: { method, limiter: limiterName }
    });
  } catch (err) {
    console.error('logRateLimitExceeded error (non-blocking):', err.message);
  }
}

function riskToSeverity(riskLevel) {
  if (riskLevel === 'high') return 'critical';
  if (riskLevel === 'medium') return 'warning';
  return 'info';
}
async function logBotActivity({ ip, userId = null, endpoint, riskLevel, reason, userAgent, blocked, signalTypes = [], legacyId = null }) {
  await logEvent({
    category: 'bot', severity: riskToSeverity(riskLevel), actorType: 'system', actorId: userId,
    ip, device: userAgent, action: 'BOT_ACTIVITY_DETECTED', resourceType: endpoint,
    metadata: { signalTypes, reason, blocked }, legacySource: 'bot_activity_logs', legacyId
  });
}

/** ==================== Fraud Flags ==================== */
async function logFraudFlag({ userId, riskLevel, reason, signalTypes = [], flagId = null, legacyId = null }) {
  await logEvent({
    category: 'fraud', severity: riskToSeverity(riskLevel), actorType: 'system', actorId: userId,
    action: 'FRAUD_FLAG_CREATED', resourceType: 'fraud_flags', resourceId: flagId,
    metadata: { signalTypes, reason }, legacySource: 'fraud_flags', legacyId
  });
}

/** ==================== Duplicate Account Flags ==================== */
async function logDuplicateAccountFlag({ userId, riskScore, reason, matchTypes = [], flagId = null, legacyId = null }) {
  const severity = riskScore >= 70 ? 'critical' : riskScore >= 40 ? 'warning' : 'info';
  await logEvent({
    category: 'duplicate_account', severity, actorType: 'system', actorId: userId,
    action: 'DUPLICATE_ACCOUNT_DETECTED', resourceType: 'duplicate_account_flags', resourceId: flagId,
    metadata: { matchTypes, riskScore, reason }, legacySource: 'duplicate_account_flags', legacyId
  });
}

/** ==================== Unified Admin Log Viewer — Query Helpers ==================== */
async function listAuditLogs({
  category = null, severity = null, actorType = null, actorId = null, search = null,
  dateFrom = null, dateTo = null, page = 1, limit = 50
} = {}) {
  const conditions = [];
  const params = [];

  if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
  if (severity) { params.push(severity); conditions.push(`severity = $${params.length}`); }
  if (actorType) { params.push(actorType); conditions.push(`actor_type = $${params.length}`); }
  if (actorId) { params.push(actorId); conditions.push(`actor_id = $${params.length}`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`created_at >= $${params.length}::date`); }
  if (dateTo) { params.push(dateTo); conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(action ILIKE $${params.length} OR actor_username ILIKE $${params.length} OR ip_address ILIKE $${params.length} OR metadata::text ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (Math.max(1, page) - 1) * limit;

  const countRes = await pool.query(`SELECT COUNT(*) FROM audit_logs ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  const listParams = [...params, limit, offset];
  const rowsRes = await pool.query(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );

  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** CSV Export-এর জন্য — সীমাহীন pagination (সর্বোচ্চ 50,000 রো, সার্ভার সুরক্ষার জন্য) */
async function exportAuditLogsCsv(filters = {}) {
  const { rows } = await listAuditLogs({ ...filters, page: 1, limit: 50000 });
  const header = ['id', 'category', 'severity', 'actor_type', 'actor_id', 'actor_username', 'ip_address', 'device_info', 'action', 'resource_type', 'resource_id', 'metadata', 'created_at'];
  const escapeCsv = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map(h => escapeCsv(row[h])).join(','));
  }
  return lines.join('\n');
}

async function getCategoryCounts() {
  const r = await pool.query(`SELECT category, COUNT(*) AS c FROM audit_logs GROUP BY category ORDER BY c DESC`);
  return r.rows.map(row => ({ category: row.category, count: parseInt(row.c, 10) }));
}

async function getSeverityCounts() {
  const r = await pool.query(`SELECT severity, COUNT(*) AS c FROM audit_logs GROUP BY severity ORDER BY c DESC`);
  return r.rows.map(row => ({ severity: row.severity, count: parseInt(row.c, 10) }));
}

module.exports = {
  logEvent,
  logAdminAction,
  logLogin,
  logError,
  logWithdrawPin,
  logFailedLogin,
  logBotActivity,
  logFraudFlag,
  logDuplicateAccountFlag,
  logRateLimitExceeded,
  listAuditLogs,
  exportAuditLogsCsv,
  getCategoryCounts,
  getSeverityCounts,
  VALID_CATEGORIES,
  VALID_SEVERITIES
};
