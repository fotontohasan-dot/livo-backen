// services/auditLog.js
// Advanced Audit Log System — User/Admin/System-এর সব গুরুত্বপূর্ণ action (Login, Logout, Deposit,
// Withdraw, API, Settings Change, Role Change, Security Event, Maintenance, Backup, Restore, Cron,
// Queue, Cache) এখানে সমৃদ্ধ মেটাডেটাসহ (IP, Device, Browser, Location, Request ID, Risk Level) সংরক্ষিত হয়।
//
// এটা বিদ্যমান admin_logs টেবিলকে প্রতিস্থাপন করে না — সেটা যেভাবে আছে সেভাবেই চলতে থাকবে
// (কোনো ফিচার ভাঙে না)। এই সার্ভিস সম্পূর্ণ নতুন, বিস্তারিত audit_logs টেবিলে লেখে।
//
// ডিজাইন নীতি: logEvent() কখনো throw করে না এবং caller-এর ফ্লো কখনো ব্লক করে না —
// ব্যর্থ হলে শুধু console.error করে চুপচাপ এগিয়ে যায়।

const { pool } = require('../db');

const VALID_CATEGORIES = ['auth', 'financial', 'settings', 'role', 'security', 'maintenance', 'backup', 'restore', 'cron', 'queue', 'cache', 'api', 'other'];
const VALID_RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

// ==================== Legacy admin_logs writer ====================
// এটা services/fraudDetection.js, services/deviceTracking.js, services/botDetection.js,
// routes/profile.js, routes/admin.js (backup/restore) সহ অনেক জায়গা থেকে ইমপোর্ট করা হয় —
// আগে এই ফাইলে এক্সপোর্ট করা ছিল না (undefined ছিল), যার ফলে প্রতিটা `await logAdminAction(...)`
// কল (যেগুলো .catch() দিয়ে গার্ড করা ছিল না, যেমন পাসওয়ার্ড/PIN পরিবর্তন) throw করে পুরো
// অ্যাকশনকে ব্যর্থ হিসেবে দেখাত, যদিও মূল ডেটা-পরিবর্তন ইতিমধ্যে সফল হয়ে গিয়েছিল।
async function logAdminAction(adminId, adminUsername, actionType, details, ip = null) {
  try {
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, adminUsername, actionType, details, ip]
    );
  } catch (err) {
    console.error('Admin Log Error:', err.message);
  }
  try {
    require('../queues').enqueueActivityLog({ userId: adminId, username: adminUsername, actionType, details, ip }).catch(() => {});
  } catch (e) { /* queue মডিউল লোড না হলেও সমস্যা নেই */ }
}

/**
 * একটা audit event রেকর্ড করে।
 * req দেওয়া থাকলে IP/ডিভাইস/ব্রাউজার/OS/লোকেশন/রিকোয়েস্ট-ID স্বয়ংক্রিয়ভাবে বের করা হয়;
 * ব্যাকগ্রাউন্ড জব/ক্রন/সিস্টেম ইভেন্টের ক্ষেত্রে req না থাকলে সেসব ফিল্ড খালি থাকে।
 *
 * @param {Object} opts
 * @param {Object} [opts.req] - Express request object (ঐচ্ছিক, থাকলে IP/device/location/requestId অটো-এক্সট্র্যাক্ট হয়)
 * @param {'user'|'admin'|'system'} [opts.actorType='system']
 * @param {number|null} [opts.actorId]
 * @param {string} [opts.actorUsername='SYSTEM']
 * @param {string} opts.action - যেমন 'LOGIN', 'DEPOSIT_REQUESTED', 'SETTINGS_CHANGED'
 * @param {string} [opts.category='other']
 * @param {'success'|'failure'} [opts.status='success']
 * @param {'low'|'medium'|'high'|'critical'} [opts.riskLevel='low']
 * @param {Object} [opts.details={}] - অতিরিক্ত প্রসঙ্গ (JSON)
 */
// ==================== PHASE 14: details redaction ====================
// audit_logs স্থায়ী রেকর্ড, তাই এতে কখনো password, TOTP secret, session cookie,
// API/bot token বা payment secret যাওয়া চলবে না। বর্তমান caller গুলো সতর্ক,
// কিন্তু কোনো নতুন caller ভুল করে req.body পাঠিয়ে দিলে সেই গোপন তথ্য চিরকাল
// সংরক্ষিত থেকে যাবে। তাই লেখার ঠিক আগে একটি redaction পাস।
const SENSITIVE_KEY_RE = /(pass(word|wd)?|secret|token|otp|totp|cookie|authorization|api[_-]?key|private[_-]?key|cvv|pin|backup[_-]?code)/i;

// token-সদৃশ দীর্ঘ মান (bot token, JWT, PAT) মান দেখেও ধরা হয়
const TOKEN_VALUE_RE = /(\b\d{8,10}:AA[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9-]{20,})/;

const REDACTED = '[REDACTED]';
const MAX_REDACT_DEPTH = 6;

function redactDetails(value, depth = 0) {
  if (depth > MAX_REDACT_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return TOKEN_VALUE_RE.test(value) ? REDACTED : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactDetails(v, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactDetails(v, depth + 1);
    }
    return out;
  }
  return REDACTED; // function/symbol কখনো সংরক্ষণ করা হয় না
}

async function logEvent(opts) {
  try {
    const {
      req, actorType = 'system', actorId = null, actorUsername = 'SYSTEM',
      action, category = 'other', status = 'success', riskLevel = 'low', details = {}
    } = opts || {};

    if (!action) {
      console.error('[auditLog] logEvent called without required "action" field — skipped');
      return null;
    }

    const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'other';
    const safeRisk = VALID_RISK_LEVELS.includes(riskLevel) ? riskLevel : 'low';
    const safeStatus = status === 'failure' ? 'failure' : 'success';

    let ip = null, deviceName = null, browser = null, os = null, location = null, requestId = null;
    if (req) {
      try {
        const { parseUserAgent, extractIp, lookupLocation, buildDeviceName } = require('./deviceTracking');
        ip = extractIp(req);
        const ua = req.get ? req.get('user-agent') : (req.headers && req.headers['user-agent']);
        const parsed = parseUserAgent(ua || '');
        browser = parsed.browser;
        os = parsed.os;
        deviceName = buildDeviceName(parsed);
        location = lookupLocation(ip);
        requestId = req.requestId || null;
      } catch (e) {
        console.error('[auditLog] request metadata extraction error (non-blocking):', e.message);
      }
    }

    const result = await pool.query(
      `INSERT INTO audit_logs
        (actor_type, actor_id, actor_username, action, category, status, risk_level, details, ip_address, device_name, browser, os, location, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [actorType, actorId, actorUsername, action, safeCategory, safeStatus, safeRisk, JSON.stringify(redactDetails(details || {})), ip, deviceName, browser, os, location, requestId]
    );
    return result.rows[0]?.id || null;
  } catch (err) {
    console.error('[auditLog] logEvent error (non-blocking):', err.message);
    return null;
  }
}

/** ফিল্টার + পেজিনেশনসহ audit log তালিকা — অ্যাডমিন ড্যাশবোর্ড/সার্চ/এক্সপোর্ট সবার জন্য একই কোয়েরি-বিল্ডার ব্যবহার হয়। */
function buildFilterQuery(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.q) {
    params.push(`%${filters.q}%`);
    conditions.push(`(actor_username ILIKE $${params.length} OR action ILIKE $${params.length} OR details::text ILIKE $${params.length})`);
  }
  if (filters.actorType) { params.push(filters.actorType); conditions.push(`actor_type = $${params.length}`); }
  if (filters.category) { params.push(filters.category); conditions.push(`category = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
  if (filters.riskLevel) { params.push(filters.riskLevel); conditions.push(`risk_level = $${params.length}`); }
  if (filters.actorId) { params.push(filters.actorId); conditions.push(`actor_id = $${params.length}`); }
  if (filters.action) { params.push(`%${filters.action}%`); conditions.push(`action ILIKE $${params.length}`); }
  if (filters.from) { params.push(filters.from); conditions.push(`created_at >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); conditions.push(`created_at <= $${params.length}::date + INTERVAL '1 day'`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

async function listAuditLogs(filters = {}, { page = 1, limit = 25 } = {}) {
  const { where, params } = buildFilterQuery(filters);
  const offset = (page - 1) * limit;

  const countRes = await pool.query(`SELECT COUNT(*) FROM audit_logs ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  const listParams = [...params, limit, offset];
  const rowsRes = await pool.query(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );

  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function getAuditLogById(id) {
  const r = await pool.query(`SELECT * FROM audit_logs WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

/** এক্সপোর্টের জন্য (CSV/Excel) — সর্বোচ্চ ৫০০০ রো, ফিল্টার প্রযোজ্য */
async function exportAuditLogs(filters = {}) {
  const { where, params } = buildFilterQuery(filters);
  const r = await pool.query(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT 5000`, params);
  return r.rows;
}

async function getCategoryCounts() {
  const r = await pool.query(`SELECT category, COUNT(*) AS c FROM audit_logs GROUP BY category ORDER BY c DESC`);
  return r.rows.map(row => ({ category: row.category, count: parseInt(row.c, 10) }));
}

async function getRiskCounts() {
  const r = await pool.query(`SELECT risk_level, COUNT(*) AS c FROM audit_logs GROUP BY risk_level`);
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  r.rows.forEach(row => { counts[row.risk_level] = parseInt(row.c, 10); });
  return counts;
}

module.exports = {
  logEvent,
  redactDetails,
  logAdminAction,
  listAuditLogs,
  getAuditLogById,
  exportAuditLogs,
  getCategoryCounts,
  getRiskCounts,
  VALID_CATEGORIES,
  VALID_RISK_LEVELS
};
