const express = require('express');
const router = express.Router();

router.get('/api/analytics', async (req, res) => {
  try {
    const days  = Math.min(90, Math.max(1, parseInt(req.query.days) || 14));
    const interval = `${days} days`;

    const [revenue, userGrowth, betStats, topUsers, kycSummary, queueH] = await Promise.all([
      pool.query(`
        SELECT d::date AS day,
          COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='deposit'  AND status='approved' AND created_at::date=d::date),0) AS deposit,
          COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='withdraw' AND status='approved' AND created_at::date=d::date),0) AS withdraw
        FROM generate_series(CURRENT_DATE - INTERVAL '${interval}', CURRENT_DATE, INTERVAL '1 day') d ORDER BY day
      `),
      pool.query(`
        SELECT d::date AS day,
          COALESCE((SELECT COUNT(*) FROM users WHERE created_at::date=d::date),0) AS new_users
        FROM generate_series(CURRENT_DATE - INTERVAL '${interval}', CURRENT_DATE, INTERVAL '1 day') d ORDER BY day
      `),
      pool.query(`
        SELECT d::date AS day,
          COALESCE((SELECT COUNT(*) FROM bets WHERE created_at::date=d::date),0) AS cnt,
          COALESCE((SELECT SUM(stake) FROM bets WHERE created_at::date=d::date),0) AS staked
        FROM generate_series(CURRENT_DATE - INTERVAL '${interval}', CURRENT_DATE, INTERVAL '1 day') d ORDER BY day
      `),
      pool.query(`
        SELECT u.username, SUM(pr.amount) AS total FROM payment_requests pr
        JOIN users u ON pr.user_id=u.id
        WHERE pr.type='deposit' AND pr.status='approved' AND pr.created_at > NOW()-INTERVAL '${interval}'
        GROUP BY u.username ORDER BY total DESC LIMIT 10
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE kyc_status='pending')  AS pending,
          COUNT(*) FILTER (WHERE kyc_status='approved') AS approved,
          COUNT(*) FILTER (WHERE kyc_status='rejected') AS rejected
        FROM users WHERE kyc_status IS NOT NULL
      `).catch(() => ({ rows: [{ pending:0, approved:0, rejected:0 }] })),
      (async () => {
        try { const { getHealthSummary } = require('../services/queue/monitor'); return await getHealthSummary(); } catch(e) { return {}; }
      })()
    ]);

    res.json({
      days,
      revenue:    revenue.rows.map(r => ({ day: r.day, deposit: Number(r.deposit), withdraw: Number(r.withdraw), net: Number(r.deposit) - Number(r.withdraw) })),
      userGrowth: userGrowth.rows.map(r => ({ day: r.day, count: parseInt(r.new_users) })),
      betStats:   betStats.rows.map(r => ({ day: r.day, cnt: parseInt(r.cnt), staked: Number(r.staked) })),
      topDepositors: topUsers.rows,
      kycSummary: kycSummary.rows[0],
      queueHealth: queueH
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { grantFreeBet } = require('../services/freebet');
const { syncMatches } = require('../services/matchUpdater');
const { runBackupNow, restoreFromBackup, getBackupStatus } = require('../services/backup');
const { loadSettings, invalidateSettingsCache } = require('../services/settings');
const { creditApprovedDeposit } = require('./payment');
const { emitToUser, notifyUser, broadcastToAllUsers, notifyAdmins } = require('../services/notify');
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
const { getUserFraudStatus, getFraudDashboardStats } = require('../services/fraudDetection');
const { logEvent: logAuditEvent, listAuditLogs, getAuditLogById, exportAuditLogs, getCategoryCounts, getRiskCounts, VALID_CATEGORIES, VALID_RISK_LEVELS } = require('../services/auditLog');
const { listDuplicateFlags, reviewDuplicateFlag, scanAllUsers } = require('../services/duplicateDetection');
const { getUserDeviceOverview } = require('../services/deviceTracking');
const cache = require('../services/cache');
const cacheKeys = require('../services/cacheKeys');
const RedisRateLimitStore = require('../services/redisRateLimitStore');

const { requireIntParam, requireAmount, parseAmount, sanitizeText, isSafeUrl } = require('../middleware/validate');
const { listIpRules, setIpRule, removeIpRule } = require('../services/ipRules');
const rbac = require('../services/rbac');
const {
  listVipLevelsAdmin, upsertVipLevel, toggleVipLevelActive,
  getVipAnalytics, listAllRewardHistory, listAllUpgradeHistory
} = require('../services/vip');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // JSON import-এর জন্য, ২MB সীমা

// ==================== 2FA ভেরিফিকেশন রুটের জন্য কড়া rate limit ====================
// এই দুটো রুটে কোড অনুমান করে ব্রুট-ফোর্স করার ঝুঁকি থাকে, তাই আলাদা কড়া সীমা।
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

// সব অ্যাডমিন রুটে (login-এর বাইরে) সাধারণ কড়া সীমা — app.js-এর generalLimiter (300/15min,
// পুরো সাইটের জন্য) এর উপরে অতিরিক্ত স্তর, যেহেতু admin রুটগুলো সরাসরি DB write করে।
const adminActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'অনেকবার অ্যাকশন নেওয়া হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।',
  store: new RedisRateLimitStore('rl:adminaction:')
});

// টাকা/কয়েন সরাসরি নড়াচড়া করে এমন রুটে (approve/reject/coins add-remove) আরও কড়া সীমা —
// কম্প্রোমাইজড সেশন বা স্ক্রিপ্টেড অপব্যবহার হলেও ক্ষতির পরিমাণ সীমিত রাখতে।
const adminFinancialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'অনেকবার আর্থিক অ্যাকশন নেওয়া হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।',
  store: new RedisRateLimitStore('rl:adminfinancial:')
});

// ==================== ADMIN ACTIVITY LOG HELPER ====================
async function logAdminAction(adminId, adminUsername, actionType, details, ip = null) {
    // admin_logs কম-ভলিউম, তাই সরাসরি লেখা হয় (আগে এখানে পুরনো Postgres-queue দিয়ে যেত,
    // এখন BullMQ Activity Log Queue দিয়ে যায় — সাথে সরাসরি admin_logs-এও লেখা থাকে যাতে কখনো না হারায়)
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

// ==================== অ্যাডমিন সেশনের জন্য কড়া কুকি পলিসি ====================
// সাধারণ ইউজার সেশন থেকে আলাদা — অ্যাডমিন সেশন প্রোডাকশনে ৮ ঘণ্টা পর এক্সপায়ার হয়ে যাবে
// এবং sameSite=strict থাকবে (cross-site request-এ কুকি পাঠানো হবে না)।
function applyAdminSessionPolicy(req) {
  if (process.env.NODE_ENV === 'production' && req.session && req.session.cookie) {
    req.session.cookie.maxAge = 8 * 60 * 60 * 1000; // ৮ ঘণ্টা
    req.session.cookie.sameSite = 'strict';
  }
}

// ==================== ADMIN LOGIN ====================
router.get('/login', (req, res) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: null });
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: 'অনেকবার চেষ্টা করেছেন। ১৫ মিনিট পর আবার চেষ্টা করুন।',
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:adminlogin:')
});

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body;

  try {
    // ফর্মে "Username or Email" লেখা থাকলেও আগে শুধু username কলাম চেক হতো —
    // যেসব অ্যাডমিন ইমেইল দিয়ে লগইন করার চেষ্টা করতেন তাদের জন্য এটা সবসময় ব্যর্থ হতো।
    // এখন username অথবা email দুটোই মেলানো হচ্ছে (case-insensitive)।
    const result = await pool.query(
      `SELECT * FROM users
       WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))
         AND role = $2
       LIMIT 1`,
      [username, 'admin']
    );

    if (result.rows.length === 0) {
      return res.render('admin/login', { error: 'ইউজারনেম বা পাসওয়ার্ড ভুল' });
    }

    const admin = result.rows[0];
    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.render('admin/login', { error: 'ইউজারনেম বা পাসওয়ার্ড ভুল' });
    }

    // ==================== 2FA চালু থাকলে সরাসরি লগইন না করিয়ে ভেরিফিকেশন স্টেপে পাঠানো ====================
    if (admin.totp_enabled) {
      req.session.pending2FA = {
        id: admin.id,
        username: admin.username,
        role: admin.role
      };
      req.session.twoFAAttempts = 0;
      return res.redirect('/admin/login/2fa');
    }

    req.session.user = {
      id: admin.id,
      username: admin.username,
      role: admin.role
    };
    applyAdminSessionPolicy(req);
    logAdminAction(admin.id, admin.username, 'LOGIN', 'লগইন সম্পন্ন', req.ip);

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.render('admin/login', { error: 'সার্ভার এরর হয়েছে' });
  }
});

// ==================== লগইন-টাইম 2FA ভেরিফিকেশন ====================
router.get('/login/2fa', (req, res) => {
  if (!req.session.pending2FA) return res.redirect('/admin/login');
  res.render('admin/2fa-verify', { error: null, username: req.session.pending2FA.username });
});

router.post('/login/2fa', strict2FALimiter, async (req, res) => {
  const pending = req.session.pending2FA;
  if (!pending) return res.redirect('/admin/login');

  try {
    const { token, backupCode } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [pending.id]);
    const admin = result.rows[0];

    if (!admin || !admin.totp_enabled) {
      req.session.pending2FA = null;
      return res.redirect('/admin/login');
    }

    let ok = false;

    if (backupCode && backupCode.trim()) {
      const check = await verifyAndConsumeBackupCode(admin.totp_backup_codes, backupCode);
      if (check.valid) {
        ok = true;
        await pool.query('UPDATE users SET totp_backup_codes = $1 WHERE id = $2', [check.remainingJson, admin.id]);
      }
    } else if (token && token.trim()) {
      ok = verifyTotpToken(admin.totp_secret, token);
    }

    if (!ok) {
      req.session.twoFAAttempts = (req.session.twoFAAttempts || 0) + 1;
      if (req.session.twoFAAttempts >= 5) {
        req.session.pending2FA = null;
        return res.render('admin/login', { error: 'বারবার ভুল কোড — আবার লগইন করুন' });
      }
      return res.render('admin/2fa-verify', { error: 'কোডটি সঠিক নয়, আবার চেষ্টা করুন', username: pending.username });
    }

    req.session.user = { id: admin.id, username: admin.username, role: admin.role };
    req.session.pending2FA = null;
    req.session.twoFAAttempts = 0;
    applyAdminSessionPolicy(req);
    logAdminAction(admin.id, admin.username, 'LOGIN_2FA', '2FA দিয়ে লগইন সম্পন্ন', req.ip);
    res.redirect('/admin');
  } catch (err) {
    console.error('2FA verify error:', err.message);
    res.render('admin/2fa-verify', { error: 'সার্ভার এরর হয়েছে', username: pending.username });
  }
});

// ==================== ADMIN LOGOUT ====================
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ==================== সব রাউট প্রোটেক্টেড ====================
router.use(isAdmin);
router.use(adminActionLimiter);

// ==================== নোটিফিকেশন ব্যাজ কাউন্ট (বটম-নেভ) ====================
router.get('/api/notification-counts', async (req, res) => {
  try {
    const [deposits, withdrawals, chats] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM payment_requests WHERE type='deposit' AND status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM payment_requests WHERE type='withdraw' AND status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM chat_messages WHERE is_admin=false AND is_read=false`)
    ]);
    res.json({
      success: true,
      deposits: deposits.rows[0].c,
      withdrawals: withdrawals.rows[0].c,
      chats: chats.rows[0].c
    });
  } catch (err) {
    console.error('notification-counts error:', err.message);
    res.json({ success: false, deposits: 0, withdrawals: 0, chats: 0 });
  }
});

// ==================== 2FA সেটআপ (QR কোড) ====================
router.get('/2fa/setup', async (req, res) => {
  try {
    const result = await pool.query('SELECT totp_enabled FROM users WHERE id = $1', [req.session.user.id]);
    if (result.rows[0]?.totp_enabled) {
      return res.render('admin/2fa-setup', { alreadyEnabled: true, qrDataUrl: null, base32: null, error: null });
    }
    const setup = await generateTotpSetup(req.session.user.username);
    req.session.pending2FASetup = { base32: setup.base32 };
    res.render('admin/2fa-setup', {
      alreadyEnabled: false,
      qrDataUrl: setup.qrDataUrl,
      base32: setup.base32,
      error: null
    });
  } catch (err) {
    console.error('2fa/setup error:', err.message);
    res.render('admin/2fa-setup', { alreadyEnabled: false, qrDataUrl: null, base32: null, error: 'QR কোড তৈরি করতে সমস্যা হয়েছে' });
  }
});

router.post('/2fa/setup/verify', strict2FALimiter, async (req, res) => {
  try {
    const pendingSecret = req.session.pending2FASetup?.base32;
    const { token } = req.body;

    if (!pendingSecret) {
      return res.redirect('/admin/2fa/setup');
    }
    if (!verifyTotpToken(pendingSecret, token)) {
      const dataUrlAgain = await qrFromSecret(pendingSecret, req.session.user.username);
      return res.render('admin/2fa-setup', {
        alreadyEnabled: false, qrDataUrl: dataUrlAgain, base32: pendingSecret,
        error: 'কোডটি সঠিক নয়, আবার চেষ্টা করুন'
      });
    }

    const backupCodes = generateBackupCodes(8);
    const backupCodesJson = await hashBackupCodes(backupCodes);

    await pool.query(
      'UPDATE users SET totp_secret = $1, totp_enabled = true, totp_backup_codes = $2, backup_codes_viewed = false WHERE id = $3',
      [pendingSecret, backupCodesJson, req.session.user.id]
    );
    req.session.pending2FASetup = null;
    await logAdminAction(req.session.user.id, req.session.user.username, '2FA_ENABLED', '2FA চালু করা হয়েছে', req.ip);

    res.render('admin/2fa-backup-codes', { codes: backupCodes });
  } catch (err) {
    console.error('2fa/setup/verify error:', err.message);
    res.render('admin/2fa-setup', { alreadyEnabled: false, qrDataUrl: null, base32: null, error: 'সার্ভার এরর হয়েছে' });
  }
});

// ব্যাকআপ কোড দেখার পর অ্যাডমিন কনফার্ম করলে এই রুট হিট হয় — এরপর থেকে কোনো ভাবেই
// প্লেইনটেক্সট কোডগুলো আর দেখানো হয় না (DB-তে শুধু হ্যাশই থাকে, তাই এমনিতেও পুনরুদ্ধারযোগ্য না,
// এই ফ্ল্যাগটা শুধু স্পষ্টভাবে "দেখা হয়ে গেছে" ট্র্যাক ও অডিট করার জন্য)।
router.post('/2fa/backup-codes/acknowledge', async (req, res) => {
  try {
    await pool.query('UPDATE users SET backup_codes_viewed = true WHERE id = $1', [req.session.user.id]);
    res.redirect('/admin');
  } catch (err) {
    console.error('backup-codes acknowledge error:', err.message);
    res.redirect('/admin');
  }
});

router.post('/2fa/disable', async (req, res) => {
  try {
    const { password, token } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const admin = result.rows[0];

    const passOk = admin && await bcrypt.compare(password || '', admin.password);
    // TOTP কোড অথবা ব্যাকআপ কোড — যেকোনো একটা দিয়ে যাচাই করা যাবে
    let codeOk = admin && verifyTotpToken(admin.totp_secret, token);
    if (!codeOk && admin && admin.totp_backup_codes) {
      const backupCheck = await verifyAndConsumeBackupCode(admin.totp_backup_codes, token);
      if (backupCheck.valid) codeOk = true;
    }

    if (!passOk || !codeOk) {
      return res.render('admin/2fa-setup', {
        alreadyEnabled: true, qrDataUrl: null, base32: null,
        error: 'পাসওয়ার্ড অথবা 2FA কোড/ব্যাকআপ কোড সঠিক নয়'
      });
    }

    await pool.query(
      'UPDATE users SET totp_secret = NULL, totp_enabled = false, totp_backup_codes = NULL WHERE id = $1',
      [req.session.user.id]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, '2FA_DISABLED', '2FA বন্ধ করা হয়েছে', req.ip);
    res.redirect('/admin/settings');
  } catch (err) {
    console.error('2fa/disable error:', err.message);
    res.redirect('/admin/2fa/setup');
  }
});


// ==================== KYC ভেরিফিকেশন ====================
router.get('/kyc', async (req, res) => {
  try {
    const status = req.query.status || '';
    const q = req.query.q || '';
    const params = [];
    let query = `
      SELECT k.*, u.username, u.phone
      FROM kyc_requests k
      LEFT JOIN users u ON u.id = k.user_id
      WHERE 1=1
    `;
    if (status) {
      params.push(status);
      query += ` AND k.status = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (u.username ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR k.full_name ILIKE $${params.length})`;
    }
    query += ' ORDER BY k.created_at DESC LIMIT 200';

    const result = await pool.query(query, params);
    const statsRes = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
      FROM kyc_requests
    `);

    res.render('admin/kyc', {
      kycList: result.rows,
      stats: statsRes.rows[0],
      filters: { status, q }
    });
  } catch (err) {
    console.error('KYC list error:', err.message);
    res.render('admin/kyc', {
      kycList: [],
      stats: { total: 0, pending: 0, approved: 0, rejected: 0 },
      filters: { status: '', q: '' }
    });
  }
});

router.post('/kyc/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      "UPDATE kyc_requests SET status = 'approved', updated_at = NOW() WHERE id = $1 RETURNING user_id",
      [id]
    );
    if (r.rows[0]) {
      await pool.query("UPDATE users SET kyc_status = 'approved' WHERE id = $1", [r.rows[0].user_id]);
    }
    await logAdminAction(req.session.user.id, req.session.user.username, 'KYC_APPROVE', `KYC #${id} অনুমোদন করা হয়েছে`, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('KYC approve error:', err.message);
    res.status(500).json({ success: false, message: 'সার্ভার এরর' });
  }
});

router.post('/kyc/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const reason = (req.body && req.body.reason) || '';
    const r = await pool.query(
      "UPDATE kyc_requests SET status = 'rejected', reject_reason = $2, updated_at = NOW() WHERE id = $1 RETURNING user_id",
      [id, reason || null]
    );
    if (r.rows[0]) {
      await pool.query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [r.rows[0].user_id]);
    }
    await logAdminAction(req.session.user.id, req.session.user.username, 'KYC_REJECT', `KYC #${id} বাতিল করা হয়েছে। কারণ: ${reason}`, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('KYC reject error:', err.message);
    res.status(500).json({ success: false, message: 'সার্ভার এরর' });
  }
});

// ==================== সেটিংস ====================
const SETTING_KEYS = [
  'site_name', 'support_email', 'maintenance_mode', 'max_login_attempts',
  'min_bet', 'max_bet', 'turnover_multiplier', 'max_daily_bets',
  'deposit_commission_percent', 'withdraw_commission_percent', 'min_deposit', 'min_withdraw',
  'maintenance_message', 'maintenance_eta', 'maintenance_allowed_ips', 'maintenance_bypass_token',
  // ---- System Settings hub-এ যোগ হওয়া নতুন ক্যাটাগরি ---- (সব অ্যাক্টুয়াল secret .env-এই থাকে, এখানে শুধু non-secret কনফিগ)
  'site_tagline', 'support_phone',
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_from_name', 'smtp_from_email',
  'sms_provider', 'sms_sender_id',
  'payment_deposit_enabled', 'payment_withdraw_enabled', 'payment_gateway_live_mode',
  'api_public_enabled', 'api_rate_limit_per_15min',
  'upload_max_size_mb', 'upload_allowed_types',
  'session_idle_timeout_minutes',
  'default_language', 'default_timezone', 'default_currency'
];

router.get('/system-settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    settings.maintenance_mode = settings.maintenance_mode === 'true';
    settings.payment_deposit_enabled = settings.payment_deposit_enabled !== 'false';
    settings.payment_withdraw_enabled = settings.payment_withdraw_enabled !== 'false';
    settings.payment_gateway_live_mode = settings.payment_gateway_live_mode === 'true';
    settings.api_public_enabled = settings.api_public_enabled !== 'false';
    settings.smtp_secure = settings.smtp_secure !== 'false';

    res.render('admin/system-settings', {
      settings,
      redisConnected: cache.getStatus().connected,
      saved: req.query.saved === '1'
    });
  } catch (err) {
    console.error('System settings load error:', err && err.stack ? err.stack : err);
    res.render('admin/system-settings', { settings: {}, redisConnected: false, saved: false });
  }
});

router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    settings.maintenance_mode = settings.maintenance_mode === 'true';

    const adminsRes = await pool.query(
      "SELECT id, username, email, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC"
    );

    res.render('admin/settings', {
      settings,
      admins: adminsRes.rows,
      saved: req.query.saved === '1',
      saveError: req.query.error === '1'
    });
  } catch (err) {
    console.error('Settings load error:', err && err.stack ? err.stack : err);
    res.render('admin/settings', { settings: {}, admins: [], saved: false, saveError: false });
  }
});

router.post('/settings/update', async (req, res) => {
  try {
    // টগল করার আগের অবস্থা জেনে রাখা — যাতে ON/OFF কোন দিকে গেল সেটা স্পষ্টভাবে লগ করা যায়
    const prevRes = await pool.query("SELECT value FROM site_settings WHERE key = 'maintenance_mode'");
    const wasOn = prevRes.rows[0] && prevRes.rows[0].value === 'true';

    for (const key of SETTING_KEYS) {
      if (key === 'maintenance_mode') continue; // নিচে আলাদাভাবে সামলানো হচ্ছে
      if (!(key in req.body)) continue;
      let raw = req.body[key];
      if (Array.isArray(raw)) raw = raw[raw.length - 1];
      let value = raw === null || raw === undefined ? '' : String(raw);

      // মেইনটেন্যান্স মেসেজ ইউজার-facing পেজে (মেইনটেন্যান্স স্ক্রিন) সরাসরি দেখানো হয়,
      // তাই stored-XSS ঠেকাতে HTML স্ট্রিপ করে sanitize করা হচ্ছে
      if (key === 'maintenance_message') value = sanitizeText(value, { maxLen: 500 });
      // Allowed IP লিস্ট — শুধু বৈধ ফরম্যাটের এন্ট্রিগুলোই রাখা হচ্ছে (IPv4/IPv6, কমা/নিউলাইন দিয়ে আলাদা)
      if (key === 'maintenance_allowed_ips') {
        value = value
          .split(/[\s,]+/)
          .map(ip => ip.trim())
          .filter(ip => /^[0-9a-fA-F:.]+$/.test(ip))
          .join(',');
      }
      // Emergency bypass token — শুধু url-safe ক্যারেক্টার, বাড়তি স্পেস/HTML বাদ
      if (key === 'maintenance_bypass_token') value = value.trim().replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 128);

      await pool.query(
        `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }

    // চেকবক্স আনচেক থাকলে ব্রাউজার req.body-তে maintenance_mode ফিল্ডটাই পাঠায় না,
    // তাই এখানে সবসময় boolean-এ coerce করে explicit true/false লেখা হচ্ছে।
    let rawMaintenance = 'maintenance_mode' in req.body ? req.body.maintenance_mode : 'false';
    if (Array.isArray(rawMaintenance)) rawMaintenance = rawMaintenance[rawMaintenance.length - 1];
    const maintenanceBool = rawMaintenance === true || rawMaintenance === 'true' || rawMaintenance === 'on' || rawMaintenance === '1';

    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ('maintenance_mode', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(maintenanceBool)]
    );

    // এই দুটো ব্যর্থ হলেও সেটিংস তো সেভ হয়েই গেছে — তাই আলাদা try/catch দিয়ে
    // এদের এরর মূল সেভ অপারেশনকে ব্যর্থ দেখানো থেকে আটকানো হচ্ছে
    try {
      await invalidateSettingsCache();
      await loadSettings();
    } catch (e) {
      console.error('loadSettings() cache refresh failed (settings already saved):', e && e.stack ? e.stack : e);
    }
    try {
      if (maintenanceBool && !wasOn) {
        const msg = sanitizeText(req.body.maintenance_message || '', { maxLen: 200 });
        const eta = req.body.maintenance_eta ? String(req.body.maintenance_eta).slice(0, 100) : '';
        await logAdminAction(req.session.user.id, req.session.user.username, 'MAINTENANCE_ON',
          `মেইনটেন্যান্স মোড চালু করা হয়েছে${eta ? ' | আনুমানিক সময়: ' + eta : ''}${msg ? ' | বার্তা: ' + msg : ''}`, req.ip);
        logAuditEvent({
          req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
          action: 'MAINTENANCE_ENABLED', category: 'maintenance', status: 'success', riskLevel: 'high',
          details: { eta, message: msg }
        }).catch(e => console.error('logAuditEvent (MAINTENANCE_ENABLED) error:', e.message));
      } else if (!maintenanceBool && wasOn) {
        await logAdminAction(req.session.user.id, req.session.user.username, 'MAINTENANCE_OFF', 'মেইনটেন্যান্স মোড বন্ধ করা হয়েছে', req.ip);
        logAuditEvent({
          req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
          action: 'MAINTENANCE_DISABLED', category: 'maintenance', status: 'success', riskLevel: 'medium'
        }).catch(e => console.error('logAuditEvent (MAINTENANCE_DISABLED) error:', e.message));
      } else {
        await logAdminAction(req.session.user.id, req.session.user.username, 'SETTINGS_UPDATE', 'সাইট সেটিংস পরিবর্তন করা হয়েছে', req.ip);
        logAuditEvent({
          req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
          action: 'SETTINGS_CHANGED', category: 'settings', status: 'success', riskLevel: 'medium',
          details: { changedKeys: SETTING_KEYS.filter(k => k in req.body) }
        }).catch(e => console.error('logAuditEvent (SETTINGS_CHANGED) error:', e.message));
      }
    } catch (e) {
      console.error('logAdminAction failed (settings already saved):', e && e.stack ? e.stack : e);
    }

    return res.redirect(`${req.body.redirect_to === 'system-settings' ? '/admin/system-settings' : '/admin/settings'}?saved=1`);
  } catch (err) {
    console.error('Settings update error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.redirect(`${req.body.redirect_to === 'system-settings' ? '/admin/system-settings' : '/admin/settings'}?error=1`);
  }
});

router.post('/settings/admins/promote', async (req, res) => {
  try {
    const { username } = req.body;
    const r = await pool.query("UPDATE users SET role = 'admin' WHERE username = $1 RETURNING id", [username]);
    if (r.rows[0]) {
      await logAdminAction(req.session.user.id, req.session.user.username, 'ADMIN_PROMOTE', `${username} কে অ্যাডমিন করা হয়েছে`, req.ip);
      logAuditEvent({
        req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
        action: 'ROLE_CHANGED', category: 'role', status: 'success', riskLevel: 'high',
        details: { targetUserId: r.rows[0].id, targetUsername: username, newRole: 'admin' }
      }).catch(e => console.error('logAuditEvent (ROLE_CHANGED promote) error:', e.message));
    }
    res.redirect('/admin/settings');
  } catch (err) {
    console.error('Admin promote error:', err.message);
    res.redirect('/admin/settings');
  }
});

router.post('/settings/admins/:id/demote', async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.session.user.id) {
      return res.redirect('/admin/settings');
    }
    await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ADMIN_DEMOTE', `অ্যাডমিন আইডি #${id} থেকে অ্যাডমিন অ্যাক্সেস সরানো হয়েছে`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'ROLE_CHANGED', category: 'role', status: 'success', riskLevel: 'high',
      details: { targetUserId: id, newRole: 'user' }
    }).catch(e => console.error('logAuditEvent (ROLE_CHANGED demote) error:', e.message));
    res.redirect('/admin/settings');
  } catch (err) {
    console.error('Admin demote error:', err.message);
    res.redirect('/admin/settings');
  }
});

// ==================== NOTIFICATION BROADCAST ====================
router.get('/notifications', async (req, res) => {
  try {
    const history = await pool.query(
      `SELECT * FROM notification_broadcasts ORDER BY created_at DESC LIMIT 30`
    );
    const totalUsersRes = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    res.render('admin/notifications', {
      history: history.rows,
      totalUsers: parseInt(totalUsersRes.rows[0].cnt),
    });
  } catch (err) {
    console.error('notifications page error:', err.message);
    res.render('admin/notifications', { history: [], totalUsers: 0 });
  }
});

router.post('/notifications/broadcast', adminFinancialLimiter, async (req, res) => {
  try {
    const title = sanitizeText(req.body.title || '', { maxLen: 150 });
    const message = sanitizeText(req.body.message || '', { maxLen: 500 });
    const allowedTypes = ['announcement', 'system', 'info', 'success', 'error'];
    const type = allowedTypes.includes(req.body.type) ? req.body.type : 'announcement';

    if (!title || !message) {
      req.flash('error', 'শিরোনাম ও বার্তা দুটোই আবশ্যক');
      return res.redirect('/admin/notifications');
    }

    const recipientCount = await broadcastToAllUsers({ title, message, type });

    await pool.query(
      `INSERT INTO notification_broadcasts (admin_id, admin_username, title, message, type, recipient_count)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.session.user.id, req.session.user.username, title, message, type, recipientCount]
    );

    await logAdminAction(
      req.session.user.id, req.session.user.username, 'NOTIFICATION_BROADCAST',
      `সব ইউজারকে (${recipientCount} জন) ব্রডকাস্ট পাঠানো হয়েছে: "${title}"`, req.ip
    );

    req.flash('success', `✅ ${recipientCount} জন ইউজারকে নোটিফিকেশন পাঠানো হয়েছে!`);
    res.redirect('/admin/notifications');
  } catch (err) {
    console.error('broadcast error:', err.message);
    req.flash('error', 'ব্রডকাস্ট পাঠাতে সমস্যা হয়েছে');
    res.redirect('/admin/notifications');
  }
});

// ==================== DASHBOARD ====================
router.get('/dashboard', (req, res) => res.redirect('/admin'));

router.get('/api/demo-stats', async (req, res) => {
  try {
    const stats = await getDemoStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('demo stats api error:', err.message);
    res.status(500).json({ success: false });
  }
});

router.get('/', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalCoins = await pool.query('SELECT SUM(coins) as total FROM users');
    const activeUsersNow = await pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE last_login >= NOW() - INTERVAL '15 minutes'`);
    const matches = await pool.query('SELECT COUNT(*) as count FROM matches');
    const totalBets = await pool.query('SELECT COUNT(*) as count FROM bets');

    const recentMatchesRes = await pool.query(`SELECT * FROM matches ORDER BY start_time DESC LIMIT 8`);
    const recentUsersRes = await pool.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT 8`);

    const todayDeposit = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM payment_requests 
       WHERE type='deposit' AND status='approved' AND created_at::date = CURRENT_DATE`
    );
    const todayWithdraw = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM payment_requests 
       WHERE type='withdraw' AND status='approved' AND created_at::date = CURRENT_DATE`
    );
    const todayBets = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS total, COUNT(*) AS cnt FROM bets WHERE created_at::date = CURRENT_DATE`
    );
    const todayProfitLoss = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS staked,
              COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS paidout
       FROM bets WHERE created_at::date = CURRENT_DATE AND status IN ('won','lost')`
    );
    const yesterdayProfitLoss = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS staked,
              COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS paidout
       FROM bets WHERE created_at::date = CURRENT_DATE - INTERVAL '1 day' AND status IN ('won','lost')`
    );

    // ==== সর্বমোট (লাইফটাইম) ডিপোজিট/উইথড্র — ড্যাশবোর্ড কার্ডের আসল সংখ্যা ====
    const totalDepositAll = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE type='deposit' AND status='approved'`
    );
    const totalWithdrawAll = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE type='withdraw' AND status='approved'`
    );
    const newUsersToday = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE created_at::date = CURRENT_DATE`
    );

    // ==== পেন্ডিং অ্যাকশন — ডিপোজিট, উইথড্র, সাপোর্ট মেসেজ ====
    const pendingDeposits = await pool.query(
      `SELECT COUNT(*) AS cnt FROM payment_requests WHERE type='deposit' AND status='pending'`
    );
    const pendingWithdrawals = await pool.query(
      `SELECT COUNT(*) AS cnt FROM payment_requests WHERE type='withdraw' AND status='pending'`
    );
    const pendingSupport = await pool.query(
      `SELECT COUNT(DISTINCT sender_id) AS cnt FROM chat_messages WHERE is_admin=false AND is_read=false`
    );

    const revenueTrend = await pool.query(`
      SELECT d::date AS day,
        COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='deposit' AND status='approved' AND created_at::date = d::date),0) AS deposit,
        COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='withdraw' AND status='approved' AND created_at::date = d::date),0) AS withdraw
      FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
      ORDER BY day
    `);

    const userGrowth = await pool.query(`
      SELECT d::date AS day,
        COALESCE((SELECT COUNT(*) FROM users WHERE created_at::date = d::date),0) AS new_users
      FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
      ORDER BY day
    `);

    const recentBets = await pool.query(`
      SELECT b.*, u.username, m.team_a, m.team_b, m.title
      FROM bets b JOIN users u ON b.user_id = u.id LEFT JOIN matches m ON b.match_id = m.id
      ORDER BY b.created_at DESC LIMIT 8
    `);

    const recentDeposits = await pool.query(`
      SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id
      WHERE pr.type='deposit' ORDER BY pr.created_at DESC LIMIT 8
    `);

    const recentWithdrawals = await pool.query(`
      SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id
      WHERE pr.type='withdraw' ORDER BY pr.created_at DESC LIMIT 8
    `);

    // ==== সাম্প্রতিক অ্যাক্টিভিটি ফিড — ডিপোজিট, উইথড্র, বাজি একত্রে সময় অনুযায়ী ====
    const recentActivity = [
      ...recentDeposits.rows.map(r => ({
        kind: 'deposit', status: r.status, username: r.username,
        amount: Number(r.amount), created_at: r.created_at, ref: r.id
      })),
      ...recentWithdrawals.rows.map(r => ({
        kind: 'withdraw', status: r.status, username: r.username,
        amount: Number(r.amount), created_at: r.created_at, ref: r.id
      })),
      ...recentBets.rows.map(r => ({
        kind: 'bet', status: r.status, username: r.username,
        amount: Number(r.stake), created_at: r.created_at, ref: r.id,
        odd: r.odd, match: r.title || (r.team_a ? `${r.team_a} vs ${r.team_b}` : null)
      }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8);

    const suspicious = await pool.query(`
      SELECT last_ip, COUNT(*) AS cnt, ARRAY_AGG(username) AS usernames
      FROM users WHERE last_ip IS NOT NULL
      GROUP BY last_ip HAVING COUNT(*) > 1
      ORDER BY cnt DESC LIMIT 5
    `);

    // ==================== Fraud Detection Engine — ড্যাশবোর্ড Fraud Alerts উইজেট ====================
    const fraudCounts = await pool.query(`
      SELECT risk_level, COUNT(*) AS c FROM fraud_flags WHERE status = 'open' GROUP BY risk_level
    `);
    const fraudAlerts = { high: 0, medium: 0, low: 0 };
    fraudCounts.rows.forEach(r => { fraudAlerts[r.risk_level] = parseInt(r.c); });
    const recentFraudFlags = await pool.query(`
      SELECT f.*, u.username FROM fraud_flags f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.status = 'open' ORDER BY
        CASE f.risk_level WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, f.created_at DESC
      LIMIT 5
    `);

    // ==================== Duplicate Account Detection — ড্যাশবোর্ড উইজেট ====================
    const dupCounts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE risk_score >= 70) AS high,
        COUNT(*) FILTER (WHERE risk_score >= 40 AND risk_score < 70) AS medium,
        COUNT(*) FILTER (WHERE risk_score < 40) AS low
      FROM duplicate_account_flags WHERE status = 'open'
    `);
    const dupAlerts = {
      high: parseInt(dupCounts.rows[0].high) || 0,
      medium: parseInt(dupCounts.rows[0].medium) || 0,
      low: parseInt(dupCounts.rows[0].low) || 0
    };
    const recentDupFlags = await pool.query(`
      SELECT f.*, u.username FROM duplicate_account_flags f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.status = 'open' ORDER BY f.risk_score DESC, f.created_at DESC LIMIT 5
    `);

    const demoStats = await getDemoStats().catch(e => {
      console.error('demo stats error:', e.message);
      return { totalDemo: 0, userHeldDemo: 0, casinoDemoWagered: 0, sportsDemoWagered: 0 };
    });

    const bullHealth = await require('../queues').getQueueHealthStats().catch(() => ({ redisConnected: false, queues: [] }));
    const queueStatus = bullHealth.queues.reduce((acc, q) => ({
      pending: acc.pending + (q.counts.waiting || 0) + (q.counts.delayed || 0),
      processing: acc.processing + (q.counts.active || 0),
      completed: acc.completed + (q.counts.completed || 0),
      failed: acc.failed + (q.counts.failed || 0),
      running: bullHealth.redisConnected
    }), { pending: 0, processing: 0, completed: 0, failed: 0, running: bullHealth.redisConnected });

    res.render('admin/dashboard', {
      demoStats,
      redisStatus: cache.getStatus(),
      queueStatus,
      stats: {
        total_users: users.rows[0].count,
        total_coins_in_system: totalCoins.rows[0].total || 0,
        active_users: parseInt(activeUsersNow.rows[0].cnt),
        total_matches: matches.rows[0].count,
        total_predictions: totalBets.rows[0].count,
        today_deposit: Number(todayDeposit.rows[0].total),
        today_deposit_count: parseInt(todayDeposit.rows[0].cnt),
        today_withdraw: Number(todayWithdraw.rows[0].total),
        today_withdraw_count: parseInt(todayWithdraw.rows[0].cnt),
        today_bet_amount: Number(todayBets.rows[0].total),
        today_bet_count: parseInt(todayBets.rows[0].cnt),
        today_profit: Number(todayProfitLoss.rows[0].staked) - Number(todayProfitLoss.rows[0].paidout),
        yesterday_profit: Number(yesterdayProfitLoss.rows[0].staked) - Number(yesterdayProfitLoss.rows[0].paidout),
        total_deposit_all: Number(totalDepositAll.rows[0].total),
        total_withdraw_all: Number(totalWithdrawAll.rows[0].total),
        new_users_today: parseInt(newUsersToday.rows[0].cnt),
        active_users_now: parseInt(activeUsersNow.rows[0].cnt),
        pending_deposits: parseInt(pendingDeposits.rows[0].cnt),
        pending_withdrawals: parseInt(pendingWithdrawals.rows[0].cnt),
        pending_support: parseInt(pendingSupport.rows[0].cnt)
      },
      revenueTrend: revenueTrend.rows.map(r => ({
        day: r.day, deposit: Number(r.deposit), withdraw: Number(r.withdraw)
      })),
      userGrowth: userGrowth.rows.map(r => ({ day: r.day, count: parseInt(r.new_users) })),
      recentBets: recentBets.rows,
      recentDeposits: recentDeposits.rows,
      recentWithdrawals: recentWithdrawals.rows,
      recentActivity,
      recentMatches: recentMatchesRes.rows,
      recentUsers: recentUsersRes.rows,
      suspicious: suspicious.rows,
      fraudAlerts,
      recentFraudFlags: recentFraudFlags.rows,
      dupAlerts,
      recentDupFlags: recentDupFlags.rows
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', {
      demoStats: { totalDemo: 9999999, userHeldDemo: 0, casinoDemoWagered: 0, sportsDemoWagered: 0 },
      redisStatus: cache.getStatus(),
      queueStatus: { enabled: false, running: false, pending: 0, processing: 0, completed: 0, failed: 0 },
      stats: {}, revenueTrend: [], userGrowth: [], recentBets: [], recentDeposits: [], recentWithdrawals: [], recentActivity: [], recentMatches: [], recentUsers: [], suspicious: [],
      fraudAlerts: { high: 0, medium: 0, low: 0 }, recentFraudFlags: [],
      dupAlerts: { high: 0, medium: 0, low: 0 }, recentDupFlags: []
    });
  }
});

// ==================== ড্যাশবোর্ড লাইভ স্ট্যাটস (পোলিং API) ====================
router.get('/api/dashboard-stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalCoinsPoll = await pool.query('SELECT COALESCE(SUM(coins),0) AS total FROM users');
    const activeUsersPoll = await pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE last_login >= NOW() - INTERVAL '15 minutes'`);

    const todayDeposit = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests 
       WHERE type='deposit' AND status='approved' AND created_at::date = CURRENT_DATE`
    );
    const todayWithdraw = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests 
       WHERE type='withdraw' AND status='approved' AND created_at::date = CURRENT_DATE`
    );
    const todayProfitLoss = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS staked,
              COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS paidout
       FROM bets WHERE created_at::date = CURRENT_DATE AND status IN ('won','lost')`
    );
    const yesterdayProfitLoss = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS staked,
              COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS paidout
       FROM bets WHERE created_at::date = CURRENT_DATE - INTERVAL '1 day' AND status IN ('won','lost')`
    );
    const totalDepositAll = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE type='deposit' AND status='approved'`
    );
    const totalWithdrawAll = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE type='withdraw' AND status='approved'`
    );
    const newUsersToday = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE created_at::date = CURRENT_DATE`
    );
    const pendingDeposits = await pool.query(
      `SELECT COUNT(*) AS cnt FROM payment_requests WHERE type='deposit' AND status='pending'`
    );
    const pendingWithdrawals = await pool.query(
      `SELECT COUNT(*) AS cnt FROM payment_requests WHERE type='withdraw' AND status='pending'`
    );
    const pendingSupport = await pool.query(
      `SELECT COUNT(DISTINCT sender_id) AS cnt FROM chat_messages WHERE is_admin=false AND is_read=false`
    );

    const recentDeposits = await pool.query(`
      SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id
      WHERE pr.type='deposit' ORDER BY pr.created_at DESC LIMIT 8
    `);
    const recentWithdrawals = await pool.query(`
      SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id
      WHERE pr.type='withdraw' ORDER BY pr.created_at DESC LIMIT 8
    `);
    const recentBets = await pool.query(`
      SELECT b.*, u.username, m.team_a, m.team_b, m.title
      FROM bets b JOIN users u ON b.user_id = u.id LEFT JOIN matches m ON b.match_id = m.id
      ORDER BY b.created_at DESC LIMIT 8
    `);

    const recentActivity = [
      ...recentDeposits.rows.map(r => ({ kind: 'deposit', status: r.status, username: r.username, amount: Number(r.amount), created_at: r.created_at, ref: r.id })),
      ...recentWithdrawals.rows.map(r => ({ kind: 'withdraw', status: r.status, username: r.username, amount: Number(r.amount), created_at: r.created_at, ref: r.id })),
      ...recentBets.rows.map(r => ({ kind: 'bet', status: r.status, username: r.username, amount: Number(r.stake), created_at: r.created_at, ref: r.id, odd: r.odd, match: r.title || (r.team_a ? `${r.team_a} vs ${r.team_b}` : null) }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8);

    res.json({
      success: true,
      stats: {
        total_users: parseInt(users.rows[0].count),
        total_coins: Number(totalCoinsPoll.rows[0].total),
        active_users: parseInt(activeUsersPoll.rows[0].cnt),
        today_deposit: Number(todayDeposit.rows[0].total),
        today_withdraw: Number(todayWithdraw.rows[0].total),
        today_profit: Number(todayProfitLoss.rows[0].staked) - Number(todayProfitLoss.rows[0].paidout),
        yesterday_profit: Number(yesterdayProfitLoss.rows[0].staked) - Number(yesterdayProfitLoss.rows[0].paidout),
        total_deposit_all: Number(totalDepositAll.rows[0].total),
        total_withdraw_all: Number(totalWithdrawAll.rows[0].total),
        new_users_today: parseInt(newUsersToday.rows[0].cnt),
        pending_deposits: parseInt(pendingDeposits.rows[0].cnt),
        pending_withdrawals: parseInt(pendingWithdrawals.rows[0].cnt),
        pending_support: parseInt(pendingSupport.rows[0].cnt)
      },
      recentActivity
    });
  } catch (err) {
    console.error('dashboard-stats api error:', err.message);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি' });
  }
});

// ==================== ডিপোজিট ম্যানেজমেন্ট ====================
router.get('/deposits', async (req, res) => {
  try {
    const { from, to } = req.query;
    const pending = await pool.query(`
      SELECT pr.*, u.username, u.phone FROM payment_requests pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.type='deposit' AND pr.status='pending'
      ORDER BY pr.created_at ASC
    `);

    let recentQuery = `
      SELECT pr.*, u.username, u.phone FROM payment_requests pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.type='deposit' AND pr.status != 'pending'
    `;
    const params = [];
    if (from) {
      params.push(from);
      recentQuery += ` AND pr.created_at >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      recentQuery += ` AND pr.created_at < ($${params.length}::date + INTERVAL '1 day')`;
    }
    recentQuery += ` ORDER BY pr.created_at DESC` + (from || to ? '' : ' LIMIT 30');
    const recent = await pool.query(recentQuery, params);

    const summary = await pool.query(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
      FROM payment_requests WHERE type='deposit' AND status='pending'
    `);
    res.render('admin/deposits', {
      pendingDeposits: pending.rows,
      recentDeposits: recent.rows,
      pendingCount: parseInt(summary.rows[0].cnt),
      pendingTotal: Number(summary.rows[0].total),
      filterFrom: from || '',
      filterTo: to || ''
    });
  } catch (err) {
    console.error('deposits list error:', err.message);
    res.render('admin/deposits', { pendingDeposits: [], recentDeposits: [], pendingCount: 0, pendingTotal: 0, filterFrom: '', filterTo: '' });
  }
});

router.post('/api/deposits/:id/approve', adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'deposit' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে' });
    }
    const crApprove = await creditApprovedDeposit(client, request);
    await client.query('COMMIT');
    if (crApprove && crApprove.notification) emitToUser(request.user_id, crApprove.notification);
    await logAdminAction(req.session.user.id, req.session.user.username, 'deposit_approve', `Deposit #${id} approved`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'DEPOSIT_APPROVED', category: 'financial', status: 'success', riskLevel: 'low',
      details: { depositId: id, userId: request.user_id, amount: request.amount }
    }).catch(e => console.error('logAuditEvent (DEPOSIT_APPROVED) error:', e.message));
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deposit approve error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি, পরে আবার চেষ্টা করুন।' });
  } finally {
    client.release();
  }
});

router.post('/api/deposits/:id/reject', adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const reason = sanitizeText(req.body.reason || '', { maxLen: 300 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'deposit' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে' });
    }
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    const rejNotif = await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error') RETURNING *`,
      [request.user_id, 'ডিপোজিট বাতিল', `আপনার ${request.amount} টাকার ডিপোজিট বাতিল হয়েছে।${reason ? ' কারণ: ' + reason : ''}`]
    );
    await client.query('COMMIT');
    if (rejNotif.rows[0]) emitToUser(request.user_id, rejNotif.rows[0]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'deposit_reject', `Deposit #${id} rejected: ${reason || ''}`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'DEPOSIT_REJECTED', category: 'financial', status: 'success', riskLevel: 'low',
      details: { depositId: id, userId: request.user_id, amount: request.amount, reason }
    }).catch(e => console.error('logAuditEvent (DEPOSIT_REJECTED) error:', e.message));
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deposit reject error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি, পরে আবার চেষ্টা করুন।' });
  } finally {
    client.release();
  }
});

// ==================== উইথড্র ম্যানেজমেন্ট ====================
router.get('/withdrawals', async (req, res) => {
  try {
    const { from, to } = req.query;
    const pending = await pool.query(`
      SELECT pr.*, u.username, u.phone FROM payment_requests pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.type='withdraw' AND pr.status='pending'
      ORDER BY pr.created_at ASC
    `);

    let recentQuery = `
      SELECT pr.*, u.username, u.phone FROM payment_requests pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.type='withdraw' AND pr.status != 'pending'
    `;
    const params = [];
    if (from) {
      params.push(from);
      recentQuery += ` AND pr.created_at >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      recentQuery += ` AND pr.created_at < ($${params.length}::date + INTERVAL '1 day')`;
    }
    recentQuery += ` ORDER BY pr.created_at DESC` + (from || to ? '' : ' LIMIT 30');
    const recent = await pool.query(recentQuery, params);

    const summary = await pool.query(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
      FROM payment_requests WHERE type='withdraw' AND status='pending'
    `);
    res.render('admin/withdrawals', {
      pendingWithdrawals: pending.rows,
      recentWithdrawals: recent.rows,
      pendingCount: parseInt(summary.rows[0].cnt),
      pendingTotal: Number(summary.rows[0].total),
      filterFrom: from || '',
      filterTo: to || ''
    });
  } catch (err) {
    console.error('withdrawals list error:', err.message);
    res.render('admin/withdrawals', { pendingWithdrawals: [], recentWithdrawals: [], pendingCount: 0, pendingTotal: 0, filterFrom: '', filterTo: '' });
  }
});

router.post('/api/withdrawals/:id/approve', adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const txn = req.body.txn ? sanitizeText(req.body.txn, { maxLen: 120 }) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'withdraw' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে' });
    }
    await client.query(
      `UPDATE payment_requests SET status='approved', transaction_id=COALESCE($1, transaction_id), updated_at=NOW() WHERE id=$2`,
      [txn || null, id]
    );
    const wApproveNotif = await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success') RETURNING *`,
      [request.user_id, 'উইথড্র অনুমোদন', `আপনার ${request.amount} টাকার উইথড্র সম্পন্ন হয়েছে!${txn ? ' Ref: ' + txn : ''}`]
    );
    await client.query('COMMIT');
    if (wApproveNotif.rows[0]) emitToUser(request.user_id, wApproveNotif.rows[0]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'withdraw_approve', `Withdrawal #${id} approved`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'WITHDRAW_APPROVED', category: 'financial', status: 'success',
      riskLevel: request.amount >= 10000 ? 'medium' : 'low',
      details: { withdrawId: id, userId: request.user_id, amount: request.amount, txn }
    }).catch(e => console.error('logAuditEvent (WITHDRAW_APPROVED) error:', e.message));
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('withdraw approve error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি, পরে আবার চেষ্টা করুন।' });
  } finally {
    client.release();
  }
});

router.post('/api/withdrawals/:id/reject', adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const reason = sanitizeText(req.body.reason || '', { maxLen: 300 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'withdraw' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে' });
    }
    // উইথড্র রিকোয়েস্ট করার সময় কয়েন কেটে নেওয়া হয়, তাই বাতিল হলে ফেরত দিতে হবে
    await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    const wRejectNotif = await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error') RETURNING *`,
      [request.user_id, 'উইথড্র বাতিল', `আপনার ${request.amount} টাকার উইথড্র বাতিল হয়েছে, কয়েন ফেরত দেওয়া হয়েছে।${reason ? ' কারণ: ' + reason : ''}`]
    );
    await client.query('COMMIT');
    if (wRejectNotif.rows[0]) emitToUser(request.user_id, wRejectNotif.rows[0]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'withdraw_reject', `Withdrawal #${id} rejected: ${reason || ''}`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'WITHDRAW_REJECTED', category: 'financial', status: 'success', riskLevel: 'low',
      details: { withdrawId: id, userId: request.user_id, amount: request.amount, reason }
    }).catch(e => console.error('logAuditEvent (WITHDRAW_REJECTED) error:', e.message));
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('withdraw reject error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি, পরে আবার চেষ্টা করুন।' });
  } finally {
    client.release();
  }
});

// ==================== সাপোর্ট টিকেট ====================
router.get('/support', async (req, res) => {
  try {
    const msgs = await pool.query(`
      SELECT cm.*, u.username FROM chat_messages cm
      JOIN users u ON cm.sender_id = u.id AND cm.is_admin = false
      ORDER BY cm.created_at ASC
    `);
    // প্রতি ইউজারের মেসেজগুলো একটা "টিকেট" হিসেবে গ্রুপ করা
    const ticketMap = new Map();
    for (const m of msgs.rows) {
      if (!ticketMap.has(m.sender_id)) {
        ticketMap.set(m.sender_id, { userId: m.sender_id, username: m.username, messages: [], hasUnread: false });
      }
      const t = ticketMap.get(m.sender_id);
      t.messages.push({ from: 'user', text: m.message, time: m.created_at });
      if (!m.is_read) t.hasUnread = true;
    }
    const adminMsgs = await pool.query(`
      SELECT cm.* FROM chat_messages cm WHERE cm.is_admin = true AND cm.receiver_id IS NOT NULL
      ORDER BY cm.created_at ASC
    `);
    for (const m of adminMsgs.rows) {
      if (ticketMap.has(m.receiver_id)) {
        ticketMap.get(m.receiver_id).messages.push({ from: 'admin', text: m.message, time: m.created_at });
      }
    }
    const tickets = Array.from(ticketMap.values()).map(t => {
      t.messages.sort((a, b) => new Date(a.time) - new Date(b.time));
      const last = t.messages[t.messages.length - 1];
      return { ...t, lastMessage: last ? last.text : '', status: t.hasUnread ? 'Open' : 'Resolved' };
    }).sort((a, b) => (a.status === 'Open' ? -1 : 1) - (b.status === 'Open' ? -1 : 1));

    res.render('admin/support', { tickets, openCount: tickets.filter(t => t.status === 'Open').length });
  } catch (err) {
    console.error('support list error:', err.message);
    res.render('admin/support', { tickets: [], openCount: 0 });
  }
});

router.post('/api/support/:userId/reply', requireIntParam('userId'), async (req, res) => {
  try {
    const userId = req.params.userId;
    const message = sanitizeText(req.body.message || '', { maxLen: 2000 });
    if (!message) return res.status(400).json({ success: false, error: 'মেসেজ লিখুন' });
    await pool.query(
      `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, is_read, created_at) VALUES ($1,$2,$3,true,true,NOW())`,
      [req.session.user.id, userId, message]
    );
    // ইউজারের পাঠানো মেসেজগুলো রিড হিসেবে মার্ক করা
    await pool.query(`UPDATE chat_messages SET is_read=true WHERE sender_id=$1 AND is_admin=false`, [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('support reply error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি, পরে আবার চেষ্টা করুন।' });
  }
});

router.post('/api/support/:userId/resolve', requireIntParam('userId'), async (req, res) => {
  try {
    const userId = req.params.userId;
    await pool.query(`UPDATE chat_messages SET is_read=true WHERE sender_id=$1 AND is_admin=false`, [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('support resolve error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি, পরে আবার চেষ্টা করুন।' });
  }
});

// ==================== ট্রানজেকশন লগ ====================
router.get('/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 40;
    const offset = (page - 1) * limit;
    const countRes = await pool.query(`SELECT COUNT(*) FROM payment_requests`);
    const total = parseInt(countRes.rows[0].count);
    const txns = await pool.query(`
      SELECT pr.*, u.username FROM payment_requests pr
      JOIN users u ON pr.user_id = u.id
      ORDER BY pr.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.render('admin/transactions', {
      transactions: txns.rows, page, totalPages: Math.max(1, Math.ceil(total / limit)), total
    });
  } catch (err) {
    console.error('transactions list error:', err.message);
    res.render('admin/transactions', { transactions: [], page: 1, totalPages: 1, total: 0 });
  }
});

// ==================== USERS ====================
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';

    const conditions = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(username ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
    }
    if (status === 'banned') conditions.push('is_banned = true');
    if (status === 'active') conditions.push('is_banned = false');
    if (status === 'email_verified') conditions.push('email_verified = true');
    if (status === 'email_unverified') conditions.push('email_verified = false AND email IS NOT NULL');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM users ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT id, username, email, phone, coins, total_points, is_banned, email_verified, created_at FROM users ${where}
       ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.render('admin/users', {
      users: result.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total,
      search, status
    });
  } catch (err) {
    console.error(err);
    res.render('admin/users', { users: [], page: 1, totalPages: 1, total: 0, search: '', status: '' });
  }
});

// ==================== USER DETAIL ====================
router.get('/users/:id', async (req, res) => {
  try {
    const uId = req.params.id;
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [uId]);
    const user = userRes.rows[0];
    if (!user) {
      req.flash('error', 'ইউজার পাওয়া যায়নি!');
      return res.redirect('/admin/users');
    }

    let bets = [], transactions = [], payments = [], sameIp = [], referralCount = 0, stats = {};

    try {
      const b = await pool.query(
        `SELECT b.*, m.title AS match_title FROM bets b LEFT JOIN matches m ON b.match_id = m.id
         WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 50`, [uId]);
      bets = b.rows;
    } catch (e) {}

    try {
      const t = await pool.query(`SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [uId]);
      transactions = t.rows;
    } catch (e) {}

    try {
      const p = await pool.query(`SELECT * FROM payment_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [uId]);
      payments = p.rows;
    } catch (e) {}

    try {
      if (user.last_ip) {
        const s = await pool.query(`SELECT id, username, email FROM users WHERE last_ip = $1 AND id <> $2`, [user.last_ip, uId]);
        sameIp = s.rows;
      }
    } catch (e) {}

    try {
      const r = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by_id = $1', [uId]);
      referralCount = parseInt(r.rows[0].count);
    } catch (e) {}

    try {
      const dep = await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payment_requests WHERE user_id=$1 AND type='deposit' AND status='approved'`, [uId]);
      const wd = await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payment_requests WHERE user_id=$1 AND type='withdraw' AND status='approved'`, [uId]);
      const betSum = await pool.query(`SELECT COALESCE(SUM(stake),0) s, COUNT(*) c FROM bets WHERE user_id=$1`, [uId]);
      stats = {
        totalDeposit: dep.rows[0].s,
        totalWithdraw: wd.rows[0].s,
        totalBet: betSum.rows[0].s,
        betCount: betSum.rows[0].c
      };
    } catch (e) { stats = {}; }

    // Withdraw PIN স্ট্যাটাস — অ্যাডমিন শুধু কনফিগার্ড কিনা ও শেষ পরিবর্তনের সময় দেখতে পারবে, কখনো আসল PIN না
    let pinStatus = { configured: false, updatedAt: null, locked: false };
    try { pinStatus = await getPinStatus(uId); } catch (e) {}

    // ফ্রড স্ট্যাটাস — শুধু তথ্য দেখানো হয়, কোনো অটোমেটিক অ্যাকশন না
    let fraudStatus = { currentRiskLevel: 'none', openCount: 0, flags: [] };
    try { fraudStatus = await getUserFraudStatus(uId); } catch (e) {}

    let deviceOverview = { recentLogins: [], activeSessions: [] };
    try { deviceOverview = await getUserDeviceOverview(uId, 10); } catch (e) {}

    res.render('admin/user-detail', { u: user, bets, transactions, payments, sameIp, referralCount, stats, pinStatus, fraudStatus, deviceOverview });
  } catch (err) {
    console.error('user detail error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
    res.redirect('/admin/users');
  }
});

// ==================== USER ACTIONS ====================
router.post('/users/:id/ban', requireIntParam('id'), async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1 RETURNING is_banned, username', [req.params.id]);
    if (r.rows[0]) {
      await logAdminAction(req.session.user.id, req.session.user.username, r.rows[0].is_banned ? 'USER_BAN' : 'USER_UNBAN', `${r.rows[0].username} (#${req.params.id}) কে ${r.rows[0].is_banned ? 'ব্যান' : 'আনব্যান'} করা হয়েছে`, req.ip);
      logAuditEvent({
        req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
        action: r.rows[0].is_banned ? 'USER_BANNED' : 'USER_UNBANNED', category: 'security', status: 'success',
        riskLevel: r.rows[0].is_banned ? 'high' : 'medium',
        details: { targetUserId: req.params.id, targetUsername: r.rows[0].username }
      }).catch(e => console.error('logAuditEvent (USER_BAN/UNBAN) error:', e.message));
    }
    req.flash('success', 'স্ট্যাটাস আপডেট হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/delete', requireIntParam('id'), async (req, res) => {
  try {
    if (String(req.session.user.id) === String(req.params.id)) {
      req.flash('error', 'নিজের অ্যাকাউন্ট ডিলিট করা যাবে না!');
      return res.redirect('/admin/users');
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    req.flash('success', 'ইউজার ডিলিট করা হয়েছে!');
  } catch (err) {
    console.error('delete error:', err.message);
    req.flash('error', 'ডিলিট করতে সমস্যা!');
  }
  res.redirect('/admin/users');
});

// ==================== Security Overview — Security Center-এর অ্যাডমিন-সাইড ড্যাশবোর্ড ====================
router.get('/security-overview', async (req, res) => {
  try {
    const SECURITY_ACTION_TYPES = [
      'PASSWORD_CHANGED', 'WITHDRAW_PIN_CREATED', 'WITHDRAW_PIN_CHANGED', 'WITHDRAW_PIN_RESET',
      'NEW_DEVICE_LOGIN', 'DEVICE_SESSION_REVOKED', 'ALL_OTHER_SESSIONS_REVOKED',
      'EMAIL_VERIFIED', 'EMAIL_VERIFICATION_RESEND', 'EMAIL_VERIFICATION_SENT', '2FA_ENABLED', '2FA_DISABLED'
    ];

    const [
      totalUsersRes, emailUsersRes, emailVerifiedRes, pinConfiguredRes,
      activeSessionsRes, newDeviceLoginsRes, pinLockedRes, recentLogsRes,
      totpEnabledRes, failedLogins24hRes
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS c FROM users`),
      pool.query(`SELECT COUNT(*) AS c FROM users WHERE email IS NOT NULL`),
      pool.query(`SELECT COUNT(*) AS c FROM users WHERE email IS NOT NULL AND email_verified = true`),
      pool.query(`SELECT COUNT(*) AS c FROM users WHERE withdraw_pin_hash IS NOT NULL`),
      pool.query(`SELECT COUNT(*) AS c FROM device_sessions WHERE revoked_at IS NULL`),
      pool.query(`SELECT COUNT(*) AS c FROM login_logs WHERE is_new_device = true AND created_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*) AS c FROM users WHERE withdraw_pin_locked_until IS NOT NULL AND withdraw_pin_locked_until > NOW()`),
      pool.query(
        `SELECT * FROM admin_logs WHERE action_type = ANY($1) ORDER BY created_at DESC LIMIT 25`,
        [SECURITY_ACTION_TYPES]
      ),
      pool.query(`SELECT COUNT(*) AS c FROM users WHERE totp_enabled = true`),
      pool.query(`SELECT COUNT(*) AS c FROM failed_login_attempts WHERE created_at >= NOW() - INTERVAL '24 hours'`)
    ]);

    const stats = {
      totalUsers: parseInt(totalUsersRes.rows[0].c),
      emailUsers: parseInt(emailUsersRes.rows[0].c),
      emailVerified: parseInt(emailVerifiedRes.rows[0].c),
      pinConfigured: parseInt(pinConfiguredRes.rows[0].c),
      activeSessions: parseInt(activeSessionsRes.rows[0].c),
      newDeviceLogins7d: parseInt(newDeviceLoginsRes.rows[0].c),
      pinLocked: parseInt(pinLockedRes.rows[0].c),
      totpEnabled: parseInt(totpEnabledRes.rows[0].c),
      failedLogins24h: parseInt(failedLogins24hRes.rows[0].c)
    };

    res.render('admin/security-overview', { stats, recentLogs: recentLogsRes.rows });
  } catch (err) {
    console.error('security-overview error:', err.message);
    res.render('admin/security-overview', {
      stats: { totalUsers: 0, emailUsers: 0, emailVerified: 0, pinConfigured: 0, activeSessions: 0, newDeviceLogins7d: 0, pinLocked: 0, totpEnabled: 0, failedLogins24h: 0 },
      recentLogs: []
    });
  }
});

// ==================== Bot Detection System — Admin Bot Activity ও Alerts ====================
router.get('/bot-logs', async (req, res) => {
  try {
    const { risk_level = '', endpoint = '', ip = '', from = '', to = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    if (risk_level) { params.push(risk_level); conditions.push(`risk_level = $${params.length}`); }
    if (endpoint) { params.push(endpoint); conditions.push(`endpoint = $${params.length}`); }
    if (ip) { params.push(ip); conditions.push(`ip = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM bot_activity_logs ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT b.*, u.username FROM bot_activity_logs b LEFT JOIN users u ON u.id = b.user_id
       ${where}
       ORDER BY b.created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const summaryRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last24h,
        COUNT(*) FILTER (WHERE risk_level = 'high' AND created_at > NOW() - INTERVAL '24 hours') AS high24h,
        COUNT(*) FILTER (WHERE blocked = true AND created_at > NOW() - INTERVAL '24 hours') AS blocked24h
      FROM bot_activity_logs
    `);

    res.render('admin/bot-logs', {
      logs: result.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total,
      filters: { risk_level, endpoint, ip, from, to },
      summary: summaryRes.rows[0]
    });
  } catch (err) {
    console.error('Bot logs list error:', err.message);
    res.render('admin/bot-logs', {
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { risk_level: '', endpoint: '', ip: '', from: '', to: '' },
      summary: { last24h: 0, high24h: 0, blocked24h: 0 }
    });
  }
});


// অ্যাডমিন আসল PIN কখনো দেখতে/সেট করতে পারবে না — শুধু হ্যাশ ক্লিয়ার করে দেয়, ইউজারকে
// আবার নতুন PIN তৈরি করতে হবে। প্রতিটি রিসেট withdraw_pin_logs + admin_logs উভয় জায়গায় লগ হয়।
router.post('/users/:id/withdraw-pin/reset', adminActionLimiter, requireIntParam('id'), async (req, res) => {
  try {
    await adminResetPin(req.params.id, req.session.user.id, req.session.user.username, req.ip);
    await logAdminAction(
      req.session.user.id,
      req.session.user.username,
      'WITHDRAW_PIN_RESET',
      `ইউজার #${req.params.id}-এর Withdraw PIN রিসেট করা হয়েছে`,
      req.ip
    );
    req.flash('success', '✅ ইউজারের Withdraw PIN রিসেট করা হয়েছে। ইউজারকে এখন নতুন PIN সেট করতে হবে।');
  } catch (err) {
    console.error('admin withdraw pin reset error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('back');
});

router.post('/users/:id/coins/add', adminFinancialLimiter, requireIntParam('id'), requireAmount('amount', { max: 10_000_000 }), async (req, res) => {
  try {
    const amount = req.body.amount; // requireAmount দিয়ে ইতিমধ্যে যাচাই ও normalize করা
    const reason = (req.body.reason || '').trim().slice(0, 200);
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_add',$3)`, [req.params.id, amount, reason || 'অ্যাডমিন কয়েন যোগ']);
    await logAdminAction(req.session.user.id, req.session.user.username, 'COIN_ADD', `ইউজার #${req.params.id}-কে ${amount} কয়েন যোগ${reason ? ' — কারণ: ' + reason : ''}`, req.ip);
    req.flash('success', '✅ কয়েন যোগ হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/coins/remove', adminFinancialLimiter, requireIntParam('id'), requireAmount('amount', { max: 10_000_000 }), async (req, res) => {
  try {
    const amount = req.body.amount;
    const reason = (req.body.reason || '').trim().slice(0, 200);
    await pool.query('UPDATE users SET coins = GREATEST(coins - $1, 0) WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_remove',$3)`, [req.params.id, -amount, reason || 'অ্যাডমিন কয়েন কমানো']);
    await logAdminAction(req.session.user.id, req.session.user.username, 'COIN_REMOVE', `ইউজার #${req.params.id}-এর ${amount} কয়েন কমানো${reason ? ' — কারণ: ' + reason : ''}`, req.ip);
    req.flash('success', '✅ কয়েন কমানো হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/freebet', adminFinancialLimiter, requireIntParam('id'), requireAmount('amount', { max: 1_000_000 }), async (req, res) => {
  try {
    const amount = req.body.amount;
    await grantFreeBet(req.params.id, amount, 'admin');
    await logAdminAction(req.session.user.id, req.session.user.username, 'freebet_grant', `${amount} taka free bet to user #${req.params.id}`, req.ip);
    req.flash('success', `✅ ${amount} টাকার ফ্রি বেট দেওয়া হয়েছে!`);
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

// ==================== MATCHES ====================
router.get('/matches', async (req, res) => {
  try {
    const matches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC');
    res.render('admin/matches', { matches: matches.rows });
  } catch (err) { res.render('admin/matches', { matches: [] }); }
});

router.post('/matches/add', async (req, res) => {
  try {
    const { title, sport, team_a, team_b, start_time } = req.body;
    if (!team_a || !team_b) { req.flash('error', 'দুই দলের নাম দিন!'); return res.redirect('/admin/matches'); }
    await pool.query(
      `INSERT INTO matches (title, sport, team_a, team_b, status, start_time) VALUES ($1,$2,$3,$4,'upcoming',$5)`,
      [title || `${team_a} vs ${team_b}`, sport || 'cricket', team_a, team_b, start_time || null]);
    req.flash('success', 'নতুন ম্যাচ যোগ হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('/admin/matches');
});

router.post('/matches/:id/delete', async (req, res) => {
  try { await pool.query('DELETE FROM matches WHERE id = $1', [req.params.id]); req.flash('success', 'ম্যাচ মুছে ফেলা হয়েছে!'); }
  catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('/admin/matches');
});

// ==================== MARKETS ====================
router.get('/markets/:matchId', async (req, res) => {
  try {
    const matchResult = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.matchId]);
    const match = matchResult.rows[0];
    if (!match) return res.status(404).send('Match not found');
    const markets = await pool.query('SELECT * FROM markets WHERE match_id = $1', [req.params.matchId]);
    res.render('admin/markets', { match: match, markets: markets.rows });
  } catch (err) { res.status(500).send('Server Error'); }
});

router.post('/markets/update', async (req, res) => {
  try {
    const { match_id, type, name, odds, status } = req.body;
    await pool.query(`
      INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (match_id, type, name) DO UPDATE SET odds = EXCLUDED.odds, status = EXCLUDED.status, updated_at = NOW()
    `, [match_id, type, name, odds, status || 'open']);
    await cache.del(cacheKeys.matchDetail(match_id)).catch(() => {});
    req.flash('success', 'মার্কেট আপডেট হয়েছে!');
    res.redirect(`/admin/markets/${match_id}`);
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); res.redirect('/admin/matches'); }
});

router.post('/markets/:marketId/toggle', async (req, res) => {
  try {
    const mRes = await pool.query('UPDATE markets SET status = $1 WHERE id = $2 RETURNING match_id', [req.body.status, req.params.marketId]);
    if (mRes.rows[0]) await cache.del(cacheKeys.matchDetail(mRes.rows[0].match_id)).catch(() => {});
    req.flash('success', 'মার্কেট আপডেট হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/markets/:marketId/settle', async (req, res) => {
  const marketId = req.params.marketId;
  const { winning_runner } = req.body;
  if (!winning_runner) { req.flash('error', 'জয় নির্বাচন করুন!'); return res.redirect('back'); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bets = await client.query(`SELECT * FROM bets WHERE market_id = $1 AND status = 'pending' FOR UPDATE`, [marketId]);
    let winnersCount = 0;
    const notifsToEmit = [];
    for (const bet of bets.rows) {
      if (String(bet.runner) === String(winning_runner)) {
        const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
        await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [payout, bet.user_id]);
        await client.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'bet_win','বেট জয়')`, [bet.user_id, payout]);
        await client.query(`UPDATE bets SET status = 'won' WHERE id = $1`, [bet.id]);
        const wn = await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট জয়!',$2,'success') RETURNING *`, [bet.user_id, `আপনি ${payout} কয়েন জিতেছেন!`]);
        notifsToEmit.push({ userId: bet.user_id, row: wn.rows[0] });
        winnersCount++;
      } else {
        await client.query(`UPDATE bets SET status = 'lost' WHERE id = $1`, [bet.id]);
        const ln = await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট ফলাফল',$2,'error') RETURNING *`, [bet.user_id, `আপনার বেটটি হেরে গেছে।`]);
        notifsToEmit.push({ userId: bet.user_id, row: ln.rows[0] });
      }
    }
    await client.query(`UPDATE markets SET status = 'settled', updated_at = NOW() WHERE id = $1`, [marketId]);
    const accaNotifs = await settleSelectionsForMarket(client, marketId, winning_runner);
    await client.query('COMMIT');
    notifsToEmit.push(...accaNotifs);
    notifsToEmit.forEach(n => emitToUser(n.userId, n.row));
    try {
      const mRow = await pool.query('SELECT match_id FROM markets WHERE id = $1', [marketId]);
      if (mRow.rows[0]) await cache.del(cacheKeys.matchDetail(mRow.rows[0].match_id));
    } catch (e) {}
    req.flash('success', `সেটেল সম্পন্ন! ${bets.rows.length} টি বেট, ${winnersCount} জন জিতেছে।`);
    res.redirect('back');
  } catch (err) {
    await client.query('ROLLBACK');
    req.flash('error', 'সেটেল সমস্যা!');
    res.redirect('back');
  } finally { client.release(); }
});

// ==================== BETS ====================
router.get('/bets', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 30;
    const offset = (page - 1) * limit;
    const status = req.query.status || '';
    const conditions = [];
    const params = [];
    if (['pending', 'won', 'lost'].includes(status)) {
      params.push(status);
      conditions.push(`b.status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM bets b ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const bets = await pool.query(`
      SELECT b.*, u.username, m.team_a, m.team_b, m.title
      FROM bets b JOIN users u ON b.user_id = u.id LEFT JOIN matches m ON b.match_id = m.id
      ${where} ORDER BY b.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const pendingCountRes = await pool.query(`SELECT COUNT(*) FROM bets WHERE status='pending'`);
    const todayStakeRes = await pool.query(`SELECT COALESCE(SUM(stake),0) AS total FROM bets WHERE created_at::date = CURRENT_DATE`);
    const todayGgrRes = await pool.query(`
      SELECT COALESCE(SUM(stake),0) AS staked,
             COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS paidout
      FROM bets WHERE created_at::date = CURRENT_DATE AND status IN ('won','lost')
    `);

    res.render('admin/bets', {
      bets: bets.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total, status,
      pendingSettlement: parseInt(pendingCountRes.rows[0].count),
      todayStake: Number(todayStakeRes.rows[0].total),
      todayGgr: Number(todayGgrRes.rows[0].staked) - Number(todayGgrRes.rows[0].paidout)
    });
  } catch (err) {
    console.error(err);
    res.render('admin/bets', { bets: [], page: 1, totalPages: 1, total: 0, status: '', pendingSettlement: 0, todayStake: 0, todayGgr: 0 });
  }
});

router.post('/bets/:id/settle', async (req, res) => {
  const { id } = req.params;
  const { result } = req.body;
  if (!['won', 'lost'].includes(result)) {
    req.flash('error', 'ভুল রেজাল্ট');
    return res.redirect('/admin/bets');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT * FROM bets WHERE id=$1 FOR UPDATE', [id]);
    const bet = b.rows[0];
    if (!bet || bet.status !== 'pending') {
      await client.query('ROLLBACK');
      req.flash('error', 'বেট পাওয়া যায়নি অথবা আগেই সেটেল হয়েছে');
      return res.redirect('/admin/bets');
    }
    await client.query('UPDATE bets SET status=$1 WHERE id=$2', [result, id]);
    let settleNotif;
    if (result === 'won') {
      const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [payout, bet.user_id]);
      settleNotif = await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট জিতেছেন!',$2,'success') RETURNING *`, [bet.user_id, `আপনি ৳${payout} জিতেছেন!`]);
    } else {
      settleNotif = await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট ফলাফল',$2,'error') RETURNING *`, [bet.user_id, `আপনার ৳${bet.stake} বেটটি হেরে গেছে।`]);
    }
    await client.query('COMMIT');
    if (settleNotif.rows[0]) emitToUser(bet.user_id, settleNotif.rows[0]);
    req.flash('success', 'বেট সেটেল হয়েছে');
    res.redirect('/admin/bets');
  } catch (err) {
    await client.query('ROLLBACK');
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/admin/bets');
  } finally {
    client.release();
  }
});

// ==================== বোনাস ম্যানেজমেন্ট ====================
router.get('/bonuses', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, u.username FROM bonuses b LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC LIMIT 200
    `);
    const statsRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        COALESCE(SUM(bonus_amount) FILTER (WHERE status = 'active'), 0) AS total_active_amount
      FROM bonuses
    `);
    res.render('admin/bonuses', { bonuses: result.rows, stats: statsRes.rows[0] });
  } catch (err) {
    console.error('Bonuses list error:', err.message);
    res.render('admin/bonuses', { bonuses: [], stats: { active: 0, completed: 0, cancelled: 0, total_active_amount: 0 } });
  }
});

router.post('/bonuses/add', async (req, res) => {
  try {
    const { username } = req.body;
    const bonus_type = sanitizeText(req.body.bonus_type || '', { maxLen: 50 });
    const bonus_amount = parseAmount(req.body.bonus_amount, { max: 1_000_000 });
    const sports_required = Number.isFinite(Number(req.body.sports_required)) ? Math.max(0, parseInt(req.body.sports_required) || 0) : 0;
    const casino_required = Number.isFinite(Number(req.body.casino_required)) ? Math.max(0, parseInt(req.body.casino_required) || 0) : 0;
    if (!bonus_amount) { req.flash('error', 'সঠিক বোনাস পরিমাণ দিন'); return res.redirect('/admin/bonuses'); }
    const userRes = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (!userRes.rows[0]) return res.redirect('/admin/bonuses');
    await pool.query(
      `INSERT INTO bonuses (user_id, bonus_type, bonus_amount, sports_required, casino_required, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [userRes.rows[0].id, bonus_type, bonus_amount, sports_required, casino_required]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'BONUS_ADD', `${username} কে ${bonus_amount} কয়েন বোনাস দেওয়া হয়েছে`, req.ip);
    res.redirect('/admin/bonuses');
  } catch (err) {
    console.error('Bonus add error:', err.message);
    res.redirect('/admin/bonuses');
  }
});

router.post('/bonuses/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE bonuses SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'BONUS_CANCEL', `বোনাস #${id} বাতিল করা হয়েছে`, req.ip);
    res.redirect('/admin/bonuses');
  } catch (err) {
    console.error('Bonus cancel error:', err.message);
    res.redirect('/admin/bonuses');
  }
});

// ==================== VIP সিস্টেম ম্যানেজমেন্ট (প্রিমিয়াম) ====================
router.get('/vip', rbac.requirePermission('vip_manage'), async (req, res) => {
  try {
    const levels = await listVipLevelsAdmin();
    const analytics = await getVipAnalytics();
    res.render('admin/vip', { levels, analytics, active: 'vip' });
  } catch (err) {
    console.error('Admin VIP list error:', err.message);
    res.render('admin/vip', {
      levels: [], analytics: { perLevel: [], upgradeStats: [], grandTotalBonus: 0 }, active: 'vip'
    });
  }
});

router.post('/vip/save', adminActionLimiter, rbac.requirePermission('vip_manage'), async (req, res) => {
  try {
    const data = {
      level: req.body.level,
      name: sanitizeText(req.body.name || '', { maxLen: 40 }),
      min_turnover: req.body.min_turnover,
      upgrade_bonus: req.body.upgrade_bonus,
      daily_bonus: req.body.daily_bonus,
      weekly_bonus: req.body.weekly_bonus,
      monthly_bonus: req.body.monthly_bonus,
      cashback_percent: req.body.cashback_percent,
      withdrawal_limit: req.body.withdrawal_limit,
      deposit_bonus_percent: req.body.deposit_bonus_percent,
      birthday_bonus: req.body.birthday_bonus,
      priority_support: req.body.priority_support === 'on' || req.body.priority_support === 'true',
      exclusive_events: sanitizeText(req.body.exclusive_events || '', { maxLen: 500 }),
      icon: sanitizeText(req.body.icon || '👑', { maxLen: 10 }),
      is_active: req.body.is_active === 'on' || req.body.is_active === 'true'
    };
    const result = await upsertVipLevel(data);
    await logAdminAction(
      req.session.user.id, req.session.user.username,
      result.created ? 'VIP_LEVEL_CREATE' : 'VIP_LEVEL_UPDATE',
      `VIP লেভেল ${result.level} (${data.name}) ${result.created ? 'তৈরি' : 'আপডেট'} করা হয়েছে`,
      req.ip
    );
    await logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: result.created ? 'VIP_LEVEL_CREATE' : 'VIP_LEVEL_UPDATE', category: 'settings', riskLevel: 'medium',
      details: { level: result.level, ...data }
    });
    req.flash('success', `VIP লেভেল ${result.level} সফলভাবে সেভ হয়েছে।`);
    res.redirect('/admin/vip');
  } catch (err) {
    console.error('Admin VIP save error:', err.message);
    req.flash('error', 'VIP লেভেল সেভ করা যায়নি: ' + err.message);
    res.redirect('/admin/vip');
  }
});

router.post('/vip/:level/toggle', adminActionLimiter, rbac.requirePermission('vip_manage'), async (req, res) => {
  try {
    const level = parseInt(req.params.level, 10);
    const isActive = req.body.is_active === 'true' || req.body.is_active === '1';
    await toggleVipLevelActive(level, isActive);
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'VIP_LEVEL_TOGGLE',
      `VIP লেভেল ${level} ${isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে`, req.ip
    );
    await logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'VIP_LEVEL_TOGGLE', category: 'settings', riskLevel: 'low', details: { level, isActive }
    });
    res.redirect('/admin/vip');
  } catch (err) {
    console.error('Admin VIP toggle error:', err.message);
    res.redirect('/admin/vip');
  }
});

router.get('/vip/history', rbac.requirePermission('vip_manage'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rewardType = req.query.type || null;
    const rewardHistory = await listAllRewardHistory({ page, limit: 50, rewardType });
    const upgradeHistory = await listAllUpgradeHistory({ page: 1, limit: 50 });
    res.render('admin/vip-history', { rewardHistory, upgradeHistory, page, rewardType, active: 'vip' });
  } catch (err) {
    console.error('Admin VIP history error:', err.message);
    res.render('admin/vip-history', {
      rewardHistory: { rows: [], total: 0, page: 1, totalPages: 1 },
      upgradeHistory: { rows: [], total: 0, page: 1, totalPages: 1 },
      page: 1, rewardType: null, active: 'vip'
    });
  }
});

// ==================== প্রমোশন ব্যানার ====================
router.get('/promotions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promotions ORDER BY position ASC, created_at DESC');
    res.render('admin/promotions', { promotions: result.rows });
  } catch (err) {
    console.error('Promotions list error:', err.message);
    res.render('admin/promotions', { promotions: [] });
  }
});

router.post('/promotions/add', async (req, res) => {
  try {
    const title = sanitizeText(req.body.title || '', { maxLen: 200 }) || null;
    const image_url = req.body.image_url && isSafeUrl(req.body.image_url) ? req.body.image_url.trim() : null;
    const link_url = req.body.link_url && isSafeUrl(req.body.link_url) ? req.body.link_url.trim() : null;
    const position = Number.isFinite(Number(req.body.position)) ? parseInt(req.body.position) || 0 : 0;
    if (!image_url) { req.flash('error', 'বৈধ ইমেজ URL দিন'); return res.redirect('/admin/promotions'); }
    await pool.query(
      'INSERT INTO promotions (title, image_url, link_url, position, active) VALUES ($1, $2, $3, $4, true)',
      [title, image_url, link_url, position]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'PROMOTION_ADD', `নতুন প্রমোশন ব্যানার যোগ করা হয়েছে: ${title || ''}`, req.ip);
    res.redirect('/admin/promotions');
  } catch (err) {
    console.error('Promotion add error:', err.message);
    res.redirect('/admin/promotions');
  }
});

router.post('/promotions/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE promotions SET active = NOT active WHERE id = $1', [id]);
    res.redirect('/admin/promotions');
  } catch (err) {
    console.error('Promotion toggle error:', err.message);
    res.redirect('/admin/promotions');
  }
});

router.post('/promotions/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM promotions WHERE id = $1', [id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'PROMOTION_DELETE', `প্রমোশন #${id} মুছে ফেলা হয়েছে`, req.ip);
    res.redirect('/admin/promotions');
  } catch (err) {
    console.error('Promotion delete error:', err.message);
    res.redirect('/admin/promotions');
  }
});

// ==================== টুর্নামেন্ট ====================
router.get('/tournaments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, COUNT(p.id) AS participant_count
      FROM tournaments t
      LEFT JOIN tournament_participants p ON p.tournament_id = t.id
      GROUP BY t.id ORDER BY t.created_at DESC
    `);
    const statsRes = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'live') AS live,
        COUNT(*) FILTER (WHERE status = 'upcoming') AS upcoming,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed
      FROM tournaments
    `);
    res.render('admin/tournaments', { tournaments: result.rows, stats: statsRes.rows[0] });
  } catch (err) {
    console.error('Tournaments list error:', err.message);
    res.render('admin/tournaments', { tournaments: [], stats: { total: 0, live: 0, upcoming: 0, completed: 0 } });
  }
});

router.post('/tournaments/add', async (req, res) => {
  try {
    const { name, sport, description, entry_fee, prize_pool, max_participants, start_date, end_date } = req.body;
    await pool.query(
      `INSERT INTO tournaments (name, sport, description, entry_fee, prize_pool, max_participants, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'upcoming')`,
      [name, sport || null, description || null, entry_fee || 0, prize_pool || 0, max_participants || 100, start_date || null, end_date || null]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'TOURNAMENT_ADD', `নতুন টুর্নামেন্ট যোগ করা হয়েছে: ${name}`, req.ip);
    res.redirect('/admin/tournaments');
  } catch (err) {
    console.error('Tournament add error:', err.message);
    res.redirect('/admin/tournaments');
  }
});

router.post('/tournaments/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await pool.query('UPDATE tournaments SET status = $1 WHERE id = $2', [status, id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'TOURNAMENT_STATUS', `টুর্নামেন্ট #${id} স্ট্যাটাস ${status} করা হয়েছে`, req.ip);
    res.redirect('/admin/tournaments');
  } catch (err) {
    console.error('Tournament status error:', err.message);
    res.redirect('/admin/tournaments');
  }
});

router.post('/tournaments/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tournaments WHERE id = $1', [id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'TOURNAMENT_DELETE', `টুর্নামেন্ট #${id} মুছে ফেলা হয়েছে`, req.ip);
    res.redirect('/admin/tournaments');
  } catch (err) {
    console.error('Tournament delete error:', err.message);
    res.redirect('/admin/tournaments');
  }
});

// ==================== নিউজ ====================
router.get('/news', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 200');
    res.render('admin/news', { newsList: result.rows });
  } catch (err) {
    console.error('News list error:', err.message);
    res.render('admin/news', { newsList: [] });
  }
});

router.post('/news/add', async (req, res) => {
  try {
    const title = sanitizeText(req.body.title || '', { maxLen: 200 });
    const content = sanitizeText(req.body.content || '', { maxLen: 20000 });
    const image_url = req.body.image_url && isSafeUrl(req.body.image_url) ? req.body.image_url.trim() : null;
    const sport = sanitizeText(req.body.sport || '', { maxLen: 50 }) || null;
    if (!title) { req.flash('error', 'শিরোনাম আবশ্যক'); return res.redirect('/admin/news'); }
    await pool.query(
      'INSERT INTO news (title, content, image_url, sport, author_id) VALUES ($1, $2, $3, $4, $5)',
      [title, content || null, image_url, sport, req.session.user.id]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'NEWS_ADD', `নতুন নিউজ যোগ করা হয়েছে: ${title}`, req.ip);
    res.redirect('/admin/news');
  } catch (err) {
    console.error('News add error:', err.message);
    res.redirect('/admin/news');
  }
});

router.post('/news/:id/delete', requireIntParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM news WHERE id = $1', [id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'NEWS_DELETE', `নিউজ #${id} মুছে ফেলা হয়েছে`, req.ip);
    res.redirect('/admin/news');
  } catch (err) {
    console.error('News delete error:', err.message);
    res.redirect('/admin/news');
  }
});

router.get('/activity/export.csv', async (req, res) => {
  try {
    const { action_type = '', q = '' } = req.query;
    const params = [];
    let query = 'SELECT * FROM admin_logs WHERE 1=1';
    if (action_type) {
      params.push(action_type);
      query += ` AND action_type = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (admin_username ILIKE $${params.length} OR details ILIKE $${params.length})`;
    }
    query += ' ORDER BY created_at DESC LIMIT 5000';
    const result = await pool.query(query, params);

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['id', 'admin_username', 'action_type', 'details', 'ip_address', 'created_at'];
    const rows = result.rows.map(r => header.map(h => esc(r[h])).join(','));
    const csv = [header.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="admin-activity-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv); // BOM যাতে বাংলা টেক্সট Excel-এ ঠিকভাবে দেখায়
  } catch (err) {
    console.error('Activity CSV export error:', err.message);
    res.status(500).send('Export failed');
  }
});

// ==================== অ্যাক্টিভিটি লগ ====================

// ==================== Bot Detection — Admin Monitoring ====================
router.get('/bot-monitoring', async (req, res) => {
  try {
    const [statsToday, byRisk, byEndpoint, ipRules, recentLogs] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE blocked) AS blocked
                  FROM bot_activity_logs WHERE created_at::date = CURRENT_DATE`),
      pool.query(`SELECT risk_level, COUNT(*) AS cnt FROM bot_activity_logs
                  WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY risk_level`),
      pool.query(`SELECT endpoint, COUNT(*) AS cnt FROM bot_activity_logs
                  WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY endpoint ORDER BY cnt DESC LIMIT 8`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE type='block') AS blocked_ips,
                         COUNT(*) FILTER (WHERE type='whitelist') AS whitelisted_ips FROM ip_rules`),
      pool.query(`SELECT * FROM bot_activity_logs ORDER BY created_at DESC LIMIT 20`)
    ]);

    res.render('admin/bot-monitoring', {
      user: req.session.user,
      statsToday: statsToday.rows[0],
      byRisk: byRisk.rows,
      byEndpoint: byEndpoint.rows,
      ipRuleCounts: ipRules.rows[0],
      recentLogs: recentLogs.rows
    });
  } catch (err) {
    console.error('bot-monitoring dashboard error:', err.message);
    res.render('admin/bot-monitoring', {
      user: req.session.user,
      statsToday: { total: 0, blocked: 0 },
      byRisk: [], byEndpoint: [], ipRuleCounts: { blocked_ips: 0, whitelisted_ips: 0 }, recentLogs: []
    });
  }
});

// ==================== Cron / Scheduler Management ====================
// ==================== Role & Permission Management (RBAC) ====================
// এই সব রুট শুধু roles_manage permission থাকা admin ব্যবহার করতে পারবে;
// role_key সেট না থাকা (backward-compatible সুপার-অ্যাডমিন-সমতুল্য) admin-রাও অ্যাক্সেস পাবে।
router.get('/roles', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const roles = await rbac.listRoles();
    res.render('admin/roles', { roles, permissionGroups: rbac.permissionGroups(), error: null });
  } catch (err) {
    console.error('roles list error:', err.message);
    res.render('admin/roles', { roles: [], permissionGroups: rbac.permissionGroups(), error: err.message });
  }
});

router.get('/roles/matrix', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const roles = await rbac.listRoles();
    res.render('admin/roles-matrix', { roles, permissionGroups: rbac.permissionGroups() });
  } catch (err) {
    console.error('roles matrix error:', err.message);
    req.flash('error', 'Matrix লোড করতে সমস্যা হয়েছে।');
    res.redirect('/admin/roles');
  }
});

router.post('/roles', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const permissions = {};
    Object.keys(rbac.PERMISSIONS).forEach(key => { permissions[key] = req.body[`perm_${key}`] === 'on'; });
    const role = await rbac.createRole({ name: req.body.name, description: sanitizeText(req.body.description || ''), permissions });
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_CREATED', `নতুন Role: ${role.name} (${role.key})`, req.ip);
    req.flash('success', `Role "${role.name}" তৈরি হয়েছে।`);
    res.redirect('/admin/roles');
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/roles');
  }
});

router.get('/roles/:id/edit', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const role = await rbac.getRole(req.params.id);
    if (!role) { req.flash('error', 'Role পাওয়া যায়নি।'); return res.redirect('/admin/roles'); }
    res.render('admin/role-edit', { role, permissionGroups: rbac.permissionGroups() });
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/roles');
  }
});

router.post('/roles/:id', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const existing = await rbac.getRole(req.params.id);
    if (!existing) { req.flash('error', 'Role পাওয়া যায়নি।'); return res.redirect('/admin/roles'); }
    const permissions = {};
    Object.keys(rbac.PERMISSIONS).forEach(key => {
      // Super Admin Role-এর permission UI থেকে বদলানো যাবে না — সবসময় সব true (override)
      permissions[key] = existing.key === 'super_admin' ? true : req.body[`perm_${key}`] === 'on';
    });
    const role = await rbac.updateRole(req.params.id, { name: existing.is_system ? existing.name : req.body.name, description: sanitizeText(req.body.description || ''), permissions });
    await logAdminAction(req.session.user.id, req.session.user.username, 'PERMISSION_CHANGED', `Role "${role.name}"-এর permission আপডেট করা হয়েছে`, req.ip);
    req.flash('success', `Role "${role.name}" আপডেট হয়েছে।`);
    res.redirect('/admin/roles');
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/roles');
  }
});

router.post('/roles/:id/clone', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const role = await rbac.cloneRole(req.params.id, req.body.name);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_CLONED', `"${req.params.id}" থেকে ক্লোন করে নতুন Role: ${role.name}`, req.ip);
    req.flash('success', `Role "${role.name}" ক্লোন হয়েছে — এখন এডিট করতে পারেন।`);
    res.redirect(`/admin/roles/${role.id}/edit`);
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/roles');
  }
});

router.post('/roles/:id/delete', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const role = await rbac.getRole(req.params.id);
    await rbac.deleteRole(req.params.id);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_DELETED', `Role ডিলিট করা হয়েছে: ${role ? role.name : req.params.id}`, req.ip);
    req.flash('success', 'Role ডিলিট করা হয়েছে।');
    res.redirect('/admin/roles');
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/roles');
  }
});

router.post('/roles/bulk-permission-update', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const roleIds = [].concat(req.body.role_ids || []);
    const permKey = req.body.perm_key;
    const value = req.body.perm_value === 'true';
    if (!roleIds.length || !rbac.PERMISSIONS[permKey]) { req.flash('error', 'সঠিক Role ও Permission নির্বাচন করুন।'); return res.redirect('/admin/roles/matrix'); }
    const updated = await rbac.bulkUpdatePermission(roleIds, permKey, value);
    await logAdminAction(req.session.user.id, req.session.user.username, 'PERMISSION_CHANGED', `বাল্ক আপডেট — "${permKey}" = ${value} এই Role-গুলোতে: ${updated.join(', ')}`, req.ip);
    req.flash('success', `${updated.length}টা Role আপডেট হয়েছে।`);
    res.redirect('/admin/roles/matrix');
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/roles/matrix');
  }
});

router.get('/roles/export', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const roles = await rbac.listRoles();
    const data = rbac.exportRoles(roles);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLES_EXPORTED', `${data.length}টা Role এক্সপোর্ট করা হয়েছে`, req.ip);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="livo-roles-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/roles');
  }
});

router.post('/roles/import', rbac.requirePermission('roles_manage'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('একটা JSON ফাইল সিলেক্ট করুন।');
    const data = JSON.parse(req.file.buffer.toString('utf8'));
    const result = await rbac.importRoles(data);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLES_IMPORTED', `Import: ${result.created} তৈরি, ${result.updated} আপডেট, ${result.skipped} স্কিপ`, req.ip);
    req.flash('success', `Import সম্পন্ন — ${result.created} তৈরি, ${result.updated} আপডেট, ${result.skipped} স্কিপ (সিস্টেম Role/অবৈধ এন্ট্রি)।`);
    res.redirect('/admin/roles');
  } catch (err) {
    req.flash('error', 'Import ব্যর্থ: ' + err.message);
    res.redirect('/admin/roles');
  }
});

// ইউজারদের Role এসাইনমেন্ট
router.get('/user-roles', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const search = req.query.q || '';
    const params = [];
    let where = "WHERE role = 'admin'";
    if (search) { params.push(`%${search}%`); where += ` AND username ILIKE $${params.length}`; }
    const usersRes = await pool.query(`SELECT id, username, email, role, role_key FROM users ${where} ORDER BY username ASC LIMIT 200`, params);
    const roles = await rbac.listRoles();
    res.render('admin/user-roles', { users: usersRes.rows, roles, search });
  } catch (err) {
    console.error('user-roles error:', err.message);
    res.render('admin/user-roles', { users: [], roles: [], search: '' });
  }
});

router.post('/user-roles/:userId/assign', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const userRes = await pool.query('SELECT username FROM users WHERE id=$1', [req.params.userId]);
    if (!userRes.rows[0]) { req.flash('error', 'ইউজার পাওয়া যায়নি।'); return res.redirect('/admin/user-roles'); }
    await rbac.assignUserRole(req.params.userId, req.body.role_key || null);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_CHANGED',
      `"${userRes.rows[0].username}"-কে Role দেওয়া হয়েছে: ${req.body.role_key || '(কোনোটা না — সুপার-অ্যাডমিন-সমতুল্য)'}`, req.ip);
    req.flash('success', 'Role আপডেট হয়েছে।');
    res.redirect('/admin/user-roles');
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/admin/user-roles');
  }
});

router.get('/bot-monitoring/ip-rules', async (req, res) => {
  try {
    const rules = await listIpRules();
    res.render('admin/bot-ip-rules', { user: req.session.user, rules });
  } catch (err) {
    console.error('ip-rules list error:', err.message);
    res.render('admin/bot-ip-rules', { user: req.session.user, rules: [] });
  }
});

router.post('/bot-monitoring/ip-rules', async (req, res) => {
  const { ip, type, reason } = req.body;
  try {
    if (!ip || !['block', 'whitelist'].includes(type)) {
      req.flash('error', 'সঠিক IP ও টাইপ দিন।');
      return res.redirect('/admin/bot-monitoring/ip-rules');
    }
    await setIpRule(ip.trim(), type, sanitizeText(reason || ''), req.session.user.username);
    await logAdminAction(req.session.user.id, req.session.user.username, type === 'block' ? 'IP_BLOCKED' : 'IP_WHITELISTED', `IP: ${ip} — কারণ: ${reason || '-'}`, req.ip);
    req.flash('success', `IP ${ip} সফলভাবে ${type === 'block' ? 'ব্লক' : 'হোয়াইটলিস্ট'} করা হয়েছে।`);
    res.redirect('/admin/bot-monitoring/ip-rules');
  } catch (err) {
    console.error('ip-rules add error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে।');
    res.redirect('/admin/bot-monitoring/ip-rules');
  }
});

router.post('/bot-monitoring/ip-rules/:ip/remove', async (req, res) => {
  try {
    const ip = decodeURIComponent(req.params.ip);
    await removeIpRule(ip);
    await logAdminAction(req.session.user.id, req.session.user.username, 'IP_RULE_REMOVED', `IP: ${ip}`, req.ip);
    req.flash('success', `IP ${ip}-এর রুল সরানো হয়েছে।`);
    res.redirect('/admin/bot-monitoring/ip-rules');
  } catch (err) {
    console.error('ip-rules remove error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে।');
    res.redirect('/admin/bot-monitoring/ip-rules');
  }
});

router.get('/activity', async (req, res) => {
  try {
    const { action_type = '', q = '' } = req.query;
    const params = [];
    let query = 'SELECT * FROM admin_logs WHERE 1=1';
    if (action_type) {
      params.push(action_type);
      query += ` AND action_type = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (admin_username ILIKE $${params.length} OR details ILIKE $${params.length})`;
    }
    query += ' ORDER BY created_at DESC LIMIT 300';
    const result = await pool.query(query, params);
    const typesRes = await pool.query('SELECT DISTINCT action_type FROM admin_logs ORDER BY action_type');
    res.render('admin/activity', { logs: result.rows, actionTypes: typesRes.rows.map(r => r.action_type), filters: { action_type, q } });
  } catch (err) {
    console.error('Activity list error:', err.message);
    res.render('admin/activity', { logs: [], actionTypes: [], filters: { action_type: '', q: '' } });
  }
});

// ==================== System Diagnostics / Health Check ====================
router.get('/system-diagnostics', async (req, res) => {
  try {
    const { runAllChecks } = require('../services/healthCheck');
    const result = await runAllChecks();
    res.render('admin/system-diagnostics', { result, error: null });
  } catch (err) {
    console.error('System diagnostics error:', err.message);
    res.render('admin/system-diagnostics', { result: null, error: err.message });
  }
});

router.get('/api/system-diagnostics', async (req, res) => {
  try {
    const { runAllChecks } = require('../services/healthCheck');
    const result = await runAllChecks();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== Sentry মনিটরিং স্ট্যাটাস ও কনফিগারেশন ====================
router.get('/sentry-status', async (req, res) => {
  try {
    const sentryService = require('../services/sentry');
    res.render('admin/sentry-status', { status: sentryService.getStatus(), error: null, testSent: req.query.test === '1' });
  } catch (err) {
    console.error('Sentry status page error:', err.message);
    res.render('admin/sentry-status', { status: null, error: err.message, testSent: false });
  }
});

router.post('/sentry-status/test-error', async (req, res) => {
  try {
    const sentryService = require('../services/sentry');
    if (!sentryService.isEnabled()) {
      req.flash('error', '❌ Sentry নিষ্ক্রিয় আছে — টেস্ট এরর পাঠানো যায়নি। আগে SENTRY_DSN সেট করুন।');
      return res.redirect('/admin/sentry-status');
    }
    sentryService.captureException(new Error('Sentry টেস্ট এরর — অ্যাডমিন প্যানেল থেকে ম্যানুয়ালি পাঠানো হয়েছে'), {
      triggeredBy: req.session.user.username,
      testEvent: true
    });
    await logAdminAction(req.session.user.id, req.session.user.username, 'SENTRY_TEST_ERROR', 'অ্যাডমিন প্যানেল থেকে Sentry টেস্ট এরর পাঠানো হয়েছে', req.ip);
    res.redirect('/admin/sentry-status?test=1');
  } catch (err) {
    console.error('Sentry test error send failed:', err.message);
    req.flash('error', '❌ টেস্ট এরর পাঠাতে সমস্যা হয়েছে।');
    res.redirect('/admin/sentry-status');
  }
});

// ==================== Notification Template Management ====================
const templates = require('../services/templates');
const { sendSms } = require('../services/sms');

router.get('/notification-templates', async (req, res) => {
  try {
    const { channel = '', lang = '', q = '' } = req.query;
    const list = await templates.listTemplates({ channel, lang, q });
    res.render('admin/notification-templates', { list, filters: { channel, lang, q }, error: null, success: null });
  } catch (err) {
    console.error('notification-templates list error:', err.message);
    res.render('admin/notification-templates', { list: [], filters: { channel: '', lang: '', q: '' }, error: err.message, success: null });
  }
});

router.get('/notification-templates/new', (req, res) => {
  res.render('admin/notification-template-form', { tmpl: null, error: null });
});

router.post('/notification-templates', async (req, res) => {
  try {
    const { template_key, channel, lang, name, subject, body, is_active } = req.body;
    const tmpl = await templates.createTemplate(
      { template_key, channel, lang, name, subject, body, is_active: is_active === 'on' || is_active === 'true' },
      req.session.user.id, req.session.user.username
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'TEMPLATE_CREATE',
      `নতুন নোটিফিকেশন টেমপ্লেট তৈরি: ${tmpl.template_key} (${tmpl.channel}/${tmpl.lang})`, req.ip);
    req.flash && req.flash('success', 'টেমপ্লেট তৈরি হয়েছে');
    res.redirect('/admin/notification-templates');
  } catch (err) {
    console.error('template create error:', err.message);
    res.render('admin/notification-template-form', { tmpl: req.body, error: err.message });
  }
});

router.get('/notification-templates/:id/edit', async (req, res) => {
  try {
    const tmpl = await templates.getTemplateById(req.params.id);
    if (!tmpl) return res.redirect('/admin/notification-templates');
    res.render('admin/notification-template-form', { tmpl, error: null });
  } catch (err) {
    res.redirect('/admin/notification-templates');
  }
});

router.post('/notification-templates/:id', async (req, res) => {
  try {
    const { name, subject, body, is_active } = req.body;
    const tmpl = await templates.updateTemplate(
      req.params.id,
      { name, subject, body, is_active: is_active === 'on' || is_active === 'true' },
      req.session.user.id, req.session.user.username
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'TEMPLATE_UPDATE',
      `নোটিফিকেশন টেমপ্লেট আপডেট: ${tmpl.template_key} (${tmpl.channel}/${tmpl.lang})`, req.ip);
    res.redirect('/admin/notification-templates');
  } catch (err) {
    console.error('template update error:', err.message);
    const existing = await templates.getTemplateById(req.params.id).catch(() => null);
    res.render('admin/notification-template-form', { tmpl: existing || { id: req.params.id, ...req.body }, error: err.message });
  }
});

router.post('/notification-templates/:id/delete', async (req, res) => {
  try {
    const deleted = await templates.deleteTemplate(req.params.id);
    if (deleted) {
      await logAdminAction(req.session.user.id, req.session.user.username, 'TEMPLATE_DELETE',
        `নোটিফিকেশন টেমপ্লেট ডিলিট: ${deleted.template_key} (${deleted.channel}/${deleted.lang})`, req.ip);
    }
    res.redirect('/admin/notification-templates');
  } catch (err) {
    console.error('template delete error:', err.message);
    res.redirect('/admin/notification-templates');
  }
});

// প্রিভিউ — নমুনা ভ্যারিয়েবল দিয়ে রেন্ডার করে দেখায় (AJAX)
router.post('/notification-templates/:id/preview', async (req, res) => {
  try {
    const tmpl = await templates.getTemplateById(req.params.id);
    if (!tmpl) return res.status(404).json({ success: false, error: 'টেমপ্লেট পাওয়া যায়নি' });

    const sampleVars = {};
    (tmpl.variables || []).forEach(v => {
      const samples = { name: 'রহিম উদ্দিন', otp: '123456', amount: '৫,০০০', username: 'demo_user', date: new Date().toLocaleDateString('bn-BD') };
      sampleVars[v] = samples[v] || `[${v}]`;
    });
    const rendered = templates.renderTemplateRow(tmpl, { ...sampleVars, ...(req.body.variables || {}) });
    res.json({ success: true, subject: rendered.subject, body: rendered.body, sampleVars });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// টেস্ট সেন্ড — অ্যাডমিন নিজের ইমেইল/নম্বরে পাঠিয়ে দেখতে পারবে
router.post('/notification-templates/:id/test-send', async (req, res) => {
  try {
    const tmpl = await templates.getTemplateById(req.params.id);
    if (!tmpl) return res.status(404).json({ success: false, error: 'টেমপ্লেট পাওয়া যায়নি' });

    const target = (req.body.target || '').trim();
    if (!target) return res.status(400).json({ success: false, error: 'টেস্ট টার্গেট (ইমেইল/ফোন/ইউজার আইডি) দিন' });

    const sampleVars = {};
    (tmpl.variables || []).forEach(v => {
      const samples = { name: req.session.user.username, otp: '123456', amount: '৫,০০০', username: req.session.user.username, date: new Date().toLocaleDateString('bn-BD') };
      sampleVars[v] = samples[v] || `[${v}]`;
    });
    const rendered = templates.renderTemplateRow(tmpl, sampleVars);

    let result;
    if (tmpl.channel === 'email') {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        tls: { rejectUnauthorized: false }
      });
      await transporter.sendMail({
        from: `"LIVO (Test)" <${process.env.EMAIL_USER}>`,
        to: target,
        subject: `[TEST] ${rendered.subject || tmpl.name}`,
        html: rendered.body
      });
      result = { ok: true, message: `টেস্ট ইমেইল ${target}-এ পাঠানো হয়েছে` };
    } else if (tmpl.channel === 'sms') {
      result = await sendSms(target, rendered.body);
    } else {
      // in_app — সরাসরি notifications টেবিলে ইনসার্ট করা যায়, target হবে user id
      const userId = parseInt(target, 10);
      if (!userId) return res.status(400).json({ success: false, error: 'in-app টেস্টের জন্য বৈধ user ID দিন' });
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
        [userId, `[TEST] ${tmpl.name}`, rendered.body]
      );
      result = { ok: true, message: `টেস্ট নোটিফিকেশন user #${userId}-কে পাঠানো হয়েছে` };
    }

    await logAdminAction(req.session.user.id, req.session.user.username, 'TEMPLATE_TEST_SEND',
      `টেমপ্লেট টেস্ট-সেন্ড: ${tmpl.template_key} (${tmpl.channel}/${tmpl.lang}) → ${target}`, req.ip);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('template test-send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== ফ্রড লগ (Fraud Detection) ====================
// ==================== Fraud Monitoring Dashboard — Risk Score, Trend, Top Signals/Users ====================
router.get('/fraud-monitoring', async (req, res) => {
  try {
    const dashStats = await getFraudDashboardStats();
    res.render('admin/fraud-monitoring', { dashStats });
  } catch (err) {
    console.error('Fraud monitoring dashboard error:', err.message);
    res.render('admin/fraud-monitoring', {
      dashStats: {
        riskByLevel: { high: 0, medium: 0, low: 0 },
        statusCounts: { open: 0, reviewed: 0, dismissed: 0 },
        topSignals: [], topUsers: [], trend: [], avgOpenRiskScore: 0
      }
    });
  }
});

router.get('/fraud-logs', async (req, res) => {
  try {
    const { risk_level = '', status = '', user_id = '', from = '', to = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    if (risk_level) { params.push(risk_level); conditions.push(`risk_level = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (user_id) { params.push(user_id); conditions.push(`user_id = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM fraud_flags ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT f.*, u.username, u.email, u.phone
       FROM fraud_flags f LEFT JOIN users u ON u.id = f.user_id
       ${where}
       ORDER BY f.created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.render('admin/fraud-logs', {
      logs: result.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total,
      filters: { risk_level, status, user_id, from, to }
    });
  } catch (err) {
    console.error('Fraud logs list error:', err.message);
    res.render('admin/fraud-logs', {
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { risk_level: '', status: '', user_id: '', from: '', to: '' }
    });
  }
});

router.post('/fraud-logs/:id/review', requireIntParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const action = req.body.action === 'dismiss' ? 'dismissed' : 'reviewed';
    const r = await pool.query(
      `UPDATE fraud_flags SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING user_id`,
      [action, req.session.user.id, id]
    );
    if (r.rows[0]) {
      await logAdminAction(
        req.session.user.id, req.session.user.username, 'FRAUD_FLAG_REVIEWED',
        `ফ্রড ফ্ল্যাগ #${id} (ইউজার #${r.rows[0].user_id}) কে "${action}" হিসেবে চিহ্নিত করা হয়েছে`, req.ip
      );
    }
    req.flash('success', 'ফ্রড ফ্ল্যাগ আপডেট হয়েছে!');
  } catch (err) {
    console.error('Fraud flag review error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('back');
});

// ==================== Duplicate Account Detection ====================
router.get('/duplicate-accounts', async (req, res) => {
  try {
    const { status = '', min_score = '', user_id = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const result = await listDuplicateFlags({ status, minScore: min_score, userId: user_id, page, limit: 25 });
    res.render('admin/duplicate-accounts', {
      logs: result.logs, page: result.page, totalPages: result.totalPages, total: result.total,
      filters: { status, min_score, user_id }
    });
  } catch (err) {
    console.error('Duplicate accounts list error:', err.message);
    res.render('admin/duplicate-accounts', {
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { status: '', min_score: '', user_id: '' }
    });
  }
});

router.post('/duplicate-accounts/:id/review', requireIntParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const action = req.body.action === 'dismiss' ? 'dismissed' : 'reviewed';
    await reviewDuplicateFlag(id, action, req.session.user.id, req.session.user.username, req.ip);
    req.flash('success', 'ডুপ্লিকেট ফ্ল্যাগ আপডেট হয়েছে!');
  } catch (err) {
    console.error('Duplicate flag review error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('back');
});

router.post('/duplicate-accounts/scan', async (req, res) => {
  try {
    const count = await scanAllUsers();
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'DUPLICATE_ACCOUNT_SCAN_RUN',
      `ম্যানুয়াল স্ক্যান চালানো হয়েছে — ${count}টি নতুন ফ্ল্যাগ তৈরি হয়েছে`, req.ip
    );
    req.flash('success', `স্ক্যান সম্পন্ন! ${count}টি নতুন ফ্ল্যাগ তৈরি হয়েছে।`);
  } catch (err) {
    console.error('Duplicate account scan error:', err.message);
    req.flash('error', 'স্ক্যান ব্যর্থ হয়েছে!');
  }
  res.redirect('/admin/duplicate-accounts');
});


router.get('/reports', async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    const depositRes = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM payment_requests
       WHERE type = 'deposit' AND status = 'approved' AND created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'`,
      [from, to]
    );
    const withdrawRes = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM payment_requests
       WHERE type = 'withdraw' AND status = 'approved' AND created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'`,
      [from, to]
    );
    const betsRes = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS total_stake, COUNT(*) AS cnt,
              COALESCE(SUM(stake * odd) FILTER (WHERE status = 'won'),0) AS total_payout
       FROM bets WHERE created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'`,
      [from, to]
    );
    const usersRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'`,
      [from, to]
    );

    const deposits = depositRes.rows[0];
    const withdrawals = withdrawRes.rows[0];
    const bets = betsRes.rows[0];
    const netRevenue = parseFloat(bets.total_stake) - parseFloat(bets.total_payout);

    // ==== দৈনিক GGR ট্রেন্ড (চার্টের জন্য) ====
    const ggrTrendRes = await pool.query(`
      SELECT d::date AS day,
             COALESCE(SUM(b.stake) FILTER (WHERE b.created_at::date = d::date),0) AS staked,
             COALESCE(SUM(b.stake * b.odd) FILTER (WHERE b.created_at::date = d::date AND b.status='won'),0) AS payout
      FROM generate_series($1::date, $2::date, '1 day') d
      LEFT JOIN bets b ON b.created_at::date = d::date
      GROUP BY d ORDER BY d
    `, [from, to]);
    const ggrTrend = ggrTrendRes.rows.map(r => ({
      day: r.day, ggr: Number(r.staked) - Number(r.payout)
    }));

    // ==== দৈনিক নতুন ইউজার ট্রেন্ড ====
    const userTrendRes = await pool.query(`
      SELECT d::date AS day, COUNT(u.id) AS cnt
      FROM generate_series($1::date, $2::date, '1 day') d
      LEFT JOIN users u ON u.created_at::date = d::date
      GROUP BY d ORDER BY d
    `, [from, to]);
    const userTrend = userTrendRes.rows.map(r => ({ day: r.day, count: parseInt(r.cnt) }));

    res.render('admin/reports', {
      from, to, deposits, withdrawals, bets, newUsers: usersRes.rows[0].cnt, netRevenue,
      ggrTrend, userTrend
    });
  } catch (err) {
    console.error('Reports error:', err.message);
    res.render('admin/reports', {
      from: '', to: '',
      deposits: { total: 0, cnt: 0 }, withdrawals: { total: 0, cnt: 0 },
      bets: { total_stake: 0, cnt: 0, total_payout: 0 }, newUsers: 0, netRevenue: 0,
      ggrTrend: [], userTrend: []
    });
  }
});

// ==================== Background Queue System ড্যাশবোর্ড (BullMQ + Redis) ====================
router.get('/queues', async (req, res) => {
  try {
    const { getQueueHealthStats } = require('../queues');
    const health = await getQueueHealthStats();

    const dlqRes = await pool.query(
      `SELECT * FROM queue_dead_letter WHERE status = 'dead' ORDER BY created_at DESC LIMIT 100`
    );

    res.render('admin/queues', { health, deadLetterJobs: dlqRes.rows });
  } catch (err) {
    console.error('Queue dashboard error:', err.message);
    res.render('admin/queues', { health: { redisConnected: false, queues: [] }, deadLetterJobs: [] });
  }
});

// লাইভ স্ট্যাটাস পোলিং-এর জন্য JSON এন্ডপয়েন্ট (ড্যাশবোর্ড প্রতি কয়েক সেকেন্ডে রিফ্রেশ করে)
router.get('/queues/api/stats', async (req, res) => {
  try {
    const { getQueueHealthStats } = require('../queues');
    const health = await getQueueHealthStats();
    res.json({ success: true, health });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// নির্দিষ্ট Queue-এর একটা state (waiting/active/failed ইত্যাদি)-এর জব লিস্ট
router.get('/queues/api/jobs/:queueName', async (req, res) => {
  try {
    const { getRecentJobs } = require('../queues');
    const state = req.query.state || 'failed';
    const jobs = await getRecentJobs(req.params.queueName, state, 30);
    res.json({ success: true, jobs });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Dead-letter জব রিট্রাই (আবার মূল Queue-তে পাঠানো)
router.post('/queues/dead-letter/:id/retry', async (req, res) => {
  try {
    const { retryDeadLetterJob } = require('../queues');
    await retryDeadLetterJob(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Dead-letter জব ডিলিট
router.post('/queues/dead-letter/:id/delete', async (req, res) => {
  try {
    const { deleteDeadLetterJob } = require('../queues');
    await deleteDeadLetterJob(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ম্যানুয়ালি একটা Fraud Scan ট্রিগার করা (টেস্টিং/অ্যাডহক ব্যবহারের জন্য)
router.post('/queues/fraud-scan/:userId', async (req, res) => {
  try {
    const { enqueueFraudScan } = require('../queues');
    const result = await enqueueFraudScan({ userId: parseInt(req.params.userId, 10), triggeredBy: 'admin' });
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ==================== LOGIN HISTORY (সব ইউজারের, সার্চ/ফিল্টার সহ) ====================
router.get('/login-history', async (req, res) => {
  try {
    const { q = '', new_device = '', from = '', to = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 30;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(u.username ILIKE $${params.length} OR l.ip ILIKE $${params.length} OR l.location ILIKE $${params.length})`);
    }
    if (new_device === '1') conditions.push(`l.is_new_device = true`);
    if (from) { params.push(from); conditions.push(`l.created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`l.created_at <= $${params.length}::date + INTERVAL '1 day'`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM login_logs l LEFT JOIN users u ON u.id = l.user_id ${where}`, params
    );
    const total = parseInt(countRes.rows[0].count);

    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT l.*, u.username
       FROM login_logs l LEFT JOIN users u ON u.id = l.user_id
       ${where}
       ORDER BY l.created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const { parseUserAgent } = require('../services/deviceTracking');
    const logs = result.rows.map(row => ({ ...row, ...parseUserAgent(row.user_agent) }));

    res.render('admin/login-history', {
      logs, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)),
      filters: { q, new_device, from, to }
    });
  } catch (err) {
    console.error('Login history error:', err && err.stack ? err.stack : err);
    res.render('admin/login-history', {
      logs: [], total: 0, page: 1, limit: 30, totalPages: 1, filters: { q: '', new_device: '', from: '', to: '' }
    });
  }
});

// ==================== API KEY ম্যানেজমেন্ট ====================
const crypto = require('crypto');

function generateApiKey() {
  const raw = 'lvo_' + crypto.randomBytes(32).toString('hex'); // ব্যবহারকারীকে একবারই দেখানো হয়, DB-তে শুধু hash থাকে
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

router.get('/api-keys', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT k.*, u.username AS created_by_username
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
       ORDER BY k.created_at DESC`
    );
    res.render('admin/api-keys', { keys: result.rows, newKey: null });
  } catch (err) {
    console.error('API keys list error:', err.message);
    res.render('admin/api-keys', { keys: [], newKey: null });
  }
});

router.post('/api-keys/create', async (req, res) => {
  try {
    const name = sanitizeText(req.body.name || '').slice(0, 100);
    const description = sanitizeText(req.body.description || '').slice(0, 500);
    const scopesInput = Array.isArray(req.body.scopes) ? req.body.scopes : (req.body.scopes ? [req.body.scopes] : []);
    const allowedScopes = ['read:matches', 'read:leaderboard', 'read:tournaments'];
    const scopes = scopesInput.filter(s => allowedScopes.includes(s));
    const expiresInDays = parseInt(req.body.expires_in_days) || null;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null;

    if (!name) {
      req.flash('error', 'কী-এর নাম দিতে হবে।');
      return res.redirect('/admin/api-keys');
    }
    if (!scopes.length) {
      req.flash('error', 'অন্তত একটি scope নির্বাচন করতে হবে।');
      return res.redirect('/admin/api-keys');
    }

    const { raw, hash } = generateApiKey();
    const inserted = await pool.query(
      `INSERT INTO api_keys (key_hash, name, description, scopes, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [hash, name, description || null, scopes, expiresAt, req.session.user.id]
    );

    await logAdminAction(req.session.user.id, req.session.user.username, 'API_KEY_CREATED',
      `নতুন API key তৈরি: "${name}" (scopes: ${scopes.join(', ')})`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'API_KEY_CREATED', category: 'api', status: 'success', riskLevel: 'medium',
      details: { keyId: inserted.rows[0] && inserted.rows[0].id, name, scopes }
    }).catch(e => console.error('logAuditEvent (API_KEY_CREATED) error:', e.message));

    const result = await pool.query(
      `SELECT k.*, u.username AS created_by_username
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
       ORDER BY k.created_at DESC`
    );
    res.render('admin/api-keys', { keys: result.rows, newKey: raw });
  } catch (err) {
    console.error('API key create error:', err.message);
    req.flash('error', 'API key তৈরি করতে সমস্যা হয়েছে।');
    res.redirect('/admin/api-keys');
  }
});

router.post('/api-keys/:id/toggle', requireIntParam('id'), async (req, res) => {
  try {
    const r = await pool.query(`UPDATE api_keys SET enabled = NOT enabled WHERE id = $1 RETURNING name, enabled`, [req.params.id]);
    if (r.rows[0]) {
      await logAdminAction(req.session.user.id, req.session.user.username, 'API_KEY_TOGGLED',
        `API key "${r.rows[0].name}" ${r.rows[0].enabled ? 'চালু' : 'বন্ধ'} করা হয়েছে`, req.ip);
      req.flash('success', `API key ${r.rows[0].enabled ? 'চালু' : 'বন্ধ'} করা হয়েছে।`);
    }
  } catch (err) {
    console.error('API key toggle error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে।');
  }
  res.redirect('/admin/api-keys');
});

router.post('/api-keys/:id/revoke', requireIntParam('id'), async (req, res) => {
  try {
    const r = await pool.query(`UPDATE api_keys SET enabled = false WHERE id = $1 RETURNING name`, [req.params.id]);
    if (r.rows[0]) {
      await logAdminAction(req.session.user.id, req.session.user.username, 'API_KEY_REVOKED',
        `API key "${r.rows[0].name}" revoke করা হয়েছে`, req.ip);
      logAuditEvent({
        req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
        action: 'API_KEY_REVOKED', category: 'api', status: 'success', riskLevel: 'medium',
        details: { keyId: req.params.id, name: r.rows[0].name }
      }).catch(e => console.error('logAuditEvent (API_KEY_REVOKED) error:', e.message));
      req.flash('success', 'API key revoke করা হয়েছে।');
    }
  } catch (err) {
    console.error('API key revoke error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে।');
  }
  res.redirect('/admin/api-keys');
});

// ==================== API USAGE লগ ও অ্যানালিটিক্স ====================
router.get('/api-logs', async (req, res) => {
  try {
    const { endpoint = '', method = '', status = '', ip = '', api_key_id = '', from = '', to = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 40;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    if (endpoint) { params.push(`%${endpoint}%`); conditions.push(`l.endpoint ILIKE $${params.length}`); }
    if (method) { params.push(method); conditions.push(`l.method = $${params.length}`); }
    if (status) { params.push(parseInt(status)); conditions.push(`l.status_code = $${params.length}`); }
    if (ip) { params.push(ip); conditions.push(`l.ip = $${params.length}`); }
    if (api_key_id) { params.push(api_key_id); conditions.push(`l.api_key_id = $${params.length}`); }
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

    // অ্যানালিটিক্স সারাংশ — একই ফিল্টার উইন্ডোতে key/status/response-time ব্রেকডাউন
    const analytics = await pool.query(
      `SELECT
         COUNT(*) AS total_requests,
         COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS success_count,
         COUNT(*) FILTER (WHERE status_code >= 400) AS error_count,
         COALESCE(AVG(response_time_ms), 0) AS avg_response_ms,
         COALESCE(MAX(response_time_ms), 0) AS max_response_ms
       FROM api_usage_logs l ${where}`,
      params
    );

    const topKeys = await pool.query(
      `SELECT k.name, COUNT(*) AS request_count
       FROM api_usage_logs l JOIN api_keys k ON k.id = l.api_key_id
       ${where ? where + ' AND' : 'WHERE'} l.api_key_id IS NOT NULL
       GROUP BY k.name ORDER BY request_count DESC LIMIT 5`,
      params
    );

    const keysForFilter = await pool.query(`SELECT id, name FROM api_keys ORDER BY name`);

    res.render('admin/api-logs', {
      logs: result.rows,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      total,
      filters: { endpoint, method, status, ip, api_key_id, from, to },
      analytics: analytics.rows[0],
      topKeys: topKeys.rows,
      apiKeys: keysForFilter.rows
    });
  } catch (err) {
    console.error('API logs list error:', err.message);
    res.render('admin/api-logs', {
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { endpoint: '', method: '', status: '', ip: '', api_key_id: '', from: '', to: '' },
      analytics: { total_requests: 0, success_count: 0, error_count: 0, avg_response_ms: 0, max_response_ms: 0 },
      topKeys: [], apiKeys: []
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

    await logAdminAction(req.session.user.id, req.session.user.username, 'API_LOGS_EXPORTED', 'API usage logs CSV এক্সপোর্ট করা হয়েছে', req.ip);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="api-usage-logs-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('API logs CSV export error:', err.message);
    res.status(500).send('Export failed');
  }
});

// ==================== REDIS CACHE MANAGEMENT ====================
router.get('/cache', async (req, res) => {
  try {
    const cacheStats = await cache.getDetailedStats();
    res.render('admin/cache', { cacheStats, cleared: req.query.cleared || '' });
  } catch (err) {
    console.error('Cache page error:', err && err.stack ? err.stack : err);
    res.render('admin/cache', {
      cacheStats: { enabled: false, connected: false, totalKeys: 0, categories: [], hits: 0, misses: 0, hitRatePercent: null, memoryUsed: null },
      cleared: ''
    });
  }
});

router.post('/cache/clear', async (req, res) => {
  try {
    const { pattern } = req.body;
    let deleted;
    if (pattern && pattern !== '*') {
      deleted = await cache.delByPattern(pattern);
    } else {
      deleted = await cache.flushAll();
    }
    await logAdminAction(req.session.user.id, req.session.user.username, 'CACHE_CLEARED', `ক্যাশ পরিষ্কার করা হয়েছে (pattern: ${pattern || 'সব'}) — ${deleted} টি কী মুছে গেছে`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'CACHE_CLEARED', category: 'cache', status: 'success', riskLevel: 'medium',
      details: { pattern: pattern || '*', deletedCount: deleted }
    }).catch(e => console.error('logAuditEvent (CACHE_CLEARED) error:', e.message));
    res.redirect(`/admin/cache?cleared=${deleted}`);
  } catch (err) {
    console.error('Cache clear error:', err && err.stack ? err.stack : err);
    res.redirect('/admin/cache');
  }
});

// ==================== BACKUP & RESTORE SYSTEM ====================
const backupManager = require('../services/backupManager');

router.get('/backups', async (req, res) => {
  try {
    const { type = '' } = req.query;
    const backups = await backupManager.listBackups({ type, limit: 100 });
    res.render('admin/backups', {
      backups, filterType: type,
      encryptionEnabled: backupManager.isEncryptionEnabled(),
      created: req.query.created || '', restored: req.query.restored || '', error: req.query.error || ''
    });
  } catch (err) {
    console.error('Backups page error:', err && err.stack ? err.stack : err);
    res.render('admin/backups', { backups: [], filterType: '', encryptionEnabled: false, created: '', restored: '', error: 'load_failed' });
  }
});

router.post('/backups/create', async (req, res) => {
  try {
    const { type } = req.body; // 'database' | 'uploads' | 'config' | 'all'
    const ctx = { source: 'manual', createdById: req.session.user.id, createdByUsername: req.session.user.username };
    const created = [];
    if (type === 'database' || type === 'all') created.push(await backupManager.createDatabaseBackup(ctx));
    if (type === 'uploads' || type === 'all') created.push(await backupManager.createUploadsBackup(ctx));
    if (type === 'config' || type === 'all') created.push(await backupManager.createConfigBackup(ctx));

    const failed = created.filter(c => c.status === 'failed');
    for (const c of created) {
      await logAdminAction(
        req.session.user.id, req.session.user.username,
        c.status === 'completed' ? 'BACKUP_CREATED' : 'BACKUP_FAILED',
        `${c.type} ব্যাকআপ ${c.status === 'completed' ? 'সম্পন্ন হয়েছে' : 'ব্যর্থ হয়েছে: ' + c.error_message} (${c.filename})`,
        req.ip
      );
      logAuditEvent({
        req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
        action: 'BACKUP_CREATED', category: 'backup',
        status: c.status === 'completed' ? 'success' : 'failure',
        riskLevel: c.status === 'completed' ? 'low' : 'medium',
        details: { type: c.type, filename: c.filename, error: c.error_message || null }
      }).catch(e => console.error('logAuditEvent (BACKUP_CREATED) error:', e.message));
    }
    res.redirect(`/admin/backups?created=${created.length}${failed.length ? '&error=' + failed.length + '_failed' : ''}`);
  } catch (err) {
    console.error('Backup create error:', err && err.stack ? err.stack : err);
    res.redirect('/admin/backups?error=1');
  }
});

router.get('/backups/:id/download', async (req, res) => {
  try {
    const record = await backupManager.getBackupById(req.params.id);
    if (!record || record.status !== 'completed') return res.status(404).send('ব্যাকআপ পাওয়া যায়নি।');
    const filePath = backupManager.getBackupFilePath(record);
    await logAdminAction(req.session.user.id, req.session.user.username, 'BACKUP_DOWNLOADED', `${record.type} ব্যাকআপ ডাউনলোড হয়েছে (${record.filename})`, req.ip);
    res.download(filePath, record.filename);
  } catch (err) {
    console.error('Backup download error:', err && err.stack ? err.stack : err);
    res.status(500).send('ডাউনলোড ব্যর্থ।');
  }
});

router.post('/backups/:id/restore', async (req, res) => {
  try {
    const record = await backupManager.getBackupById(req.params.id);
    if (!record) return res.redirect('/admin/backups?error=not_found');
    const result = await backupManager.restoreBackup(record);
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'BACKUP_RESTORED',
      `${record.type} ব্যাকআপ রিস্টোর করা হয়েছে (${record.filename}) — ${JSON.stringify(result).slice(0, 300)}`,
      req.ip
    );
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'BACKUP_RESTORED', category: 'restore', status: 'success', riskLevel: 'critical',
      details: { backupId: req.params.id, type: record.type, filename: record.filename }
    }).catch(e => console.error('logAuditEvent (BACKUP_RESTORED) error:', e.message));
    res.redirect(`/admin/backups?restored=${record.type}`);
  } catch (err) {
    console.error('Backup restore error:', err && err.stack ? err.stack : err);
    await logAdminAction(req.session.user.id, req.session.user.username, 'BACKUP_RESTORE_FAILED', `রিস্টোর ব্যর্থ (#${req.params.id}): ${err.message}`, req.ip).catch(() => {});
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'BACKUP_RESTORE_FAILED', category: 'restore', status: 'failure', riskLevel: 'critical',
      details: { backupId: req.params.id, error: err.message }
    }).catch(e => console.error('logAuditEvent (BACKUP_RESTORE_FAILED) error:', e.message));
    res.redirect(`/admin/backups?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/backups/:id/delete', async (req, res) => {
  try {
    const record = await backupManager.getBackupById(req.params.id);
    await backupManager.deleteBackup(req.params.id);
    if (record) await logAdminAction(req.session.user.id, req.session.user.username, 'BACKUP_DELETED', `${record.type} ব্যাকআপ ডিলিট করা হয়েছে (${record.filename})`, req.ip);
    res.redirect('/admin/backups');
  } catch (err) {
    console.error('Backup delete error:', err && err.stack ? err.stack : err);
    res.redirect('/admin/backups?error=delete_failed');
  }
});

// ==================== Advanced Audit Log Dashboard ====================
router.get('/audit-logs', async (req, res) => {
  try {
    const { q = '', actorType = '', category = '', status = '', riskLevel = '', action = '', from = '', to = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const filters = { q, actorType, category, status, riskLevel, action, from, to };

    const [{ rows, total, totalPages }, categoryCounts, riskCounts] = await Promise.all([
      listAuditLogs(filters, { page, limit: 30 }),
      getCategoryCounts(),
      getRiskCounts()
    ]);

    res.render('admin/audit-logs', {
      logs: rows, total, page, totalPages, filters,
      categoryCounts, riskCounts,
      categories: VALID_CATEGORIES, riskLevels: VALID_RISK_LEVELS
    });
  } catch (err) {
    console.error('Audit log dashboard error:', err.message);
    res.render('admin/audit-logs', {
      logs: [], total: 0, page: 1, totalPages: 1,
      filters: { q: '', actorType: '', category: '', status: '', riskLevel: '', action: '', from: '', to: '' },
      categoryCounts: [], riskCounts: { low: 0, medium: 0, high: 0, critical: 0 },
      categories: VALID_CATEGORIES, riskLevels: VALID_RISK_LEVELS
    });
  }
});

// Log Details Modal-এর জন্য — AJAX দিয়ে fetch হয়
router.get('/audit-logs/:id.json', requireIntParam('id'), async (req, res) => {
  try {
    const log = await getAuditLogById(req.params.id);
    if (!log) return res.status(404).json({ error: 'পাওয়া যায়নি' });
    res.json(log);
  } catch (err) {
    console.error('Audit log detail error:', err.message);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

router.get('/audit-logs/export.csv', async (req, res) => {
  try {
    const { q = '', actorType = '', category = '', status = '', riskLevel = '', action = '', from = '', to = '' } = req.query;
    const rows = await exportAuditLogs({ q, actorType, category, status, riskLevel, action, from, to });

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['id', 'created_at', 'actor_type', 'actor_username', 'action', 'category', 'status', 'risk_level', 'ip_address', 'device_name', 'browser', 'os', 'location', 'request_id', 'details'];
    const csvRows = rows.map(r => header.map(h => esc(h === 'details' ? JSON.stringify(r[h]) : r[h])).join(','));
    const csv = [header.join(','), ...csvRows].join('\n');

    await logAdminAction(req.session.user.id, req.session.user.username, 'AUDIT_LOG_EXPORTED', `Audit log CSV এক্সপোর্ট (${rows.length} রো)`, req.ip);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('Audit log CSV export error:', err.message);
    res.status(500).send('Export failed');
  }
});

// ==================== FEATURE FLAGS & CONFIGURATION MANAGEMENT ====================
const featureFlags = require('../services/featureFlags');

router.get('/feature-flags', async (req, res) => {
  try {
    const flags = await featureFlags.loadAllFlags();
    res.render('admin/feature-flags', { flags: flags || [], created: req.query.created || '', error: req.query.error || '' });
  } catch (err) {
    console.error('Feature flags page error:', err && err.stack ? err.stack : err);
    res.render('admin/feature-flags', { flags: [], created: '', error: 'load_failed' });
  }
});

router.post('/feature-flags/:id/toggle', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM feature_flags WHERE id = $1', [req.params.id]);
    const flag = r.rows[0];
    if (!flag) return res.redirect('/admin/feature-flags?error=not_found');
    const newState = !flag.enabled;
    await featureFlags.setFlag(flag.key, newState, req.session.user.id, req.session.user.username);
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'FEATURE_FLAG_TOGGLED',
      `"${flag.label}" (${flag.key}) ${newState ? 'চালু' : 'বন্ধ'} করা হয়েছে`, req.ip
    );
    res.redirect('/admin/feature-flags');
  } catch (err) {
    console.error('Feature flag toggle error:', err && err.stack ? err.stack : err);
    res.redirect('/admin/feature-flags?error=toggle_failed');
  }
});

router.post('/feature-flags/create', async (req, res) => {
  try {
    const { key, label, category, description } = req.body;
    const created = await featureFlags.createFlag({
      key: (key || '').trim(), label: (label || '').trim(), category, description,
      enabled: false, adminId: req.session.user.id, adminUsername: req.session.user.username
    });
    await logAdminAction(req.session.user.id, req.session.user.username, 'FEATURE_FLAG_CREATED', `নতুন ফ্ল্যাগ তৈরি হয়েছে: "${created.label}" (${created.key}, ${created.category})`, req.ip);
    res.redirect('/admin/feature-flags?created=1');
  } catch (err) {
    console.error('Feature flag create error:', err && err.stack ? err.stack : err);
    res.redirect(`/admin/feature-flags?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/feature-flags/:id/delete', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM feature_flags WHERE id = $1', [req.params.id]);
    const flag = r.rows[0];
    await featureFlags.deleteFlag(req.params.id);
    if (flag) await logAdminAction(req.session.user.id, req.session.user.username, 'FEATURE_FLAG_DELETED', `"${flag.label}" (${flag.key}) ডিলিট করা হয়েছে`, req.ip);
    res.redirect('/admin/feature-flags');
  } catch (err) {
    console.error('Feature flag delete error:', err && err.stack ? err.stack : err);
    res.redirect('/admin/feature-flags?error=delete_failed');
  }
});

const fs = require('fs');
const path = require('path');
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

function readLocale(code) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, code + '.json'), 'utf8'));
}
function writeLocale(code, obj) {
  const sorted = {};
  Object.keys(obj).sort().forEach(k => sorted[k] = obj[k]);
  fs.writeFileSync(path.join(LOCALES_DIR, code + '.json'), JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}
function refreshCache(req) {
  const fn = req.app.get('refreshTranslationsCache');
  if (fn) fn();
}

router.get('/localization', (req, res) => {
  try {
    const bn = readLocale('bn');
    const en = readLocale('en');
    const q = (req.query.q || '').trim().toLowerCase();
    const allKeys = Array.from(new Set([...Object.keys(bn), ...Object.keys(en)])).sort();
    const rows = allKeys
      .filter(k => !q || k.toLowerCase().includes(q) || (bn[k] || '').toLowerCase().includes(q) || (en[k] || '').toLowerCase().includes(q))
      .map(k => ({ key: k, bn: bn[k] || '', en: en[k] || '', missingBn: !bn[k], missingEn: !en[k] }));
    const missingCount = rows.filter(r => r.missingBn || r.missingEn).length;
    res.render('admin/localization', { rows, q: req.query.q || '', total: allKeys.length, missingCount, saved: req.query.saved === '1' });
  } catch (err) {
    console.error('Localization load error:', err.message);
    res.render('admin/localization', { rows: [], q: '', total: 0, missingCount: 0, saved: false });
  }
});

router.post('/localization/create', async (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    const bnVal = req.body.bn || '';
    const enVal = req.body.en || '';
    if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) {
      req.flash('error', 'Key শুধু ইংরেজি অক্ষর, সংখ্যা ও আন্ডারস্কোর দিয়ে হতে হবে।');
      return res.redirect('/admin/localization');
    }
    const bn = readLocale('bn'); const en = readLocale('en');
    bn[key] = bnVal; en[key] = enVal;
    writeLocale('bn', bn); writeLocale('en', en);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_KEY_CREATED', `Key তৈরি: ${key}`, req.ip);
    req.flash('success', '✅ নতুন Key তৈরি হয়েছে।');
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', 'Key তৈরি করতে সমস্যা হয়েছে।');
    res.redirect('/admin/localization');
  }
});

router.post('/localization/update', async (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    const bnVal = req.body.bn || '';
    const enVal = req.body.en || '';
    if (!key) { req.flash('error', 'Key পাওয়া যায়নি।'); return res.redirect('/admin/localization'); }
    const bn = readLocale('bn'); const en = readLocale('en');
    bn[key] = bnVal; en[key] = enVal;
    writeLocale('bn', bn); writeLocale('en', en);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_KEY_UPDATED', `Key আপডেট: ${key}`, req.ip);
    req.flash('success', '✅ Key আপডেট হয়েছে।');
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', 'Key আপডেট করতে সমস্যা হয়েছে।');
    res.redirect('/admin/localization');
  }
});

router.post('/localization/delete', async (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    const bn = readLocale('bn'); const en = readLocale('en');
    delete bn[key]; delete en[key];
    writeLocale('bn', bn); writeLocale('en', en);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_KEY_DELETED', `Key ডিলিট: ${key}`, req.ip);
    req.flash('success', '✅ Key ডিলিট হয়েছে।');
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', 'Key ডিলিট করতে সমস্যা হয়েছে।');
    res.redirect('/admin/localization');
  }
});

router.get('/localization/export/:lang', (req, res) => {
  try {
    const lang = req.params.lang === 'en' ? 'en' : 'bn';
    const data = readLocale(lang);
    res.setHeader('Content-Disposition', `attachment; filename="${lang}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).send('Export failed');
  }
});

router.get('/audit-logs/export.xlsx', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { q = '', actorType = '', category = '', status = '', riskLevel = '', action = '', from = '', to = '' } = req.query;
    const rows = await exportAuditLogs({ q, actorType, category, status, riskLevel, action, from, to });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Audit Logs');
    sheet.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Time', key: 'created_at', width: 22 },
      { header: 'Actor Type', key: 'actor_type', width: 12 },
      { header: 'Actor', key: 'actor_username', width: 18 },
      { header: 'Action', key: 'action', width: 22 },
      { header: 'Category', key: 'category', width: 14 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Risk Level', key: 'risk_level', width: 12 },
      { header: 'IP', key: 'ip_address', width: 16 },
      { header: 'Device', key: 'device_name', width: 24 },
      { header: 'Browser', key: 'browser', width: 14 },
      { header: 'OS', key: 'os', width: 14 },
      { header: 'Location', key: 'location', width: 20 },
      { header: 'Request ID', key: 'request_id', width: 24 },
      { header: 'Details', key: 'details', width: 40 }
    ];
    sheet.getRow(1).font = { bold: true };
    rows.forEach(r => sheet.addRow({ ...r, details: JSON.stringify(r.details || {}) }));

    await logAdminAction(req.session.user.id, req.session.user.username, 'AUDIT_LOG_EXPORTED', `Audit log Excel এক্সপোর্ট (${rows.length} রো)`, req.ip);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Audit log Excel export error:', err.message);
    res.status(500).send('Export failed');
  }
});

router.post('/localization/import/:lang', async (req, res) => {
  try {
    const lang = req.params.lang === 'en' ? 'en' : 'bn';
    let incoming;
    try { incoming = JSON.parse(req.body.json || '{}'); } catch (e) {
      req.flash('error', 'বৈধ JSON না — পার্স করা যায়নি।');
      return res.redirect('/admin/localization');
    }
    if (typeof incoming !== 'object' || Array.isArray(incoming) || incoming === null) {
      req.flash('error', 'JSON অবশ্যই key-value অবজেক্ট হতে হবে।');
      return res.redirect('/admin/localization');
    }
    const current = readLocale(lang);
    const merged = Object.assign({}, current, incoming);
    writeLocale(lang, merged);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_IMPORTED', `${lang}.json import (${Object.keys(incoming).length}টি key)`, req.ip);
    req.flash('success', `✅ ${Object.keys(incoming).length}টি Key ইম্পোর্ট হয়েছে (${lang})।`);
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', 'ইম্পোর্ট ব্যর্থ হয়েছে।');
    res.redirect('/admin/localization');
  }
});

router.post('/localization/refresh-cache', async (req, res) => {
  try {
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_CACHE_REFRESHED', 'Translation cache রিফ্রেশ করা হয়েছে', req.ip);
    req.flash('success', '✅ Cache রিফ্রেশ হয়েছে।');
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', 'Cache রিফ্রেশ ব্যর্থ হয়েছে।');
    res.redirect('/admin/localization');
  }
});

// ==================== Announcement / Broadcast System ====================
router.get('/announcements', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
    res.render('admin/announcements', { list: r.rows, error: req.query.error || '', created: req.query.created === '1' });
  } catch (err) {
    console.error('Announcements list error:', err.message);
    res.render('admin/announcements', { list: [], error: 'load_failed', created: false });
  }
});

router.post('/announcements/create', async (req, res) => {
  try {
    const { type, title_bn, title_en, message_bn, message_en, target_type, target_role, target_user_id, starts_at, expires_at } = req.body;
    if (!message_bn || !message_bn.trim()) {
      return res.redirect('/admin/announcements?error=' + encodeURIComponent('বাংলা মেসেজ আবশ্যক'));
    }
    const r = await pool.query(
      `INSERT INTO announcements (type, title_bn, title_en, message_bn, message_en, target_type, target_role, target_user_id, starts_at, expires_at, created_by, created_by_username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, NOW()), $10, $11, $12) RETURNING id`,
      [
        type || 'banner', title_bn || null, title_en || null, message_bn, message_en || null,
        target_type || 'all', target_type === 'role' ? (target_role || null) : null,
        target_type === 'user' ? (parseInt(target_user_id) || null) : null,
        starts_at || null, expires_at || null,
        req.session.user.id, req.session.user.username
      ]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'ANNOUNCEMENT_CREATED', `নতুন ${type} announcement তৈরি হয়েছে (#${r.rows[0].id})`, req.ip);
    res.redirect('/admin/announcements?created=1');
  } catch (err) {
    console.error('Announcement create error:', err.message);
    res.redirect('/admin/announcements?error=' + encodeURIComponent('তৈরি করতে সমস্যা হয়েছে'));
  }
});

router.post('/announcements/:id/update', async (req, res) => {
  try {
    const { type, title_bn, title_en, message_bn, message_en, target_type, target_role, target_user_id, starts_at, expires_at } = req.body;
    await pool.query(
      `UPDATE announcements SET type=$1, title_bn=$2, title_en=$3, message_bn=$4, message_en=$5,
       target_type=$6, target_role=$7, target_user_id=$8, starts_at=COALESCE($9, starts_at), expires_at=$10, updated_at=NOW()
       WHERE id=$11`,
      [
        type || 'banner', title_bn || null, title_en || null, message_bn, message_en || null,
        target_type || 'all', target_type === 'role' ? (target_role || null) : null,
        target_type === 'user' ? (parseInt(target_user_id) || null) : null,
        starts_at || null, expires_at || null, req.params.id
      ]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'ANNOUNCEMENT_UPDATED', `Announcement আপডেট হয়েছে (#${req.params.id})`, req.ip);
    res.redirect('/admin/announcements?created=1');
  } catch (err) {
    console.error('Announcement update error:', err.message);
    res.redirect('/admin/announcements?error=' + encodeURIComponent('আপডেট ব্যর্থ হয়েছে'));
  }
});

router.post('/announcements/:id/toggle', async (req, res) => {
  try {
    const r = await pool.query('UPDATE announcements SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING active', [req.params.id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ANNOUNCEMENT_TOGGLED', `Announcement #${req.params.id} ${r.rows[0].active ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে`, req.ip);
    res.redirect('/admin/announcements');
  } catch (err) {
    res.redirect('/admin/announcements?error=toggle_failed');
  }
});

router.post('/announcements/:id/expire-now', async (req, res) => {
  try {
    await pool.query('UPDATE announcements SET expires_at = NOW(), updated_at = NOW() WHERE id = $1', [req.params.id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ANNOUNCEMENT_EXPIRED', `Announcement #${req.params.id} এখনই expire করা হয়েছে`, req.ip);
    res.redirect('/admin/announcements');
  } catch (err) {
    res.redirect('/admin/announcements?error=expire_failed');
  }
});

router.post('/announcements/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ANNOUNCEMENT_DELETED', `Announcement #${req.params.id} ডিলিট করা হয়েছে`, req.ip);
    res.redirect('/admin/announcements');
  } catch (err) {
    res.redirect('/admin/announcements?error=delete_failed');
  }
});

router.get('/diagnostics', async (req, res) => {
  try {
    const report = await runAllChecks();
    res.render('admin/diagnostics', { report, active: 'diagnostics' });
  } catch (err) {
    console.error('Diagnostics error:', err.message);
    res.render('admin/diagnostics', {
      report: { overall: 'error', timestamp: new Date().toISOString(), checks: {} },
      active: 'diagnostics'
    });
  }
});

// Diagnostics JSON API (polling)
router.get('/diagnostics/json', async (req, res) => {
  try {
    const report = await runAllChecks();
    res.json(report);
  } catch (err) {
    res.status(500).json({ overall: 'error', error: err.message });
  }
});

// ==================== Cron Jobs Monitor (প্রোডাকশন-রেডি Scheduler ম্যানেজমেন্ট) ====================
router.get('/cron-jobs', async (req, res) => {
  try {
    const jobs = await scheduler.listJobs();
    const recentLogs = await scheduler.getRecentLogs(20);
    res.render('admin/cron-jobs', { jobs, recentLogs, active: 'cron-jobs' });
  } catch (err) {
    console.error('Cron jobs list error:', err.message);
    res.render('admin/cron-jobs', { jobs: [], recentLogs: [], active: 'cron-jobs' });
  }
});

// একটা নির্দিষ্ট Job-এর সম্পূর্ণ Execution History
router.get('/cron-jobs/:key/logs', async (req, res) => {
  try {
    const key = req.params.key;
    const logs = await scheduler.getJobLogs(key, 100);
    const jobs = await scheduler.listJobs();
    const job = jobs.find(j => j.key === key) || { key, label: key, description: '' };
    res.render('admin/cron-job-logs', { job, logs, active: 'cron-jobs' });
  } catch (err) {
    console.error('Cron job logs error:', err.message);
    req.flash('error', 'জব হিস্ট্রি লোড করা যায়নি।');
    res.redirect('/admin/cron-jobs');
  }
});

// Run Now — ম্যানুয়ালি একটা Job অবিলম্বে ট্রিগার করা (schedule অপেক্ষা না করে)
router.post('/cron-jobs/:key/run', adminActionLimiter, async (req, res) => {
  try {
    const key = req.params.key;
    if (!scheduler.JOB_DEFINITIONS[key]) {
      req.flash('error', `অজানা cron job: ${key}`);
      return res.redirect('/admin/cron-jobs');
    }
    const result = await scheduler.runJob(key, { triggeredBy: `manual:${req.session.user.username}` });
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'CRON_JOB_RUN_NOW',
      `Cron job "${key}" ম্যানুয়ালি রান করা হয়েছে — status: ${result.status}, duration: ${result.durationMs}ms`,
      req.ip
    );
    req.flash(result.status === 'success' ? 'success' : 'error',
      `"${key}" রান হয়েছে (${result.durationMs}ms) — ${result.message}`);
    res.redirect('/admin/cron-jobs');
  } catch (err) {
    console.error('Cron run-now error:', err.message);
    req.flash('error', 'Job রান করা যায়নি: ' + err.message);
    res.redirect('/admin/cron-jobs');
  }
});

// Enable/Disable — সার্ভার রিস্টার্ট ছাড়াই কার্যকর হয় (প্রতিবার রানের আগে DB থেকে ফ্রেশ চেক হয়)
router.post('/cron-jobs/:key/toggle', adminActionLimiter, async (req, res) => {
  try {
    const key = req.params.key;
    if (!scheduler.JOB_DEFINITIONS[key]) {
      req.flash('error', `অজানা cron job: ${key}`);
      return res.redirect('/admin/cron-jobs');
    }
    const enabled = req.body.enabled === 'true' || req.body.enabled === '1';
    await scheduler.setEnabled(key, enabled);
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'CRON_JOB_TOGGLE',
      `Cron job "${key}" ${enabled ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে`, req.ip
    );
    req.flash('success', `"${key}" ${enabled ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে।`);
    res.redirect('/admin/cron-jobs');
  } catch (err) {
    console.error('Cron toggle error:', err.message);
    req.flash('error', 'Job টগল করা যায়নি: ' + err.message);
    res.redirect('/admin/cron-jobs');
  }
});

// Cron Jobs JSON API (পোলিং — লাইভ লাস্ট-রান স্ট্যাটাসের জন্য)
router.get('/cron-jobs/status/json', async (req, res) => {
  try {
    const jobs = await scheduler.listJobs();
    res.json({ success: true, jobs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ==================== LOGIN HISTORY (সব ইউজারের, সার্চ/ফিল্টার সহ) ====================

module.exports = router;
