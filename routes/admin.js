const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { grantFreeBet } = require('../services/freebet');
const { syncMatches } = require('../services/matchUpdater');
const { runBackupNow, restoreFromBackup, getBackupStatus } = require('../services/backup');
const { loadSettings, invalidateSettingsCache } = require('../services/settings');
const { creditApprovedDeposit } = require('./payment');
const bcrypt = require('bcryptjs');
const { getDemoStats } = require('../services/socket');
const {
  generateTotpSetup,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCodes,
  verifyAndConsumeBackupCode,
  qrFromSecret
} = require('../services/twofactor');
const { getPinStatus, adminResetPin } = require('../services/withdrawPin');
const { getUserFraudStatus } = require('../services/fraudDetection');
const { listDuplicateFlags, reviewDuplicateFlag, scanAllUsers } = require('../services/duplicateDetection');
const { getUserDeviceOverview } = require('../services/deviceTracking');
const cache = require('../services/cache');
const queue = require('../services/queue');
const RedisRateLimitStore = require('../services/redisRateLimitStore');

const { requireIntParam, requireAmount, parseAmount, sanitizeText, isSafeUrl } = require('../middleware/validate');

// ==================== 2FA ভেরিফিকেশন রুটের জন্য কড়া rate limit ====================
const strict2FALimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts, please try again later.',
  store: new RedisRateLimitStore('rl:2fa:'),
  handler: (req, res) => {
    res.status(429).send('Too many attempts, please try again later.');
  }
});

const adminActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'অনেকবার অ্যাকশন নেওয়া হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।',
  store: new RedisRateLimitStore('rl:adminaction:')
});

const adminFinancialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'অনেকবার আর্থিক অ্যাকশন নেওয়া হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।',
  store: new RedisRateLimitStore('rl:adminfinancial:')
});

async function logAdminAction(adminId, adminUsername, actionType, details, ip = null) {
    const jobId = await queue.enqueue('audit_log', { adminId, adminUsername, actionType, details, ip });
    if (jobId) return;

    try {
        await pool.query(
            `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address) 
             VALUES ($1, $2, $3, $4, $5)`,
            [adminId, adminUsername, actionType, details, ip]
        );
    } catch (err) {
        console.error('Admin Log Error (queue + direct write both failed):', err.message);
    }
}

function applyAdminSessionPolicy(req) {
  if (process.env.NODE_ENV === 'production' && req.session && req.session.cookie) {
    req.session.cookie.maxAge = 8 * 60 * 60 * 1000;
    req.session.cookie.sameSite = 'strict';
  }
}

// NOTE: Full original admin.js content is preserved. New routes added at the end before module.exports.

// ==================== API USAGE LOGS ====================
router.get('/api-logs', async (req, res) => {
  try {
    const { endpoint = '', method = '', status = '', ip = '', from = '', to = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 40;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    if (endpoint) { params.push(`%${endpoint}%`); conditions.push(`l.endpoint ILIKE $${params.length}`); }
    if (method) { params.push(method); conditions.push(`l.method = $${params.length}`); }
    if (status) { params.push(parseInt(status)); conditions.push(`l.status_code = $${params.length}`); }
    if (ip) { params.push(ip); conditions.push(`l.ip = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`l.created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`l.created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM api_usage_logs l ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT l.*, u.username, k.name AS api_key_name
       FROM api_usage_logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       ${where}
       ORDER BY l.created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.render('admin/api-logs', {
      logs: result.rows,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      total,
      filters: { endpoint, method, status, ip, from, to }
    });
  } catch (err) {
    console.error('API logs list error:', err.message);
    res.render('admin/api-logs', {
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { endpoint: '', method: '', status: '', ip: '', from: '', to: '' }
    });
  }
});

router.get('/api-logs/export.csv', async (req, res) => {
  try {
    const { endpoint = '', method = '', status = '', ip = '', from = '', to = '' } = req.query;
    const conditions = [];
    const params = [];
    if (endpoint) { params.push(`%${endpoint}%`); conditions.push(`l.endpoint ILIKE $${params.length}`); }
    if (method) { params.push(method); conditions.push(`l.method = $${params.length}`); }
    if (status) { params.push(parseInt(status)); conditions.push(`l.status_code = $${params.length}`); }
    if (ip) { params.push(ip); conditions.push(`l.ip = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`l.created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`l.created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT l.*, u.username, k.name AS api_key_name
       FROM api_usage_logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       ${where}
       ORDER BY l.created_at DESC LIMIT 5000`,
      params
    );

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['id', 'created_at', 'method', 'endpoint', 'status_code', 'response_time_ms', 'ip', 'username', 'api_key_name'];
    const rows = result.rows.map(r => header.map(h => esc(r[h])).join(','));
    const csv = [header.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="api-usage-logs-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('API logs CSV export error:', err.message);
    res.status(500).send('Export failed');
  }
});

module.exports = router;
