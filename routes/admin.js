const express = require('express');
const secretBox = require('../utils/secretBox');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const { redirectBack } = require('../utils/redirectBack');
const { regenerateSession, saveSession } = require('../utils/sessionRegenerate');
const rbac = require('../services/rbac');
// publicMessage(): ইচ্ছাকৃত (PublicError) ভ্যালিডেশন বার্তা যেমন আছে তেমনই দেখায়, কিন্তু
// অপ্রত্যাশিত pg/ইন্টারনাল এররের কাঁচা err.message ব্রাউজারে যেতে দেয় না। বিস্তারিত
// কারণটা আগের মতোই console.error()-এ সার্ভার লগে থাকে। utils/safeError.js দেখুন।
const { publicMessage } = require('../utils/safeError');

// এই এন্ডপয়েন্টে আগে কোনো auth middleware ছিল না (নিচের router.use(isAdmin)-এর
// আগে ডিফাইন করা ছিল বলে সেটার আওতায় পড়ছিল না) — ফলে যে কেউ লগইন ছাড়াই রেভিনিউ,
// ইউজার গ্রোথ, টপ ডিপোজিটরদের নাম+পরিমাণ ও KYC সামারি দেখতে পারতো। route-level isAdmin দিয়ে ঠিক করা হলো।
router.get('/api/analytics', isAdmin, rbac.requirePermission('dashboard_view'), async (req, res) => {
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
        try { const { getHealthStatus } = require('../services/queue'); return await getHealthStatus(); } catch(e) { return {}; }
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
    // err.message-এ ব্যর্থ SQL/কলাম/টেবিলের নাম চলে আসত — সেটা ব্রাউজারে পাঠানো হয় না।
    console.error('admin analytics API error:', err.message);
    res.status(500).json({ error: req.t('admin_data_load_failed') });
  }
});

const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { grantFreeBet } = require('../services/freebet');
const { loadSettings, invalidateSettingsCache } = require('../services/settings');
const { creditApprovedDeposit } = require('./payment');
const { emitToUser, broadcastToAllUsers } = require('../services/notify');
const bcrypt = require('bcryptjs');
// routes/auth.js-এর মতোই — অস্তিত্বহীন অ্যাডমিন username/email-এ bcrypt.compare() না চালালে
// টাইমিং দিয়ে বৈধ অ্যাডমিন অ্যাকাউন্ট এনিউমারেট করা যায়, তাই ডামি হ্যাশের বিপরীতে তুলনা।
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('dummy-password-for-constant-time-compare', 10);
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
const { getUserDeviceOverview, parseUserAgent } = require('../services/deviceTracking');
const cache = require('../services/cache');
const cacheKeys = require('../services/cacheKeys');
const { deleteOrDeactivateUser } = require('../services/userDeletion');

// একাধিক সারি একসাথে বদলাতে হলে ছোট ট্রানজেকশন র‍্যাপার — ব্যালেন্স আর coin_transactions
// লেজার যেন কখনো আলাদা হয়ে না যায়। কলব্যাক থ্রো করলে সবকিছু rollback হয়।
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
const RedisRateLimitStore = require('../services/redisRateLimitStore');

const { requireIntParam, requireAmount, parseAmount, sanitizeText, isSafeUrl, clampPage } = require('../middleware/validate');
const { listIpRules, setIpRule, removeIpRule } = require('../services/ipRules');
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
  message: (req) => tr(req, 'admin_rate_limited_action'),
  store: new RedisRateLimitStore('rl:adminaction:')
});

// টাকা/কয়েন সরাসরি নড়াচড়া করে এমন রুটে (approve/reject/coins add-remove) আরও কড়া সীমা —
// কম্প্রোমাইজড সেশন বা স্ক্রিপ্টেড অপব্যবহার হলেও ক্ষতির পরিমাণ সীমিত রাখতে।
const adminFinancialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => tr(req, 'admin_rate_limited_financial'),
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
  message: (req) => tr(req, 'common_rate_limited_15m'),
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

    const admin = result.rows[0];
    const isMatch = await bcrypt.compare(password, admin ? admin.password : DUMMY_BCRYPT_HASH);

    if (!admin || !isMatch) {
      return res.render('admin/login', { error: req.t('admin_login_invalid_credentials') });
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

    // ==================== 2FA বাধ্যতামূলক — এখনো চালু না করা থাকলে সরাসরি লগইন না করিয়ে ====================
    // এনরোলমেন্ট সম্পন্ন করানো হয় (পাসওয়ার্ড লিক হলেও 2FA ছাড়া অ্যাকাউন্টে ঢোকা যাবে না)।
    // req.session.user এখনো সেট করা হচ্ছে না — pendingEnrollment শুধু সেই একটামাত্র এনরোলমেন্ট
    // ফ্লো-তেই কাজ করে, isAdmin (router.use(isAdmin), নিচে) এটা চেনে না, তাই এনরোলমেন্ট সম্পূর্ণ
    // না হলে অন্য কোনো admin রুটে ঢোকা সম্ভব না।
    req.session.pendingEnrollment = { id: admin.id, username: admin.username, role: admin.role };
    return res.redirect('/admin/2fa/mandatory-setup');
  } catch (err) {
    console.error(err);
    res.render('admin/login', { error: req.t('admin_server_error') });
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
      ok = verifyTotpToken(secretBox.decrypt(admin.totp_secret), token);
    }

    if (!ok) {
      req.session.twoFAAttempts = (req.session.twoFAAttempts || 0) + 1;
      if (req.session.twoFAAttempts >= 5) {
        req.session.pending2FA = null;
        return res.render('admin/login', { error: req.t('admin_2fa_too_many_wrong_codes') });
      }
      return res.render('admin/2fa-verify', { error: req.t('admin_2fa_code_invalid'), username: pending.username });
    }

    // session fixation প্রতিরোধ: 2FA সম্পন্ন হওয়ার মুহূর্তে (অথেন্টিকেশন লেভেল বদলানোর সময়)
    // সেশন আইডি রোটেট করা হয়
    await regenerateSession(req);
    req.session.user = { id: admin.id, username: admin.username, role: admin.role };
    req.session.pending2FA = null;
    req.session.twoFAAttempts = 0;
    applyAdminSessionPolicy(req);
    logAdminAction(admin.id, admin.username, 'LOGIN_2FA', '2FA দিয়ে লগইন সম্পন্ন', req.ip);
    // redirect-এর আগে সেশন স্টোরে লেখা নিশ্চিত করা হচ্ছে — নইলে ব্রাউজারের পরের
    // রিকোয়েস্ট (GET /admin) নতুন sid নিয়ে পৌঁছে যেতে পারে সেশন সারি কমিট হওয়ার
    // আগেই, আর অ্যাডমিন সঙ্গে সঙ্গে আবার লগইন পেজে ফেরত যায়।
    await saveSession(req);
    res.redirect('/admin');
  } catch (err) {
    console.error('2FA verify error:', err.message);
    res.render('admin/2fa-verify', { error: req.t('admin_server_error'), username: pending.username });
  }
});

// ==================== 2FA বাধ্যতামূলক এনরোলমেন্ট (পাসওয়ার্ড সঠিক, কিন্তু 2FA এখনো চালু করা হয়নি) ====================
// req.session.user এখনো সেট হয়নি এই পুরো ফ্লো জুড়ে — শুধু TOTP verify সফল হওয়ার পরই লগইন সম্পন্ন হয়।
// তার আগে অন্য কোনো admin রুটে যাওয়ার চেষ্টা করলে isAdmin (নিচে) req.session.user না পেয়ে
// /admin/login-এ ফেরত পাঠাবে — তাই এনরোলমেন্ট এড়িয়ে যাওয়ার কোনো উপায় নেই।
router.get('/2fa/mandatory-setup', async (req, res) => {
  const pending = req.session.pendingEnrollment;
  if (!pending) return res.redirect('/admin/login');
  try {
    const fresh = await pool.query('SELECT totp_enabled FROM users WHERE id = $1', [pending.id]);
    if (fresh.rows[0]?.totp_enabled) {
      // অন্য কোনো ট্যাব/সেশনে ইতিমধ্যে এনাবল হয়ে থাকলে — আবার এনরোল করানোর দরকার নেই, লগইন-2FA ফ্লোতে পাঠানো হচ্ছে
      req.session.pending2FA = pending;
      req.session.pendingEnrollment = null;
      req.session.twoFAAttempts = 0;
      return res.redirect('/admin/login/2fa');
    }
    const setup = await generateTotpSetup(pending.username);
    req.session.pendingEnrollmentSecret = setup.base32;
    res.render('admin/2fa-setup', {
      alreadyEnabled: false,
      qrDataUrl: setup.qrDataUrl,
      base32: setup.base32,
      error: null,
      formAction: '/admin/2fa/mandatory-setup/verify',
      mandatory: true
    });
  } catch (err) {
    console.error('mandatory 2fa setup error:', err.message);
    res.render('admin/2fa-setup', {
      alreadyEnabled: false, qrDataUrl: null, base32: null,
      error: req.t('admin_2fa_qr_failed'), formAction: '/admin/2fa/mandatory-setup/verify', mandatory: true
    });
  }
});

router.post('/2fa/mandatory-setup/verify', strict2FALimiter, async (req, res) => {
  const pending = req.session.pendingEnrollment;
  if (!pending) return res.redirect('/admin/login');

  try {
    const pendingSecret = req.session.pendingEnrollmentSecret;
    const { token } = req.body;

    if (!pendingSecret) return res.redirect('/admin/2fa/mandatory-setup');
    if (!verifyTotpToken(pendingSecret, token)) {
      const dataUrlAgain = await qrFromSecret(pendingSecret, pending.username);
      return res.render('admin/2fa-setup', {
        alreadyEnabled: false, qrDataUrl: dataUrlAgain, base32: pendingSecret,
        error: req.t('admin_2fa_code_invalid'), formAction: '/admin/2fa/mandatory-setup/verify', mandatory: true
      });
    }

    const backupCodes = generateBackupCodes(8);
    const backupCodesJson = await hashBackupCodes(backupCodes);
    await pool.query(
      'UPDATE users SET totp_secret = $1, totp_enabled = true, totp_backup_codes = $2, backup_codes_viewed = false WHERE id = $3',
      [secretBox.encrypt(pendingSecret), backupCodesJson, pending.id]
    );

    // এনরোলমেন্ট সম্পন্ন — এখন প্রকৃত লগইন সেশন স্থাপন করা হচ্ছে (এতক্ষণ ছিল না)।
    // session fixation প্রতিরোধে সেশন আইডি রোটেট করা হয় এই মুহূর্তেই।
    await regenerateSession(req);
    req.session.user = { id: pending.id, username: pending.username, role: pending.role };
    req.session.pendingEnrollment = null;
    req.session.pendingEnrollmentSecret = null;
    applyAdminSessionPolicy(req);
    await logAdminAction(pending.id, pending.username, '2FA_ENABLED', 'বাধ্যতামূলক 2FA এনরোলমেন্ট সম্পন্ন (লগইনের সময়)', req.ip);
    logAdminAction(pending.id, pending.username, 'LOGIN', '2FA এনরোলমেন্টসহ লগইন সম্পন্ন', req.ip);

    await saveSession(req);
    res.render('admin/2fa-backup-codes', { codes: backupCodes });
  } catch (err) {
    console.error('mandatory 2fa setup verify error:', err.message);
    res.render('admin/2fa-setup', {
      alreadyEnabled: false, qrDataUrl: null, base32: null,
      error: req.t('admin_server_error'), formAction: '/admin/2fa/mandatory-setup/verify', mandatory: true
    });
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

// ==================== অ্যাডমিন নেভিগেশন (res.locals.adminNav) ====================
// নেভিগেশনের কাঠামো utils/adminNav.js-এ ডেটা হিসেবে থাকে (আগে ~৩১৫ লাইন
// হার্ডকোড করা HTML ছিল admin-layout.ejs-এর ভেতরে)। এখানে সেটা অ্যাডমিনের
// permission অনুযায়ী ফিল্টার করে টেমপ্লেটে পাঠানো হয়।
//
// এটা নিছক UI পরিচ্ছন্নতা — যে লিংক দেখানো হচ্ছে না সেটার রুটে গেলেও
// requirePermission() মিডলওয়্যারই আসল সিদ্ধান্ত নেয়। তাই এখানে ব্যর্থ হলে
// fail-safe: পূর্ণ নেভ দেখানো হয়, কারণ লিংক দেখানো নিজে কোনো অনুমতি দেয় না।
router.use(require('../middleware/adminNavLocals').adminNavLocals);

// ==================== নোটিফিকেশন ব্যাজ কাউন্ট (বটম-নেভ) ====================
router.get('/api/notification-counts', async (req, res) => {
  try {
    // kyc যোগ করা হলো: বটম নেভে KYC আর সরাসরি লিংক নয় (Phase 7-এ "More" দিয়ে
    // বদলানো হয়েছে), তাই পেন্ডিং KYC সংখ্যা "More" ব্যাজে দেখাতে হয় — নাহলে
    // মোবাইলে কিউটা সম্পূর্ণ চোখের আড়ালে চলে যেত।
    const [deposits, withdrawals, chats, kyc] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM payment_requests WHERE type='deposit' AND status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM payment_requests WHERE type='withdraw' AND status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM chat_messages WHERE is_admin=false AND is_read=false`),
      pool.query(`SELECT COUNT(*)::int AS c FROM kyc_requests WHERE status='pending'`)
    ]);
    res.json({
      success: true,
      deposits: deposits.rows[0].c,
      withdrawals: withdrawals.rows[0].c,
      chats: chats.rows[0].c,
      kyc: kyc.rows[0].c
    });
  } catch (err) {
    console.error('notification-counts error:', err.message);
    res.json({ success: false, deposits: 0, withdrawals: 0, chats: 0, kyc: 0 });
  }
});

// ==================== সাইডবার ব্যাজ কাউন্ট (Payments/KYC) — views/admin/partials/sidebar.ejs প্রতি ২০ সেকেন্ডে পোল করে ====================
// উপরের /api/notification-counts-এর মতোই প্যাটার্ন (deposits/withdrawals), শুধু chats-এর বদলে kyc যোগ করা।
router.get('/pending-counts', async (req, res) => {
  try {
    const [deposits, withdrawals, kyc] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM payment_requests WHERE type='deposit' AND status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM payment_requests WHERE type='withdraw' AND status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS c FROM kyc_requests WHERE status='pending'`)
    ]);
    res.json({
      success: true,
      deposits: deposits.rows[0].c,
      withdrawals: withdrawals.rows[0].c,
      kyc: kyc.rows[0].c
    });
  } catch (err) {
    console.error('pending-counts error:', err.message);
    res.json({ success: false, deposits: 0, withdrawals: 0, kyc: 0 });
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
    res.render('admin/2fa-setup', { alreadyEnabled: false, qrDataUrl: null, base32: null, error: req.t('admin_2fa_qr_failed') });
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
        error: req.t('admin_2fa_code_invalid')
      });
    }

    const backupCodes = generateBackupCodes(8);
    const backupCodesJson = await hashBackupCodes(backupCodes);

    await pool.query(
      'UPDATE users SET totp_secret = $1, totp_enabled = true, totp_backup_codes = $2, backup_codes_viewed = false WHERE id = $3',
      [secretBox.encrypt(pendingSecret), backupCodesJson, req.session.user.id]
    );
    req.session.pending2FASetup = null;
    await logAdminAction(req.session.user.id, req.session.user.username, '2FA_ENABLED', '2FA চালু করা হয়েছে', req.ip);

    res.render('admin/2fa-backup-codes', { codes: backupCodes });
  } catch (err) {
    console.error('2fa/setup/verify error:', err.message);
    res.render('admin/2fa-setup', { alreadyEnabled: false, qrDataUrl: null, base32: null, error: req.t('admin_server_error') });
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

// 2FA বন্ধ করার রুটেও একই কড়া রেট-লিমিট। আগে এটা বাদ ছিল, অথচ এখানেও
// পাসওয়ার্ড + TOTP/ব্যাকআপ কোড যাচাই হয় — অর্থাৎ ব্রুট-ফোর্স করার জন্য
// এটাই ছিল সবচেয়ে সহজ দরজা, আর সফল হলে দ্বিতীয় ফ্যাক্টর একেবারে উঠে যেত।
router.post('/2fa/disable', strict2FALimiter, async (req, res) => {
  try {
    const { password, token } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const admin = result.rows[0];

    const passOk = admin && await bcrypt.compare(password || '', admin.password);
    // TOTP কোড অথবা ব্যাকআপ কোড — যেকোনো একটা দিয়ে যাচাই করা যাবে
    let codeOk = admin && verifyTotpToken(secretBox.decrypt(admin.totp_secret), token);
    if (!codeOk && admin && admin.totp_backup_codes) {
      const backupCheck = await verifyAndConsumeBackupCode(admin.totp_backup_codes, token);
      if (backupCheck.valid) codeOk = true;
    }

    if (!passOk || !codeOk) {
      return res.render('admin/2fa-setup', {
        alreadyEnabled: true, qrDataUrl: null, base32: null,
        error: req.t('admin_2fa_password_or_code_invalid')
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
router.get('/kyc', rbac.requirePermission('kyc_view'), async (req, res) => {
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
    res.render('admin/kyc', { loadError: true,
      kycList: [],
      stats: { total: 0, pending: 0, approved: 0, rejected: 0 },
      filters: { status: '', q: '' }
    });
  }
});

// ==================== KYC ডকুমেন্ট — প্রমাণীকৃত প্রক্সি ====================
// KYC ডকুমেন্ট Cloudinary-র পাবলিক URL-এ থাকে। আগে অ্যাডমিন প্যানেল সেই URL
// সরাসরি HTML-এ বসাত — অর্থাৎ জাতীয় পরিচয়পত্র/পাসপোর্টের ঠিকানা ব্রাউজার
// ইতিহাস, রেফারার হেডার, এক্সটেনশন ও স্ক্রিনশটে ছড়িয়ে পড়ত, আর একবার URL
// জানা গেলে যে কেউ প্রমাণীকরণ ছাড়াই ডকুমেন্টটা দেখতে পারত।
//
// এই রুট ডকুমেন্টটা সার্ভার থেকে স্ট্রিম করে: অনুমতি যাচাই হয়, অ্যাক্সেস
// অডিট লগে যায়, আর ব্রাউজারে আসল URL কখনো পৌঁছায় না।
//
// ⚠️ সীমাবদ্ধতা, সৎভাবে বলা: অ্যাসেটটা এখনো Cloudinary-তে পাবলিক। আগে থেকে
// URL জানা কেউ সরাসরি সেটা খুলতে পারবে। পূর্ণ সমাধান হলো Cloudinary-র
// authenticated delivery type ব্যবহার করা ও signed URL দিয়ে আপলোড করা —
// সেটা আলাদা কাজ, docs/KYC_STORAGE.md দেখুন।
router.get('/kyc/:id/document', rbac.requirePermission('kyc_view'), requireIntParam('id'), async (req, res) => {
  try {
    const r = await pool.query('SELECT document_url, user_id FROM kyc_requests WHERE id = $1', [req.params.id]);
    const row = r.rows[0];
    if (!row || !row.document_url) return res.status(404).send(req.t('admin_kyc_document_not_found'));

    // সংরক্ষিত URL আমাদের নিজের Cloudinary অ্যাকাউন্টেরই কিনা — DB-তে বসে থাকা
    // পুরনো/কারচুপি করা মান দিয়ে যেন সার্ভারকে যেকোনো ঠিকানায় রিকোয়েস্ট
    // করানো না যায় (SSRF)।
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    let target;
    try {
      target = new URL(row.document_url);
    } catch (e) {
      return res.status(400).send(req.t('admin_kyc_document_invalid_url'));
    }
    if (target.protocol !== 'https:' || target.hostname !== 'res.cloudinary.com'
        || !cloudName || !target.pathname.startsWith(`/${cloudName}/`)) {
      return res.status(400).send(req.t('admin_kyc_document_invalid_url'));
    }

    await logAdminAction(
      req.session.user.id, req.session.user.username, 'KYC_DOCUMENT_VIEWED',
      `KYC #${req.params.id} (ইউজার #${row.user_id}) এর ডকুমেন্ট দেখা হয়েছে`, req.ip
    );

    const upstream = await fetch(target.href);
    if (!upstream.ok) return res.status(502).send(req.t('admin_kyc_document_fetch_failed'));

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!/^image\/(jpeg|png|webp|gif)$/.test(contentType)) {
      return res.status(415).send(req.t('admin_kyc_document_bad_format'));
    }
    res.set('Content-Type', contentType);
    // ব্যক্তিগত ডকুমেন্ট — কোথাও ক্যাশ হবে না
    res.set('Cache-Control', 'no-store, private');
    res.set('Referrer-Policy', 'no-referrer');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.error('KYC document proxy error:', err.message);
    return res.status(500).send(req.t('common_server_error_short'));
  }
});

router.post('/kyc/:id/approve', rbac.requirePermission('kyc_approve'), async (req, res) => {
  try {
    const { id } = req.params;
    // দুটো পরিবর্তন, দুটোই আগে অনুপস্থিত ছিল:
    //
    // ১. **স্টেট গার্ড** — আগে যেকোনো অবস্থা থেকে approved করা যেত, তাই
    //    আগে reject করা KYC পরে approve, বা উল্টোটা করা যেত। বাল্ক অপারেশনে
    //    শুধু 'pending' প্রসেস হতো, একক রুটে সেই নিয়ম ছিল না — দুই পথে দুই
    //    নিয়ম। এখন দুটোতেই একই: শুধু pending → approved।
    //
    // ২. **atomicity** — kyc_requests ও users দুটো আলাদা কোয়েরিতে আপডেট হতো।
    //    প্রথমটা সফল হয়ে দ্বিতীয়টা ব্যর্থ হলে রিকোয়েস্ট approved দেখাত অথচ
    //    ইউজারের kyc_status আগের অবস্থাতেই থেকে যেত।
    const client = await pool.connect();
    let userId = null;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        "UPDATE kyc_requests SET status = 'approved', updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING user_id",
        [id]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: req.t('admin_kyc_not_pending') });
      }
      userId = r.rows[0].user_id;
      await client.query("UPDATE users SET kyc_status = 'approved' WHERE id = $1", [userId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await logAdminAction(req.session.user.id, req.session.user.username, 'KYC_APPROVE', `KYC #${id} অনুমোদন করা হয়েছে`, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('KYC approve error:', err.message);
    res.status(500).json({ success: false, message: req.t('admin_server_error_short') });
  }
});

router.post('/kyc/:id/reject', rbac.requirePermission('kyc_reject'), async (req, res) => {
  try {
    const { id } = req.params;
    const reason = (req.body && req.body.reason) || '';
    // approve-এর মতোই: শুধু pending → rejected, এবং দুই টেবিল একই ট্রানজেকশনে।
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        "UPDATE kyc_requests SET status = 'rejected', reject_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING user_id",
        [id, reason || null]
      );
      if (r.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: req.t('admin_kyc_not_pending') });
      }
      await client.query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [r.rows[0].user_id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await logAdminAction(req.session.user.id, req.session.user.username, 'KYC_REJECT', `KYC #${id} বাতিল করা হয়েছে। কারণ: ${reason}`, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('KYC reject error:', err.message);
    res.status(500).json({ success: false, message: req.t('admin_server_error_short') });
  }
});

// ==================== KYC বাল্ক অনুমোদন/বাতিল ====================
// users/bulk-ban-এর মতোই প্যাটার্ন: প্রতিটা আইডি আলাদাভাবে try/catch-এ প্রসেস হয়,
// তাই একটা আইডি ব্যর্থ হলে বাকিগুলো আটকায় না (partial-failure safe)। শুধু 'pending'
// অবস্থায় থাকা রিকোয়েস্টই প্রসেস করা হয় — আগে থেকে approved/rejected কে আবার
// প্রসেস করার চেষ্টা "কিছুই বদলায়নি" হিসেবে গণ্য হয়, এরর হিসেবে না।
router.post('/kyc/bulk-approve', rbac.requirePermission('kyc_approve'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const cleanIds = [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))];
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: req.t('admin_kyc_none_selected') });
  }
  if (cleanIds.length > 100) {
    return res.status(400).json({ success: false, error: req.t('admin_kyc_bulk_limit') });
  }

  const results = [];
  for (const id of cleanIds) {
    try {
      const r = await pool.query(
        "UPDATE kyc_requests SET status = 'approved', updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING user_id",
        [id]
      );
      if (r.rows[0]) {
        await pool.query("UPDATE users SET kyc_status = 'approved' WHERE id = $1", [r.rows[0].user_id]);
        results.push({ id, success: true, userId: r.rows[0].user_id });
      } else {
        const existing = await pool.query('SELECT status FROM kyc_requests WHERE id = $1', [id]);
        if (!existing.rows[0]) results.push({ id, success: false, error: req.t('admin_application_not_found') });
        else results.push({ id, success: false, error: req.t('admin_already_in_status').replace('{value}', existing.rows[0].status), alreadyProcessed: true });
      }
    } catch (err) {
      // প্রতি-সারির ব্যর্থতা ক্লায়েন্টে JSON হিসেবে ফেরত যায়, তাই কাঁচা pg মেসেজ (টেবিল/কলাম/
      // কনস্ট্রেইন্টের নাম) এখানে বসানো যাবে না — গুনতি ও আইডি রিপোর্ট হয়, কারণ লগে থাকে।
      console.error(`bulk operation row ${id} failed:`, err && err.stack ? err.stack : err);
      results.push({ id, success: false, error: req.t('admin_process_failed_db') });
    }
  }

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  await logAdminAction(
    req.session.user.id, req.session.user.username, 'KYC_BULK_APPROVE',
    `বাল্ক KYC অনুমোদন: ${succeeded.length}টা সফল, ${failed.length}টা ব্যর্থ (আইডি: ${cleanIds.join(',')})`, req.ip
  );
  succeeded.forEach((r) => {
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'KYC_APPROVED', category: 'other', status: 'success', riskLevel: 'medium',
      details: { kycId: r.id, targetUserId: r.userId, via: 'bulk' }
    }).catch((e) => console.error('logAuditEvent (KYC_BULK_APPROVE) error:', e.message));
  });

  res.json({ success: true, total: cleanIds.length, succeeded: succeeded.length, failed: failed.length, results });
});

router.post('/kyc/bulk-reject', rbac.requirePermission('kyc_reject'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const cleanIds = [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))];
  const reason = sanitizeText(req.body.reason || '', { maxLen: 500 });
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: req.t('admin_kyc_none_selected') });
  }
  if (cleanIds.length > 100) {
    return res.status(400).json({ success: false, error: req.t('admin_kyc_bulk_limit') });
  }

  const results = [];
  for (const id of cleanIds) {
    try {
      const r = await pool.query(
        "UPDATE kyc_requests SET status = 'rejected', reject_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING user_id",
        [id, reason || null]
      );
      if (r.rows[0]) {
        await pool.query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [r.rows[0].user_id]);
        results.push({ id, success: true, userId: r.rows[0].user_id });
      } else {
        const existing = await pool.query('SELECT status FROM kyc_requests WHERE id = $1', [id]);
        if (!existing.rows[0]) results.push({ id, success: false, error: req.t('admin_application_not_found') });
        else results.push({ id, success: false, error: req.t('admin_already_in_status').replace('{value}', existing.rows[0].status), alreadyProcessed: true });
      }
    } catch (err) {
      // প্রতি-সারির ব্যর্থতা ক্লায়েন্টে JSON হিসেবে ফেরত যায়, তাই কাঁচা pg মেসেজ (টেবিল/কলাম/
      // কনস্ট্রেইন্টের নাম) এখানে বসানো যাবে না — গুনতি ও আইডি রিপোর্ট হয়, কারণ লগে থাকে।
      console.error(`bulk operation row ${id} failed:`, err && err.stack ? err.stack : err);
      results.push({ id, success: false, error: req.t('admin_process_failed_db') });
    }
  }

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  await logAdminAction(
    req.session.user.id, req.session.user.username, 'KYC_BULK_REJECT',
    `বাল্ক KYC বাতিল: ${succeeded.length}টা সফল, ${failed.length}টা ব্যর্থ (আইডি: ${cleanIds.join(',')})। কারণ: ${reason || '—'}`, req.ip
  );
  succeeded.forEach((r) => {
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'KYC_REJECTED', category: 'other', status: 'success', riskLevel: 'medium',
      details: { kycId: r.id, targetUserId: r.userId, reason: reason || null, via: 'bulk' }
    }).catch((e) => console.error('logAuditEvent (KYC_BULK_REJECT) error:', e.message));
  });

  res.json({ success: true, total: cleanIds.length, succeeded: succeeded.length, failed: failed.length, results });
});

// ==================== সেটিংস ====================
const SETTING_KEYS = [
  'site_name', 'support_email', 'maintenance_mode', 'max_login_attempts',
  'min_bet', 'max_bet', 'turnover_multiplier', 'max_daily_bets',
  'deposit_commission_percent', 'withdraw_commission_percent', 'min_deposit', 'min_withdraw',
  'referral_commission_tier1_percent', 'referral_commission_tier2_percent', 'referral_commission_tier3_percent',
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

router.get('/system-settings', rbac.requirePermission('settings_view'), async (req, res) => {
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
    res.render('admin/system-settings', { loadError: true, settings: {}, redisConnected: false, saved: false });
  }
});

router.get('/settings', rbac.requirePermission('settings_view'), async (req, res) => {
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
    res.render('admin/settings', { loadError: true, settings: {}, admins: [], saved: false, saveError: false });
  }
});

router.post('/settings/update', rbac.requirePermission('settings_edit'), async (req, res) => {
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
      // রেফারেল কমিশন রেট — ০-১০০-এর মধ্যে সংখ্যা না হলে সেভ না করে আগের মান রেখে দেওয়া হয়
      // (ভুল মান যেমন negative বা খালি স্ট্রিং সেভ হলে distributeCommission()-এ ভুল কমিশন যেতে পারত)
      if (['referral_commission_tier1_percent', 'referral_commission_tier2_percent', 'referral_commission_tier3_percent'].includes(key)) {
        const n = parseFloat(value);
        if (!Number.isFinite(n) || n < 0 || n > 100) continue;
        value = String(n);
      }

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

router.post('/settings/admins/promote', rbac.requireSuperAdmin(), async (req, res) => {
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

// শুধু roles_manage পারমিশন-ওয়ালা (super_admin নয়, এমন) অ্যাডমিনও আগে এই রুট দিয়ে
// যেকোনো অ্যাডমিনকে — এমনকি আসল super_admin-কেও — ডিমোট করে দিতে পারত। sibling
// /promote রুট আগে থেকেই requireSuperAdmin() ব্যবহার করে; এখানেও একই বাউন্ডারি প্রয়োজন।
router.post('/settings/admins/:id/demote', rbac.requireSuperAdmin(), async (req, res) => {
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
router.get('/notifications', rbac.requirePermission('settings_edit'), async (req, res) => {
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
    res.render('admin/notifications', { loadError: true, history: [], totalUsers: 0 });
  }
});

router.post('/notifications/broadcast', rbac.requirePermission('settings_edit'), adminFinancialLimiter, async (req, res) => {
  try {
    const title = sanitizeText(req.body.title || '', { maxLen: 150 });
    const message = sanitizeText(req.body.message || '', { maxLen: 500 });
    const allowedTypes = ['announcement', 'system', 'info', 'success', 'error'];
    const type = allowedTypes.includes(req.body.type) ? req.body.type : 'announcement';

    if (!title || !message) {
      req.flash('error', req.t('admin_title_and_message_required'));
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

    req.flash('success', req.t('admin_broadcast_sent').replace('{value}', recipientCount));
    res.redirect('/admin/notifications');
  } catch (err) {
    console.error('broadcast error:', err.message);
    req.flash('error', req.t('admin_broadcast_failed'));
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

router.get('/', rbac.requirePermission('dashboard_view'), async (req, res) => {
  try {
    // views/admin/dashboard.ejs date-filter ফর্ম ও Export CSV লিংক dateRange.from/dateRange.to আশা করে,
    // কিন্তু এই ভ্যারিয়েবলটা কখনো তৈরি/পাস করা হতো না — ফলে প্রতিবার লগইনের পর প্রথম পেজ
    // (dashboard) 500 এরর দিয়ে ক্র্যাশ করত ("dateRange is not defined")। ডিফল্ট গত ৩০ দিন,
    // query param দিয়ে ওভাররাইড করা যায়।
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateRange = {
      from: /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : thirtyDaysAgo,
      to: /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today
    };

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
    // pending KYC — ভিউ (views/admin/dashboard.ejs) `stats.pending_kyc` ও
    // `stats.pending_total` পড়ত, কিন্তু রুট সেগুলো কখনো পাঠাত না। ফলে
    // "Review Pending KYC (0)" সবসময় 0 দেখাত এমনকি সারি pending থাকলেও —
    // অর্থাৎ অ্যাডমিন কিউটা আছে বলেই বুঝতে পারতেন না।
    const pendingKyc = await pool.query(
      `SELECT COUNT(*) AS cnt FROM kyc_requests WHERE status='pending'`
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

    // views/admin/dashboard.ejs আরও ৪টা ভ্যারিয়েবল আশা করে যেগুলো আগে কখনো res.render()-এ
    // পাস করা হতো না (betStatistics, apiUsageStats, serverHealth, queueHealth) — ফলে ড্যাশবোর্ড
    // (লগইনের পরের প্রথম পেজ) সবসময় 500 ক্র্যাশ করত। হালকা, বাস্তব হিসাব দিয়ে পূরণ করা হচ্ছে।
    const betStatsRes = await pool.query(`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='won') AS won,
             COUNT(*) FILTER (WHERE status='lost') AS lost, COUNT(*) FILTER (WHERE status='pending') AS pending,
             COALESCE(SUM(stake),0) AS staked
      FROM bets WHERE created_at BETWEEN $1 AND $2
    `, [dateRange.from, dateRange.to + ' 23:59:59']).catch(() => null);
    const betPayoutRes = await pool.query(`
      SELECT COALESCE(SUM(stake * odd),0) AS payout FROM bets WHERE status='won' AND created_at BETWEEN $1 AND $2
    `, [dateRange.from, dateRange.to + ' 23:59:59']).catch(() => null);
    const totalBetsN = betStatsRes ? parseInt(betStatsRes.rows[0].total) : 0;
    const wonN = betStatsRes ? parseInt(betStatsRes.rows[0].won) : 0;
    const totalStakeN = betStatsRes ? Number(betStatsRes.rows[0].staked) : 0;
    const totalPayoutN = betPayoutRes ? Number(betPayoutRes.rows[0].payout) : 0;
    const betStatistics = {
      totalBets: totalBetsN,
      wonCount: wonN,
      lostCount: betStatsRes ? parseInt(betStatsRes.rows[0].lost) : 0,
      pendingCount: betStatsRes ? parseInt(betStatsRes.rows[0].pending) : 0,
      winRatePercent: totalBetsN > 0 ? Math.round((wonN / totalBetsN) * 100) : 0,
      totalStake: totalStakeN,
      totalPayout: totalPayoutN,
      houseProfit: totalStakeN - totalPayoutN
    };

    const apiLogStatsRes = await pool.query(`
      SELECT COUNT(*) AS total, COALESCE(AVG(response_time_ms),0) AS avg_ms,
             COUNT(*) FILTER (WHERE status_code >= 400) AS errors
      FROM api_usage_logs WHERE created_at BETWEEN $1 AND $2
    `, [dateRange.from, dateRange.to + ' 23:59:59']).catch(() => null);
    const totalReqN = apiLogStatsRes ? parseInt(apiLogStatsRes.rows[0].total) : 0;
    const apiUsageStats = {
      totalRequests: totalReqN,
      avgResponseMs: apiLogStatsRes ? Math.round(Number(apiLogStatsRes.rows[0].avg_ms)) : 0,
      errorRatePercent: totalReqN > 0 ? Math.round((parseInt(apiLogStatsRes.rows[0].errors) / totalReqN) * 100) : 0,
      topEndpoints: []
    };

    const os = require('os');
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const usedMemPercent = totalMemMb > 0 ? Math.round(((totalMemMb - freeMemMb) / totalMemMb) * 100) : 0;
    const serverHealth = {
      level: usedMemPercent > 90 ? 'critical' : (usedMemPercent > 75 ? 'warning' : 'healthy'),
      uptimeSec: Math.round(process.uptime()),
      cpu: { loadAvg1m: os.loadavg()[0].toFixed(2), count: os.cpus().length },
      system: { usedMemPercent, freeMemMb },
      disk: null,
      issues: usedMemPercent > 90 ? ['মেমরি ব্যবহার ৯০%-এর বেশি'] : []
    };

    const queueHealth = {
      level: !bullHealth.redisConnected ? 'warning' : (queueStatus.failed > 0 ? 'warning' : 'healthy'),
      issues: !bullHealth.redisConnected ? ['Redis সংযুক্ত নেই — BullMQ queue বন্ধ, সব জব inline চলছে'] : (queueStatus.failed > 0 ? [`${queueStatus.failed}টা জব ব্যর্থ হয়েছে`] : [])
    };

    // ==== ব্যাকআপ স্ট্যাটাস ====
    // ব্যাকআপ ব্যর্থ হলে এখন Telegram অ্যালার্ট যায়, কিন্তু Telegram কনফিগার করা না থাকলে
    // বা মেসেজ মিস হলে অ্যাডমিনের জানার একমাত্র উপায় ছিল /admin/backups খুলে দেখা।
    // ড্যাশবোর্ডেই শেষ সফল ব্যাকআপ কবে হয়েছে সেটা দেখানো হয় — ডেটা backup_history-তে
    // আগে থেকেই ছিল, শুধু কোথাও তুলে ধরা হতো না।
    let backupHealth = { level: 'healthy', lastSuccessAt: null, lastFailedAt: null, issues: [] };
    try {
      const b = await pool.query(`
        SELECT
          MAX(created_at) FILTER (WHERE status = 'completed') AS last_success,
          MAX(created_at) FILTER (WHERE status = 'failed')    AS last_failed
        FROM backup_history
      `);
      const lastSuccess = b.rows[0] && b.rows[0].last_success ? new Date(b.rows[0].last_success) : null;
      const lastFailed = b.rows[0] && b.rows[0].last_failed ? new Date(b.rows[0].last_failed) : null;
      const ageHours = lastSuccess ? (Date.now() - lastSuccess.getTime()) / 36e5 : null;
      const issues = [];
      // BACKUP_SCHEDULE_HOURS ডিফল্ট ২৪; ৪৮ ঘণ্টা পেরোলে নিশ্চিতভাবেই একটা সাইকেল মিস হয়েছে
      if (!lastSuccess) issues.push('কোনো সফল ব্যাকআপ রেকর্ড নেই');
      else if (ageHours > 48) issues.push(`শেষ সফল ব্যাকআপ ${Math.round(ageHours)} ঘণ্টা আগে`);
      if (lastFailed && (!lastSuccess || lastFailed > lastSuccess)) issues.push('সর্বশেষ ব্যাকআপ চেষ্টা ব্যর্থ হয়েছে');
      backupHealth = {
        level: issues.length === 0 ? 'healthy' : (!lastSuccess || (ageHours && ageHours > 48) ? 'critical' : 'warning'),
        lastSuccessAt: lastSuccess,
        lastFailedAt: lastFailed,
        issues
      };
    } catch (e) {
      // ব্যাকআপ স্ট্যাটাস তুলতে না পারলেও ড্যাশবোর্ড যেন ভেঙে না যায়
      backupHealth = { level: 'unknown', lastSuccessAt: null, lastFailedAt: null, issues: ['ব্যাকআপ স্ট্যাটাস পড়া যায়নি'] };
    }

    res.render('admin/dashboard', {
      dateRange,
      betStatistics,
      apiUsageStats,
      serverHealth,
      queueHealth,
      backupHealth,
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
        pending_support: parseInt(pendingSupport.rows[0].cnt),
        pending_kyc: parseInt(pendingKyc.rows[0].cnt),
        pending_total: parseInt(pendingDeposits.rows[0].cnt)
                     + parseInt(pendingWithdrawals.rows[0].cnt)
                     + parseInt(pendingKyc.rows[0].cnt),
        // ভিউ এই দুটো নামেই পড়ে; রুট এতদিন total_deposit_all / total_withdraw_all
        // নামে পাঠাত, তাই লাইফটাইম কার্ড দুটো সবসময় ৳0 দেখাত। দুটো নামই রাখা
        // হলো — পুরনো নাম অন্য কোথাও ব্যবহৃত হলে ভাঙবে না।
        total_deposits_all_time: Number(totalDepositAll.rows[0].total),
        total_withdrawals_all_time: Number(totalWithdrawAll.rows[0].total),
        fraud_alerts: (fraudAlerts && typeof fraudAlerts === "object")
          ? ((fraudAlerts.high || 0) + (fraudAlerts.medium || 0)) : 0
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
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    res.render('admin/dashboard', { loadError: true,
      dateRange: { from: thirtyDaysAgo, to: today },
      betStatistics: { totalBets: 0, wonCount: 0, lostCount: 0, pendingCount: 0, winRatePercent: 0, totalStake: 0, totalPayout: 0, houseProfit: 0 },
      apiUsageStats: { totalRequests: 0, avgResponseMs: 0, errorRatePercent: 0, topEndpoints: [] },
      serverHealth: { level: 'healthy', uptimeSec: 0, cpu: { loadAvg1m: '0.00', count: 1 }, system: { usedMemPercent: 0, freeMemMb: 0 }, disk: null, issues: [] },
      queueHealth: { level: 'healthy', issues: [] },
      backupHealth: { level: 'unknown', lastSuccessAt: null, lastFailedAt: null, issues: [] },
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
router.get('/api/dashboard-stats', rbac.requirePermission('dashboard_view'), async (req, res) => {
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
    res.status(500).json({ success: false, error: req.t('common_server_error_short') });
  }
});

// ==================== ডিপোজিট ম্যানেজমেন্ট ====================
// ==================== ডিপোজিট (ডুপ্লিকেট — ক্যানোনিকাল পেজে রিডাইরেক্ট) ====================
// এই পেজটা /payment/admin/payments-এর ডিপোজিট ট্যাবের সাথে হুবহু একই কাজ করত (পেন্ডিং তালিকা +
// approve/reject)। দুটো আলাদা জায়গায় একই কিউ থাকায় অ্যাডমিনরা কোনটা "আসল" তা নিয়ে বিভ্রান্ত হতো
// এবং একজন এক পেজে approve করলে অন্যজনের খোলা পেজে বাসি ডেটা থেকে যেত। এখন একটাই ক্যানোনিকাল
// অনুমোদন-কিউ: /payment/admin/payments (যেখানে বাল্ক অ্যাকশনও আছে)। পুরনো URL/বুকমার্ক যাতে না
// ভাঙে সেজন্য রিডাইরেক্ট রাখা হলো — RBAC গেট আগের মতোই বহাল।
router.get('/deposits', rbac.requirePermission('payments_view'), (req, res) => {
  res.redirect('/payment/admin/payments');
});

router.get('/deposits/legacy-disabled', rbac.requirePermission('payments_view'), async (req, res) => {
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
    res.render('admin/deposits', { loadError: true, pendingDeposits: [], recentDeposits: [], pendingCount: 0, pendingTotal: 0, filterFrom: '', filterTo: '' });
  }
});

router.post('/api/deposits/:id/approve', rbac.requirePermission('payments_approve'), adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'deposit' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: req.t('payment_request_not_found_or_processed') });
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
    res.status(500).json({ success: false, error: req.t('admin_server_error_retry') });
  } finally {
    client.release();
  }
});

router.post('/api/deposits/:id/reject', rbac.requirePermission('payments_reject'), adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const reason = sanitizeText(req.body.reason || '', { maxLen: 300 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'deposit' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: req.t('payment_request_not_found_or_processed') });
    }
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    const rejNotif = await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error') RETURNING *`,
      [request.user_id, req.t('admin_deposit_cancelled_title'), `আপনার ${request.amount} টাকার ডিপোজিট বাতিল হয়েছে।${reason ? ' কারণ: ' + reason : ''}`]
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
    res.status(500).json({ success: false, error: req.t('admin_server_error_retry') });
  } finally {
    client.release();
  }
});

// ==================== উইথড্র ম্যানেজমেন্ট ====================
// ==================== উইথড্র (ডুপ্লিকেট — ক্যানোনিকাল পেজে রিডাইরেক্ট) ====================
// উপরের /deposits-এর মতোই কারণ: /payment/admin/payments-এর উইথড্র ট্যাবই এখন একমাত্র কিউ।
router.get('/withdrawals', rbac.requirePermission('payments_view'), (req, res) => {
  res.redirect('/payment/admin/payments?tab=withdraw');
});

router.get('/withdrawals/legacy-disabled', rbac.requirePermission('payments_view'), async (req, res) => {
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
    res.render('admin/withdrawals', { loadError: true, pendingWithdrawals: [], recentWithdrawals: [], pendingCount: 0, pendingTotal: 0, filterFrom: '', filterTo: '' });
  }
});

router.post('/api/withdrawals/:id/approve', rbac.requirePermission('payments_approve'), adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const txn = req.body.txn ? sanitizeText(req.body.txn, { maxLen: 120 }) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'withdraw' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: req.t('payment_request_not_found_or_processed') });
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
    res.status(500).json({ success: false, error: req.t('admin_server_error_retry') });
  } finally {
    client.release();
  }
});

router.post('/api/withdrawals/:id/reject', rbac.requirePermission('payments_reject'), adminFinancialLimiter, requireIntParam('id'), async (req, res) => {
  const { id } = req.params;
  const reason = sanitizeText(req.body.reason || '', { maxLen: 300 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.type !== 'withdraw' || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: req.t('payment_request_not_found_or_processed') });
    }
    // উইথড্র রিকোয়েস্ট করার সময় কয়েন কেটে নেওয়া হয়, তাই বাতিল হলে ফেরত দিতে হবে
    await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
    // ফেরতটা coin_transactions লেজারেও লিখতে হয়। আগে এই রুটে শুধু ব্যালেন্স বাড়ত, কোনো
    // লেজার সারি লেখা হতো না — অথচ উইথড্র রিকোয়েস্টের সময় -amount সারিটা লেখা হয়েছিল।
    // ফলে ইউজারের ব্যালেন্স আর coin_transactions-এর যোগফল আলাদা হয়ে যেত (প্রতি বাতিল
    // উইথড্রে ঠিক amount পরিমাণ গরমিল), আর /profile/transactions-এ ডেবিট দেখা যেত কিন্তু
    // ফেরত কখনো দেখা যেত না। routes/payment.js-এর rejectPaymentRequestById আগে থেকেই
    // এই সারিটা লেখে — এখানে একই আচরণ মেলানো হলো।
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'withdraw_refund', 'বাতিলকৃত উইথড্র ফেরত')`,
      [request.user_id, request.amount]
    );
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    const wRejectNotif = await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error') RETURNING *`,
      [request.user_id, req.t('admin_withdraw_cancelled_title'), `আপনার ${request.amount} টাকার উইথড্র বাতিল হয়েছে, কয়েন ফেরত দেওয়া হয়েছে।${reason ? ' কারণ: ' + reason : ''}`]
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
    res.status(500).json({ success: false, error: req.t('admin_server_error_retry') });
  } finally {
    client.release();
  }
});

// ==================== সাপোর্ট টিকেট ====================
// আগে এই রুট পুরো chat_messages টেবিল (সব ইউজারের সব মেসেজ, দুই আলাদা কুয়েরিতে) মেমোরিতে
// লোড করে JS-এ গ্রুপ করত এবং প্রতিটা টিকেটের সম্পূর্ণ মেসেজ হিস্ট্রি পেজ লোডের সাথেই ফ্রন্টএন্ডে
// এমবেড করে পাঠাত — ইউজার/মেসেজ সংখ্যা বাড়ার সাথে সাথে এটা মেমোরি ও পেজ-লোড টাইমে স্কেল করত না।
// এখন শুধু টিকেট লিস্টের জন্য প্রতি ইউজারের সর্বশেষ মেসেজ + আনরিড কাউন্ট (LATERAL join দিয়ে,
// routes/chat.js-এর /admin/conversations-এ ব্যবহৃত একই প্যাটার্ন) পেজিনেটেড আকারে আনা হয়;
// একটা নির্দিষ্ট টিকেটের পূর্ণ মেসেজ থ্রেড শুধু ক্লিক করলেই (GET /api/support/:userId/messages)
// on-demand লোড হয়, এবং সেখানেও সর্বশেষ ২০০টা মেসেজে সীমাবদ্ধ থাকে।
router.get('/support', rbac.requirePermission('support_view'), async (req, res) => {
  try {
    const page = clampPage(req.query.page);
    const limit = 30;
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    const searchParams = [];
    let searchClause = '';
    if (search) {
      searchParams.push(`%${search}%`);
      searchClause = `AND u.username ILIKE $${searchParams.length}`;
    }

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM users u
       WHERE u.role != 'admin' AND EXISTS (
         SELECT 1 FROM chat_messages cm WHERE cm.sender_id = u.id OR cm.receiver_id = u.id
       ) ${searchClause}`,
      searchParams
    );
    const total = parseInt(countRes.rows[0].count);

    const openCountRes = await pool.query(
      `SELECT COUNT(*) FROM users u
       WHERE u.role != 'admin' AND EXISTS (
         SELECT 1 FROM chat_messages cm WHERE cm.sender_id = u.id AND cm.is_admin = false AND cm.is_read = false
       )`
    );

    const listParams = [...searchParams, limit, offset];
    const listRes = await pool.query(
      `SELECT u.id AS user_id, u.username,
         lm.message AS last_message, lm.created_at AS last_message_time,
         COALESCE(uc.unread, 0) AS unread_count
       FROM users u
       JOIN LATERAL (
         SELECT message, created_at FROM chat_messages
         WHERE sender_id = u.id OR receiver_id = u.id
         ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread FROM chat_messages
         WHERE sender_id = u.id AND is_admin = false AND is_read = false
       ) uc ON true
       WHERE u.role != 'admin' ${searchClause}
       ORDER BY lm.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const tickets = listRes.rows.map(r => ({
      userId: r.user_id,
      username: r.username,
      lastMessage: r.last_message,
      status: r.unread_count > 0 ? 'Open' : 'Resolved'
    }));

    res.render('admin/support', {
      tickets,
      openCount: parseInt(openCountRes.rows[0].count),
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      total,
      search
    });
  } catch (err) {
    console.error('support list error:', err.message);
    res.render('admin/support', { loadError: true, tickets: [], openCount: 0, page: 1, totalPages: 1, total: 0, search: '' });
  }
});

// একটা নির্দিষ্ট টিকেটের পূর্ণ মেসেজ থ্রেড — on-demand (ticket ক্লিক করলে) লোড হয়,
// সর্বশেষ ২০০টা মেসেজে সীমাবদ্ধ যাতে খুব দীর্ঘ কনভারসেশনও মেমোরিতে সমস্যা না করে।
router.get('/api/support/:userId/messages', rbac.requirePermission('support_view'), requireIntParam('userId'), async (req, res) => {
  try {
    const userId = req.params.userId;
    const result = await pool.query(
      `SELECT message, is_admin, created_at FROM chat_messages
       WHERE sender_id = $1 OR receiver_id = $1
       ORDER BY created_at DESC LIMIT 200`,
      [userId]
    );
    const messages = result.rows.reverse().map(m => ({
      from: m.is_admin ? 'admin' : 'user',
      text: m.message,
      time: m.created_at
    }));
    res.json({ success: true, messages });
  } catch (err) {
    console.error('support messages fetch error:', err.message);
    res.status(500).json({ success: false, error: req.t('admin_server_error_short') });
  }
});

router.post('/api/support/:userId/reply', rbac.requirePermission('support_reply'), requireIntParam('userId'), async (req, res) => {
  try {
    const userId = req.params.userId;
    const message = sanitizeText(req.body.message || '', { maxLen: 2000 });
    if (!message) return res.status(400).json({ success: false, error: req.t('admin_write_a_message') });
    await pool.query(
      `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, is_read, created_at) VALUES ($1,$2,$3,true,true,NOW())`,
      [req.session.user.id, userId, message]
    );
    // ইউজারের পাঠানো মেসেজগুলো রিড হিসেবে মার্ক করা
    await pool.query(`UPDATE chat_messages SET is_read=true WHERE sender_id=$1 AND is_admin=false`, [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('support reply error:', err);
    res.status(500).json({ success: false, error: req.t('admin_server_error_retry') });
  }
});

router.post('/api/support/:userId/resolve', rbac.requirePermission('support_reply'), requireIntParam('userId'), async (req, res) => {
  try {
    const userId = req.params.userId;
    await pool.query(`UPDATE chat_messages SET is_read=true WHERE sender_id=$1 AND is_admin=false`, [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('support resolve error:', err);
    res.status(500).json({ success: false, error: req.t('admin_server_error_retry') });
  }
});

// ==================== ট্রানজেকশন লগ ====================
router.get('/transactions', rbac.requirePermission('reports_view'), async (req, res) => {
  try {
    const page = clampPage(req.query.page);
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
    res.render('admin/transactions', { transactions: [], page: 1, totalPages: 1, total: 0, loadError: true });
  }
});

// ==================== রেফারেল ম্যানেজমেন্ট ====================
// services/referral.js-এর বিদ্যমান referrals/referral_commissions টেবিল থেকে শুধু পড়া হচ্ছে —
// কোনো নতুন বোনাস/কমিশন লজিক এখানে যোগ করা হয়নি (সেটা এখনো শুধু ডিপোজিট-approve ও বাজি ধরার
// সময় services/referral.js-এই ঘটে, অপরিবর্তিত)।
router.get('/referrals', rbac.requirePermission('reports_view'), async (req, res) => {
  try {
    const page = clampPage(req.query.page);
    const limit = 25;
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';

    const conditions = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(ru.username ILIKE $${params.length} OR rd.username ILIKE $${params.length})`);
    }
    if (status === 'bonus_paid') conditions.push('r.signup_bonus_paid = true');
    if (status === 'pending') conditions.push('r.signup_bonus_paid = false');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM referrals r
       JOIN users ru ON r.referrer_id = ru.id
       JOIN users rd ON r.referred_id = rd.id
       ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count);

    const summaryRes = await pool.query(`
      SELECT COUNT(*) AS total_referrals,
             COUNT(*) FILTER (WHERE signup_bonus_paid = true) AS bonus_paid_count
      FROM referrals
    `);
    const commissionSummaryRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM referral_commissions`);

    params.push(limit, offset);
    const referrals = await pool.query(
      `SELECT r.id, r.referrer_id, r.referred_id, r.first_deposit_done, r.signup_bonus_paid, r.created_at,
              ru.username AS referrer_username, ru.referral_code AS referrer_code,
              rd.username AS referred_username, rd.created_at AS referred_joined_at,
              COALESCE((SELECT SUM(amount) FROM referral_commissions WHERE earner_id = r.referrer_id AND from_user_id = r.referred_id), 0) AS commission_earned
       FROM referrals r
       JOIN users ru ON r.referrer_id = ru.id
       JOIN users rd ON r.referred_id = rd.id
       ${where}
       ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.render('admin/referrals', {
      referrals: referrals.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total,
      search, status,
      summary: {
        totalReferrals: parseInt(summaryRes.rows[0].total_referrals),
        bonusPaidCount: parseInt(summaryRes.rows[0].bonus_paid_count),
        totalCommissionPaid: Number(commissionSummaryRes.rows[0].total)
      }
    });
  } catch (err) {
    console.error('referrals list error:', err.message);
    res.render('admin/referrals', { loadError: true,
      referrals: [], page: 1, totalPages: 1, total: 0, search: '', status: '',
      summary: { totalReferrals: 0, bonusPaidCount: 0, totalCommissionPaid: 0 }
    });
  }
});

// ==================== USERS ====================
router.get('/users', rbac.requirePermission('users_view'), async (req, res) => {
  try {
    const page = clampPage(req.query.page);
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
    res.render('admin/users', { users: [], page: 1, totalPages: 1, total: 0, search: '', status: '', loadError: true });
  }
});

// ==================== USER DETAIL ====================
router.get('/users/:id', rbac.requirePermission('users_view'), async (req, res) => {
  try {
    const uId = req.params.id;
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [uId]);
    const user = userRes.rows[0];
    if (!user) {
      req.flash('error', req.t('admin_user_not_found_x'));
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
    req.flash('error', req.t('admin_something_went_wrong_x'));
    res.redirect('/admin/users');
  }
});

// ==================== ইউজার প্রোফাইল এডিট (username/email/phone) ====================
// routes/auth.js-এর /register ও routes/profile.js-এর একই ফরম্যাট নিয়ম রি-ইউজ করা হয়েছে
// (নতুন কোনো ভ্যালিডেশন স্ট্যান্ডার্ড তৈরি করা হয়নি)।
const ADMIN_EDIT_USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
const ADMIN_EDIT_PHONE_RE = /^[0-9+\-\s]{6,20}$/;
const ADMIN_EDIT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/users/:id/edit-profile', rbac.requirePermission('users_edit'), adminActionLimiter, requireIntParam('id'), async (req, res) => {
  const uId = req.params.id;
  try {
    const existingRes = await pool.query('SELECT username, email, phone, email_verified FROM users WHERE id = $1', [uId]);
    const existing = existingRes.rows[0];
    if (!existing) {
      req.flash('error', req.t('admin_user_not_found_x'));
      return res.redirect('/admin/users');
    }

    const newUsername = req.body.username !== undefined ? String(req.body.username).trim() : existing.username;
    const newEmail = req.body.email !== undefined ? (String(req.body.email).trim() || null) : existing.email;
    const newPhone = req.body.phone !== undefined ? (String(req.body.phone).trim() || null) : existing.phone;

    // ==================== ভ্যালিডেশন ====================
    if (!newUsername || !ADMIN_EDIT_USERNAME_RE.test(newUsername)) {
      req.flash('error', req.t('auth_username_format_invalid'));
      return res.redirect('/admin/users/' + uId);
    }
    if (newEmail && !ADMIN_EDIT_EMAIL_RE.test(newEmail)) {
      req.flash('error', req.t('auth_email_format_invalid'));
      return res.redirect('/admin/users/' + uId);
    }
    if (newPhone && !ADMIN_EDIT_PHONE_RE.test(newPhone)) {
      req.flash('error', req.t('admin_phone_format_invalid'));
      return res.redirect('/admin/users/' + uId);
    }
    if (!newEmail && !newPhone) {
      req.flash('error', req.t('admin_email_or_phone_required'));
      return res.redirect('/admin/users/' + uId);
    }

    // ==================== ডুপ্লিকেট চেক (নিজেকে বাদ দিয়ে) ====================
    if (newUsername !== existing.username) {
      const dup = await pool.query('SELECT id FROM users WHERE username = $1 AND id <> $2', [newUsername, uId]);
      if (dup.rows.length) {
        req.flash('error', req.t('admin_username_taken'));
        return res.redirect('/admin/users/' + uId);
      }
    }
    if (newEmail && newEmail !== existing.email) {
      const dup = await pool.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [newEmail, uId]);
      if (dup.rows.length) {
        req.flash('error', req.t('admin_email_taken'));
        return res.redirect('/admin/users/' + uId);
      }
    }
    if (newPhone && newPhone !== existing.phone) {
      const dup = await pool.query('SELECT id FROM users WHERE phone = $1 AND id <> $2', [newPhone, uId]);
      if (dup.rows.length) {
        req.flash('error', req.t('admin_phone_taken'));
        return res.redirect('/admin/users/' + uId);
      }
    }

    const emailChanged = newEmail !== existing.email;

    // ==================== সেভ ====================
    // ইমেইল বদলালে email_verified বাধ্যতামূলকভাবে false-এ রিসেট করা হয় — নাহলে অ্যাডমিন-বসানো
    // একটা নতুন ইমেইল ভুলভাবে "ভেরিফায়েড" দেখাত, যদিও ইউজার নিজে কখনো সেই ইমেইলের মালিকানা
    // প্রমাণ করেনি। পুরনো ইমেইলের জন্য পাঠানো verification_token-ও invalidate করা হয়, যাতে
    // সেটা নতুন ইমেইলে ব্যবহার করা না যায়। নতুন ভেরিফিকেশন মেইল পাঠানো হয় না এখান থেকে —
    // ইউজার নিজের প্রোফাইল পেজ থেকে "Resend Verification" ব্যবহার করে চাইলে পাঠাতে পারবে।
    if (emailChanged) {
      await pool.query(
        `UPDATE users SET username=$1, email=$2, phone=$3, email_verified=false, verification_token=NULL, verification_token_expiry=NULL WHERE id=$4`,
        [newUsername, newEmail, newPhone, uId]
      );
    } else {
      await pool.query(`UPDATE users SET username=$1, email=$2, phone=$3 WHERE id=$4`, [newUsername, newEmail, newPhone, uId]);
    }

    const changedFields = [];
    if (newUsername !== existing.username) changedFields.push(`username: "${existing.username}" → "${newUsername}"`);
    if (emailChanged) changedFields.push(`email: "${existing.email || '—'}" → "${newEmail || '—'}" (re-verification প্রয়োজন)`);
    if (newPhone !== existing.phone) changedFields.push(`phone: "${existing.phone || '—'}" → "${newPhone || '—'}"`);

    if (changedFields.length) {
      await logAdminAction(
        req.session.user.id, req.session.user.username, 'USER_PROFILE_EDITED',
        `ইউজার #${uId}-এর প্রোফাইল তথ্য পরিবর্তন: ${changedFields.join(', ')}`, req.ip
      );
      logAuditEvent({
        req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
        action: 'USER_PROFILE_EDITED', category: 'security', status: 'success',
        riskLevel: emailChanged ? 'high' : 'medium',
        details: { targetUserId: uId, changed: changedFields, emailReVerificationRequired: emailChanged }
      }).catch(e => console.error('logAuditEvent (USER_PROFILE_EDITED) error:', e.message));
    }

    req.flash('success', changedFields.length ? req.t('admin_profile_updated') : req.t('admin_no_changes'));
    return res.redirect('/admin/users/' + uId);
  } catch (err) {
    console.error('user profile edit error:', err.message);
    req.flash('error', req.t('admin_something_went_wrong_x'));
    return res.redirect('/admin/users/' + uId);
  }
});

// ==================== USER ACTIONS ====================
router.post('/users/:id/ban', rbac.requirePermission('users_ban'), requireIntParam('id'), async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1 RETURNING is_banned, username', [req.params.id]);
    if (r.rows[0]) {
      // isAuth মিডলওয়্যার active/banned স্ট্যাটাস ৩০ সেকেন্ডের জন্য ক্যাশ করে (middleware/auth.js)।
      // ব্যান/আনব্যান সাথে সাথেই effective করতে হলে ওই ক্যাশ এখানেই invalidate করা দরকার,
      // নাহলে সদ্য-ব্যান হওয়া ইউজার পুরনো সেশন দিয়ে আরও কিছুক্ষণ অ্যাক্সেস পেতে পারত।
      await cache.del(cacheKeys.userActiveStatus(req.params.id)).catch(() => {});
      await logAdminAction(req.session.user.id, req.session.user.username, r.rows[0].is_banned ? 'USER_BAN' : 'USER_UNBAN', `${r.rows[0].username} (#${req.params.id}) কে ${r.rows[0].is_banned ? 'ব্যান' : 'আনব্যান'} করা হয়েছে`, req.ip);
      logAuditEvent({
        req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
        action: r.rows[0].is_banned ? 'USER_BANNED' : 'USER_UNBANNED', category: 'security', status: 'success',
        riskLevel: r.rows[0].is_banned ? 'high' : 'medium',
        details: { targetUserId: req.params.id, targetUsername: r.rows[0].username }
      }).catch(e => console.error('logAuditEvent (USER_BAN/UNBAN) error:', e.message));
    }
    req.flash('success', req.t('admin_status_updated'));
  } catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); }
  redirectBack(req, res, '/admin');
});

// ==================== বাল্ক ইউজার ব্যান ====================
// একক /users/:id/ban রুট toggle (ব্যান↔আনব্যান) করে — একসাথে অনেক ইউজারে সেই সিমান্টিক্স
// অপ্রত্যাশিত ফলাফল দিত (কেউ ব্যান হতো, কেউ আনব্যান)। তাই বাল্ক অ্যাকশনটা স্পষ্টভাবে is_banned=true
// সেট করে (প্রকৃত "ban", toggle না) — একক রুটের কোনো আচরণ বদলানো হয়নি।
router.post('/users/bulk-ban', rbac.requirePermission('users_ban'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const cleanIds = [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))]
    .filter((id) => id !== req.session.user.id); // নিজের অ্যাকাউন্ট নিজে ব্যান করা যাবে না
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: req.t('admin_no_valid_user_selected') });
  }
  if (cleanIds.length > 100) {
    return res.status(400).json({ success: false, error: req.t('admin_user_bulk_limit') });
  }

  const results = [];
  for (const id of cleanIds) {
    try {
      const r = await pool.query('UPDATE users SET is_banned = true WHERE id = $1 AND is_banned = false RETURNING username', [id]);
      if (r.rows[0]) {
        await cache.del(cacheKeys.userActiveStatus(id)).catch(() => {});
        results.push({ id, success: true, username: r.rows[0].username });
      } else {
        // ইউজার নেই, অথবা আগে থেকেই ব্যান করা — দুটোই "নতুন করে কিছু হয়নি" হিসেবে গণ্য, ত্রুটি না
        const exists = await pool.query('SELECT username, is_banned FROM users WHERE id = $1', [id]);
        if (!exists.rows[0]) results.push({ id, success: false, error: req.t('common_user_not_found') });
        else results.push({ id, success: true, username: exists.rows[0].username, alreadyBanned: true });
      }
    } catch (err) {
      // প্রতি-সারির ব্যর্থতা ক্লায়েন্টে JSON হিসেবে ফেরত যায়, তাই কাঁচা pg মেসেজ (টেবিল/কলাম/
      // কনস্ট্রেইন্টের নাম) এখানে বসানো যাবে না — গুনতি ও আইডি রিপোর্ট হয়, কারণ লগে থাকে।
      console.error(`bulk operation row ${id} failed:`, err && err.stack ? err.stack : err);
      results.push({ id, success: false, error: req.t('admin_process_failed_db') });
    }
  }

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  logAdminAction(
    req.session.user.id, req.session.user.username, 'BULK_USER_BAN',
    `বাল্ক ব্যান: ${succeeded.length}টা সফল, ${failed.length}টা ব্যর্থ (আইডি: ${cleanIds.join(',')})`, req.ip
  );
  succeeded.forEach((r) => {
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'USER_BANNED', category: 'security', status: 'success', riskLevel: 'high',
      details: { targetUserId: r.id, targetUsername: r.username, via: 'bulk' }
    }).catch((e) => console.error('logAuditEvent (BULK_USER_BAN) error:', e.message));
  });

  res.json({ success: true, total: cleanIds.length, succeeded: succeeded.length, failed: failed.length, results });
});

// আগে এখানে সরাসরি `DELETE FROM users` চালানো হতো। কিন্তু users-এর দিকে ২৯টা ফরেন কী
// RESTRICT (payment_requests, bets, referral_commissions, kyc_requests ...), তাই আর্থিক
// রেকর্ডওয়ালা যেকোনো ইউজারের ডিলিট ব্যর্থ হতো এবং অ্যাডমিন শুধু "ডিলিট করতে সমস্যা!"
// দেখতেন — কী ঘটল বা কী করণীয় কিছুই বোঝা যেত না।
//
// FK দুর্বল করা হয়নি — আর্থিক ইতিহাস সুরক্ষিতই থাকে। services/userDeletion.js এখন
// সুরক্ষিত রেকর্ড না থাকলে সত্যিকারের ডিলিট করে, আর থাকলে অ্যাকাউন্ট অ্যানোনিমাইজ করে
// নিষ্ক্রিয় করে। দুই ক্ষেত্রেই সেশন বাতিল হয় এবং অ্যাডমিনকে স্পষ্ট করে জানানো হয়
// আসলে কোনটা ঘটেছে।
router.post('/users/:id/delete', rbac.requirePermission('users_delete'), requireIntParam('id'), async (req, res) => {
  try {
    if (String(req.session.user.id) === String(req.params.id)) {
      req.flash('error', req.t('admin_cannot_delete_self'));
      return res.redirect('/admin/users');
    }

    const outcome = await deleteOrDeactivateUser(req.params.id, req.session.user.username);

    if (outcome.mode === 'not_found') {
      req.flash('error', req.t('admin_user_not_found_x'));
      return res.redirect('/admin/users');
    }

    if (outcome.mode === 'deleted') {
      req.flash('success', req.t('admin_user_deleted_permanently').replace('{value}', outcome.username));
    } else {
      req.flash('success',
        req.t('admin_user_delete_blocked_records').replace('{value}', outcome.username) +
        req.t('admin_user_anonymized') +
        req.t('admin_financial_history_preserved'));
    }

    await logAdminAction(
      req.session.user.id, req.session.user.username,
      outcome.mode === 'deleted' ? 'USER_DELETE' : 'USER_DEACTIVATE',
      `${outcome.username} (#${req.params.id}) — ${outcome.mode === 'deleted' ? 'স্থায়ীভাবে ডিলিট' : 'অ্যানোনিমাইজ ও নিষ্ক্রিয়'} (${outcome.sessionsRevoked || 0}টি সেশন বাতিল)`,
      req.ip
    );
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: outcome.mode === 'deleted' ? 'USER_DELETED' : 'USER_DEACTIVATED',
      category: 'security', status: 'success', riskLevel: 'high',
      details: {
        targetUserId: req.params.id, targetUsername: outcome.username,
        mode: outcome.mode, sessionsRevoked: outcome.sessionsRevoked || 0,
        blockedBy: outcome.blockedBy || null
      }
    }).catch(e => console.error('logAuditEvent (USER_DELETE) error:', e.message));
  } catch (err) {
    console.error('delete error:', err.message);
    req.flash('error', req.t('admin_delete_failed'));
  }
  res.redirect('/admin/users');
});

// ==================== Security Overview — Security Center-এর অ্যাডমিন-সাইড ড্যাশবোর্ড ====================
router.get('/security-overview', rbac.requirePermission('activity_log_view'), async (req, res) => {
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
    res.render('admin/security-overview', { loadError: true,
      stats: { totalUsers: 0, emailUsers: 0, emailVerified: 0, pinConfigured: 0, activeSessions: 0, newDeviceLogins7d: 0, pinLocked: 0, totpEnabled: 0, failedLogins24h: 0 },
      recentLogs: []
    });
  }
});

// ==================== Bot Detection System — Admin Bot Activity ও Alerts ====================
router.get('/bot-logs', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  try {
    const { risk_level = '', endpoint = '', ip = '', from = '', to = '' } = req.query;
    const page = clampPage(req.query.page);
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
    res.render('admin/bot-logs', { loadError: true,
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { risk_level: '', endpoint: '', ip: '', from: '', to: '' },
      summary: { last24h: 0, high24h: 0, blocked24h: 0 }
    });
  }
});


// অ্যাডমিন আসল PIN কখনো দেখতে/সেট করতে পারবে না — শুধু হ্যাশ ক্লিয়ার করে দেয়, ইউজারকে
// আবার নতুন PIN তৈরি করতে হবে। প্রতিটি রিসেট withdraw_pin_logs + admin_logs উভয় জায়গায় লগ হয়।
router.post('/users/:id/withdraw-pin/reset', rbac.requirePermission('users_edit'), adminActionLimiter, requireIntParam('id'), async (req, res) => {
  try {
    await adminResetPin(req.params.id, req.session.user.id, req.session.user.username, req.ip);
    await logAdminAction(
      req.session.user.id,
      req.session.user.username,
      'WITHDRAW_PIN_RESET',
      `ইউজার #${req.params.id}-এর Withdraw PIN রিসেট করা হয়েছে`,
      req.ip
    );
    req.flash('success', req.t('admin_user_pin_reset'));
  } catch (err) {
    console.error('admin withdraw pin reset error:', err.message);
    req.flash('error', req.t('admin_something_went_wrong_x'));
  }
  redirectBack(req, res, '/admin');
});

router.post('/users/:id/coins/add', rbac.requirePermission('users_edit'), adminFinancialLimiter, requireIntParam('id'), requireAmount('amount', { max: 10_000_000 }), async (req, res) => {
  try {
    const amount = req.body.amount; // requireAmount দিয়ে ইতিমধ্যে যাচাই ও normalize করা
    const reason = (req.body.reason || '').trim().slice(0, 200);
    // ব্যালেন্স আপডেট ও লেজার এন্ট্রি — দুটো আলাদা pool.query ছিল, কোনো ট্রানজেকশন ছাড়া।
    // দ্বিতীয়টা ব্যর্থ হলে (বা মাঝপথে প্রসেস মরলে) কয়েন যোগ হয়ে যেত কিন্তু coin_transactions-এ
    // কোনো রেকর্ড থাকত না — ব্যালেন্স আর লেজার স্থায়ীভাবে আলাদা হয়ে যেত। এখন একসাথে commit হয়।
    await withTransaction(async (client) => {
      await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, req.params.id]);
      await client.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_add',$3)`, [req.params.id, amount, reason || 'অ্যাডমিন কয়েন যোগ']);
    });
    await logAdminAction(req.session.user.id, req.session.user.username, 'COIN_ADD', `ইউজার #${req.params.id}-কে ${amount} কয়েন যোগ${reason ? ' — কারণ: ' + reason : ''}`, req.ip);
    req.flash('success', req.t('admin_coins_added'));
  } catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); }
  redirectBack(req, res, '/admin');
});

router.post('/users/:id/coins/remove', rbac.requirePermission('users_edit'), adminFinancialLimiter, requireIntParam('id'), requireAmount('amount', { max: 10_000_000 }), async (req, res) => {
  try {
    const amount = req.body.amount;
    const reason = (req.body.reason || '').trim().slice(0, 200);
    // দুটো বাগ ছিল এখানে:
    //   ১. ব্যালেন্স ও লেজার আলাদা pool.query-তে, কোনো ট্রানজেকশন ছাড়া।
    //   ২. GREATEST(coins - $1, 0) ব্যালেন্সকে শূন্যে আটকায়, কিন্তু লেজারে পুরো -amount
    //      লেখা হতো। ১০০ কয়েনের ইউজার থেকে ৫০০ কমালে ব্যালেন্স হতো ০ (আসলে কমেছে ১০০)
    //      অথচ লেজার বলত -৫০০ — স্থায়ী ৪০০ কয়েনের গরমিল।
    // এখন দুটোই এক ট্রানজেকশনে, আর লেজারে ঠিক যতটা সত্যিই কমেছে সেটাই লেখা হয়।
    // ব্যালেন্স আগের মতোই শূন্যের নিচে নামে না।
    const removed = await withTransaction(async (client) => {
      // FOR UPDATE দিয়ে সারি লক করে আগের ব্যালেন্স পড়া হয়, যাতে সমান্তরাল অন্য কোনো
      // মিউটেশনের সাথে check-then-update রেস না হয়।
      const before = await client.query('SELECT coins FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before.rows[0]) return 0;

      const beforeCoins = Number(before.rows[0].coins);
      const actualRemoved = Math.min(amount, beforeCoins); // ব্যালেন্স শূন্যের নিচে নামে না
      if (actualRemoved <= 0) return 0;

      await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [actualRemoved, req.params.id]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_remove',$3)`,
        [req.params.id, -actualRemoved, reason || 'অ্যাডমিন কয়েন কমানো']
      );
      return actualRemoved;
    });
    await logAdminAction(req.session.user.id, req.session.user.username, 'COIN_REMOVE', `ইউজার #${req.params.id}-এর ${removed} কয়েন কমানো${reason ? ' — কারণ: ' + reason : ''}`, req.ip);
    req.flash('success', req.t('admin_coins_removed').replace('{value}', removed));
  } catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); }
  redirectBack(req, res, '/admin');
});

router.post('/users/:id/freebet', rbac.requirePermission('users_edit'), adminFinancialLimiter, requireIntParam('id'), requireAmount('amount', { max: 1_000_000 }), async (req, res) => {
  try {
    const amount = req.body.amount;
    await grantFreeBet(req.params.id, amount, 'admin');
    await logAdminAction(req.session.user.id, req.session.user.username, 'freebet_grant', `${amount} taka free bet to user #${req.params.id}`, req.ip);
    req.flash('success', req.t('admin_freebet_granted').replace('{value}', amount));
  } catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); }
  redirectBack(req, res, '/admin');
});

// ==================== MATCHES ====================
router.get('/matches', rbac.requirePermission('matches_manage'), async (req, res) => {
  try {
    const matches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC');
    res.render('admin/matches', { matches: matches.rows });
  } catch (err) { res.render('admin/matches', { loadError: true, matches: [] }); }
});

router.post('/matches/add', rbac.requirePermission('matches_manage'), async (req, res) => {
  try {
    const { title, sport, team_a, team_b, start_time } = req.body;
    if (!team_a || !team_b) { req.flash('error', req.t('admin_both_team_names_required')); return res.redirect('/admin/matches'); }
    await pool.query(
      `INSERT INTO matches (title, sport, team_a, team_b, status, start_time) VALUES ($1,$2,$3,$4,'upcoming',$5)`,
      [title || `${team_a} vs ${team_b}`, sport || 'cricket', team_a, team_b, start_time || null]);
    req.flash('success', req.t('admin_match_added'));
  } catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); }
  res.redirect('/admin/matches');
});

router.post('/matches/:id/delete', rbac.requirePermission('matches_manage'), async (req, res) => {
  try { await pool.query('DELETE FROM matches WHERE id = $1', [req.params.id]); req.flash('success', req.t('admin_match_deleted')); }
  catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); }
  res.redirect('/admin/matches');
});

// ==================== MARKETS ====================
router.get('/markets/:matchId', rbac.requirePermission('matches_manage'), async (req, res) => {
  try {
    const matchResult = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.matchId]);
    const match = matchResult.rows[0];
    if (!match) return res.status(404).send('Match not found');
    const markets = await pool.query('SELECT * FROM markets WHERE match_id = $1', [req.params.matchId]);
    res.render('admin/markets', { match: match, markets: markets.rows });
  } catch (err) { res.status(500).send('Server Error'); }
});

router.post('/markets/update', rbac.requirePermission('matches_manage'), async (req, res) => {
  try {
    const { match_id, type, name, odds, status } = req.body;
    await pool.query(`
      INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (match_id, type, name) DO UPDATE SET odds = EXCLUDED.odds, status = EXCLUDED.status, updated_at = NOW()
    `, [match_id, type, name, odds, status || 'open']);
    await cache.del(cacheKeys.matchDetail(match_id)).catch(() => {});
    req.flash('success', req.t('admin_market_updated'));
    res.redirect(`/admin/markets/${match_id}`);
  } catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); res.redirect('/admin/matches'); }
});

router.post('/markets/:marketId/toggle', rbac.requirePermission('matches_manage'), async (req, res) => {
  try {
    const mRes = await pool.query('UPDATE markets SET status = $1 WHERE id = $2 RETURNING match_id', [req.body.status, req.params.marketId]);
    if (mRes.rows[0]) await cache.del(cacheKeys.matchDetail(mRes.rows[0].match_id)).catch(() => {});
    req.flash('success', req.t('admin_market_updated'));
  } catch (err) { req.flash('error', req.t('admin_something_went_wrong_x')); }
  redirectBack(req, res, '/admin');
});

router.post('/markets/:marketId/settle', rbac.requirePermission('matches_manage'), async (req, res) => {
  const marketId = req.params.marketId;
  const { winning_runner } = req.body;
  if (!winning_runner) { req.flash('error', req.t('admin_select_winner')); return redirectBack(req, res, '/admin'); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bets = await client.query(`SELECT * FROM bets WHERE market_id = $1 AND status = 'pending' FOR UPDATE`, [marketId]);
    let winnersCount = 0;
    const notifsToEmit = [];
    for (const bet of bets.rows) {
      if (String(bet.runner) === String(winning_runner)) {
        const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
        // ডেমো বেট স্টেক নেওয়া হয়েছিল demo_balance থেকে (routes/matches.js) — জেতার
        // পেঅাউটও একই কলামে যেতে হবে, নাহলে ডেমো বাজি থেকে সত্যিকারের তোলাযোগ্য coins তৈরি হয়ে যায়।
        if (bet.is_demo) {
          await client.query('UPDATE users SET demo_balance = COALESCE(demo_balance,0) + $1 WHERE id = $2', [payout, bet.user_id]);
          await client.query(`INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1,'sports','bet_win',$2,'বেট জয় (ডেমো)')`, [bet.user_id, payout]);
        } else {
          await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [payout, bet.user_id]);
          await client.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'bet_win','বেট জয়')`, [bet.user_id, payout]);
        }
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
    await logAdminAction(req.session.user.id, req.session.user.username, 'MARKET_SETTLED', `Market #${marketId} settled — winning_runner=${winning_runner}, ${bets.rows.length} bets, ${winnersCount} winners`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'MARKET_SETTLED', category: 'financial', status: 'success', riskLevel: 'high',
      details: { marketId, winningRunner: winning_runner, betsSettled: bets.rows.length, winnersCount }
    }).catch(e => console.error('logAuditEvent (MARKET_SETTLED) error:', e.message));
    req.flash('success', req.t('admin_settle_done').replace('{value1}', bets.rows.length).replace('{value2}', winnersCount));
    redirectBack(req, res, '/admin');
  } catch (err) {
    await client.query('ROLLBACK');
    req.flash('error', req.t('admin_settle_failed'));
    redirectBack(req, res, '/admin');
  } finally { client.release(); }
});

// ==================== BETS ====================
router.get('/bets', rbac.requirePermission('games_manage'), async (req, res) => {
  try {
    const page = clampPage(req.query.page);
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
    res.render('admin/bets', { loadError: true, bets: [], page: 1, totalPages: 1, total: 0, status: '', pendingSettlement: 0, todayStake: 0, todayGgr: 0 });
  }
});

// ==================== লাইভ বেট টেবিল (Auto-refresh, প্রতি ৪ সেকেন্ডে) — views/admin/bets.ejs পোল করে ====================
// উপরের GET /bets পেজ-রেন্ডার হ্যান্ডলারের ঠিক একই কোয়েরি-লজিক, শুধু res.render()-এর বদলে JSON রেসপন্স।
router.get('/api/bets-live', rbac.requirePermission('games_manage'), async (req, res) => {
  try {
    const page = clampPage(req.query.page);
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

    res.json({
      success: true,
      bets: bets.rows,
      total,
      pendingSettlement: parseInt(pendingCountRes.rows[0].count),
      todayStake: Number(todayStakeRes.rows[0].total),
      todayGgr: Number(todayGgrRes.rows[0].staked) - Number(todayGgrRes.rows[0].paidout)
    });
  } catch (err) {
    console.error('bets-live error:', err.message);
    res.json({ success: false, bets: [], total: 0, pendingSettlement: 0, todayStake: 0, todayGgr: 0 });
  }
});

router.post('/bets/:id/settle', rbac.requirePermission('games_manage'), async (req, res) => {
  const { id } = req.params;
  const { result } = req.body;
  if (!['won', 'lost'].includes(result)) {
    req.flash('error', req.t('admin_invalid_result'));
    return res.redirect('/admin/bets');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT * FROM bets WHERE id=$1 FOR UPDATE', [id]);
    const bet = b.rows[0];
    if (!bet || bet.status !== 'pending') {
      await client.query('ROLLBACK');
      req.flash('error', req.t('admin_bet_not_found_or_settled'));
      return res.redirect('/admin/bets');
    }
    await client.query('UPDATE bets SET status=$1 WHERE id=$2', [result, id]);
    let settleNotif;
    if (result === 'won') {
      const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
      if (bet.is_demo) {
        await client.query('UPDATE users SET demo_balance = COALESCE(demo_balance,0) + $1 WHERE id=$2', [payout, bet.user_id]);
        await client.query(`INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1,'sports','bet_win',$2,'বেট জয় (ডেমো)')`, [bet.user_id, payout]);
      } else {
        await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [payout, bet.user_id]);
        await client.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'bet_win','বেট জয়')`, [bet.user_id, payout]);
      }
      settleNotif = await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট জিতেছেন!',$2,'success') RETURNING *`, [bet.user_id, `আপনি ৳${payout} জিতেছেন!`]);
    } else {
      settleNotif = await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট ফলাফল',$2,'error') RETURNING *`, [bet.user_id, `আপনার ৳${bet.stake} বেটটি হেরে গেছে।`]);
    }
    await client.query('COMMIT');
    if (settleNotif.rows[0]) emitToUser(bet.user_id, settleNotif.rows[0]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'BET_SETTLED', `Bet #${id} settled as ${result} (user #${bet.user_id}, stake ${bet.stake})`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'BET_SETTLED', category: 'financial', status: 'success', riskLevel: 'high',
      details: { betId: id, result, userId: bet.user_id, stake: bet.stake, odd: bet.odd }
    }).catch(e => console.error('logAuditEvent (BET_SETTLED) error:', e.message));
    req.flash('success', req.t('admin_bet_settled'));
    res.redirect('/admin/bets');
  } catch (err) {
    await client.query('ROLLBACK');
    req.flash('error', req.t('payment_generic_error'));
    res.redirect('/admin/bets');
  } finally {
    client.release();
  }
});

// ==================== বোনাস ম্যানেজমেন্ট ====================
router.get('/bonuses', rbac.requirePermission('users_edit'), async (req, res) => {
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
    res.render('admin/bonuses', { loadError: true, bonuses: [], stats: { active: 0, completed: 0, cancelled: 0, total_active_amount: 0 } });
  }
});

router.post('/bonuses/add', rbac.requirePermission('users_edit'), async (req, res) => {
  try {
    const { username } = req.body;
    const bonus_type = sanitizeText(req.body.bonus_type || '', { maxLen: 50 });
    const bonus_amount = parseAmount(req.body.bonus_amount, { max: 1_000_000 });
    const sports_required = Number.isFinite(Number(req.body.sports_required)) ? Math.max(0, parseInt(req.body.sports_required) || 0) : 0;
    const casino_required = Number.isFinite(Number(req.body.casino_required)) ? Math.max(0, parseInt(req.body.casino_required) || 0) : 0;
    if (!bonus_amount) { req.flash('error', req.t('admin_valid_bonus_amount')); return res.redirect('/admin/bonuses'); }
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

router.post('/bonuses/:id/cancel', rbac.requirePermission('users_edit'), async (req, res) => {
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
    res.render('admin/vip', { loadError: true,
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
    req.flash('success', req.t('admin_vip_level_saved').replace('{value}', result.level));
    res.redirect('/admin/vip');
  } catch (err) {
    console.error('Admin VIP save error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_vip_level_save_failed')));
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
    const page = clampPage(req.query.page);
    const rewardType = req.query.type || null;
    const rewardHistory = await listAllRewardHistory({ page, limit: 50, rewardType });
    const upgradeHistory = await listAllUpgradeHistory({ page: 1, limit: 50 });
    res.render('admin/vip-history', { rewardHistory, upgradeHistory, page, rewardType, active: 'vip' });
  } catch (err) {
    console.error('Admin VIP history error:', err.message);
    res.render('admin/vip-history', { loadError: true,
      rewardHistory: { rows: [], total: 0, page: 1, totalPages: 1 },
      upgradeHistory: { rows: [], total: 0, page: 1, totalPages: 1 },
      page: 1, rewardType: null, active: 'vip'
    });
  }
});

// ==================== প্রমোশন ব্যানার ====================
router.get('/promotions', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promotions ORDER BY position ASC, created_at DESC');
    res.render('admin/promotions', { promotions: result.rows });
  } catch (err) {
    console.error('Promotions list error:', err.message);
    res.render('admin/promotions', { loadError: true, promotions: [] });
  }
});

router.post('/promotions/add', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const title = sanitizeText(req.body.title || '', { maxLen: 200 }) || null;
    const image_url = req.body.image_url && isSafeUrl(req.body.image_url) ? req.body.image_url.trim() : null;
    const link_url = req.body.link_url && isSafeUrl(req.body.link_url) ? req.body.link_url.trim() : null;
    const position = Number.isFinite(Number(req.body.position)) ? parseInt(req.body.position) || 0 : 0;
    if (!image_url) { req.flash('error', req.t('admin_valid_image_url')); return res.redirect('/admin/promotions'); }
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

router.post('/promotions/:id/toggle', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE promotions SET active = NOT active WHERE id = $1', [id]);
    res.redirect('/admin/promotions');
  } catch (err) {
    console.error('Promotion toggle error:', err.message);
    res.redirect('/admin/promotions');
  }
});

router.post('/promotions/:id/delete', rbac.requirePermission('settings_edit'), async (req, res) => {
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
router.get('/tournaments', rbac.requirePermission('matches_manage'), async (req, res) => {
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
    res.render('admin/tournaments', { loadError: true, tournaments: [], stats: { total: 0, live: 0, upcoming: 0, completed: 0 } });
  }
});

router.post('/tournaments/add', rbac.requirePermission('matches_manage'), async (req, res) => {
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

router.post('/tournaments/:id/status', rbac.requirePermission('matches_manage'), async (req, res) => {
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

router.post('/tournaments/:id/delete', rbac.requirePermission('matches_manage'), async (req, res) => {
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
router.get('/news', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 200');
    res.render('admin/news', { newsList: result.rows });
  } catch (err) {
    console.error('News list error:', err.message);
    res.render('admin/news', { loadError: true, newsList: [] });
  }
});

router.post('/news/add', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const title = sanitizeText(req.body.title || '', { maxLen: 200 });
    const content = sanitizeText(req.body.content || '', { maxLen: 20000 });
    const image_url = req.body.image_url && isSafeUrl(req.body.image_url) ? req.body.image_url.trim() : null;
    const sport = sanitizeText(req.body.sport || '', { maxLen: 50 }) || null;
    if (!title) { req.flash('error', req.t('admin_title_required')); return res.redirect('/admin/news'); }
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

router.post('/news/:id/delete', rbac.requirePermission('settings_edit'), requireIntParam('id'), async (req, res) => {
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

router.get('/activity/export.csv', rbac.requirePermission('activity_log_view'), async (req, res) => {
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
router.get('/bot-monitoring', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
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
    res.render('admin/bot-monitoring', { loadError: true,
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
    res.render('admin/roles', { loadError: true, roles: [], permissionGroups: rbac.permissionGroups(), error: req.t('admin_roles_load_failed') });
  }
});

router.get('/roles/matrix', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const roles = await rbac.listRoles();
    res.render('admin/roles-matrix', { roles, permissionGroups: rbac.permissionGroups() });
  } catch (err) {
    console.error('roles matrix error:', err.message);
    req.flash('error', req.t('admin_matrix_load_failed'));
    res.redirect('/admin/roles');
  }
});

router.post('/roles', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const permissions = {};
    Object.keys(rbac.PERMISSIONS).forEach(key => { permissions[key] = req.body[`perm_${key}`] === 'on'; });
    const role = await rbac.createRole({ name: req.body.name, description: sanitizeText(req.body.description || ''), permissions });
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_CREATED', `নতুন Role: ${role.name} (${role.key})`, req.ip);
    req.flash('success', req.t('admin_role_created').replace('{value}', role.name));
    res.redirect('/admin/roles');
  } catch (err) {
    console.error('role management error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_request_failed_db')));
    res.redirect('/admin/roles');
  }
});

router.get('/roles/:id/edit', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const role = await rbac.getRole(req.params.id);
    if (!role) { req.flash('error', req.t('admin_role_not_found')); return res.redirect('/admin/roles'); }
    res.render('admin/role-edit', { role, permissionGroups: rbac.permissionGroups() });
  } catch (err) {
    console.error('role management error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_request_failed_db')));
    res.redirect('/admin/roles');
  }
});

router.post('/roles/:id', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const existing = await rbac.getRole(req.params.id);
    if (!existing) { req.flash('error', req.t('admin_role_not_found')); return res.redirect('/admin/roles'); }
    const permissions = {};
    Object.keys(rbac.PERMISSIONS).forEach(key => {
      // Super Admin Role-এর permission UI থেকে বদলানো যাবে না — সবসময় সব true (override)
      permissions[key] = existing.key === 'super_admin' ? true : req.body[`perm_${key}`] === 'on';
    });
    const role = await rbac.updateRole(req.params.id, { name: existing.is_system ? existing.name : req.body.name, description: sanitizeText(req.body.description || ''), permissions });
    await logAdminAction(req.session.user.id, req.session.user.username, 'PERMISSION_CHANGED', `Role "${role.name}"-এর permission আপডেট করা হয়েছে`, req.ip);
    req.flash('success', req.t('admin_role_updated').replace('{value}', role.name));
    res.redirect('/admin/roles');
  } catch (err) {
    console.error('role management error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_request_failed_db')));
    res.redirect('/admin/roles');
  }
});

router.post('/roles/:id/clone', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const role = await rbac.cloneRole(req.params.id, req.body.name);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_CLONED', `"${req.params.id}" থেকে ক্লোন করে নতুন Role: ${role.name}`, req.ip);
    req.flash('success', req.t('admin_role_cloned').replace('{value}', role.name));
    res.redirect(`/admin/roles/${role.id}/edit`);
  } catch (err) {
    console.error('role management error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_request_failed_db')));
    res.redirect('/admin/roles');
  }
});

router.post('/roles/:id/delete', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const role = await rbac.getRole(req.params.id);
    await rbac.deleteRole(req.params.id);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_DELETED', `Role ডিলিট করা হয়েছে: ${role ? role.name : req.params.id}`, req.ip);
    req.flash('success', req.t('admin_role_deleted'));
    res.redirect('/admin/roles');
  } catch (err) {
    console.error('role management error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_request_failed_db')));
    res.redirect('/admin/roles');
  }
});

router.post('/roles/bulk-permission-update', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const roleIds = [].concat(req.body.role_ids || []);
    const permKey = req.body.perm_key;
    const value = req.body.perm_value === 'true';
    if (!roleIds.length || !rbac.PERMISSIONS[permKey]) { req.flash('error', req.t('admin_select_role_and_permission')); return res.redirect('/admin/roles/matrix'); }
    const updated = await rbac.bulkUpdatePermission(roleIds, permKey, value);
    await logAdminAction(req.session.user.id, req.session.user.username, 'PERMISSION_CHANGED', `বাল্ক আপডেট — "${permKey}" = ${value} এই Role-গুলোতে: ${updated.join(', ')}`, req.ip);
    req.flash('success', req.t('admin_roles_updated_count').replace('{value}', updated.length));
    res.redirect('/admin/roles/matrix');
  } catch (err) {
    console.error('role bulk permission update error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_bulk_update_failed')));
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
    console.error('role management error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_request_failed_db')));
    res.redirect('/admin/roles');
  }
});

router.post('/roles/import', rbac.requirePermission('roles_manage'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error(req.t('admin_select_json_file'));
    const data = JSON.parse(req.file.buffer.toString('utf8'));
    const result = await rbac.importRoles(data);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLES_IMPORTED', `Import: ${result.created} তৈরি, ${result.updated} আপডেট, ${result.skipped} স্কিপ`, req.ip);
    req.flash('success', req.t('admin_import_done').replace('{value1}', result.created).replace('{value2}', result.updated).replace('{value3}', result.skipped));
    res.redirect('/admin/roles');
  } catch (err) {
    // JSON.parse / pg এরর মেসেজে ফাইল পাথ ও ইন্টারনাল বিবরণ আসতে পারে — শুধু ইচ্ছাকৃত
    // ভ্যালিডেশন বার্তাগুলোই (PublicError) অ্যাডমিনকে দেখানো হয়।
    console.error('roles import error:', err && err.stack ? err.stack : err);
    req.flash('error', req.t('admin_import_failed_prefix') + publicMessage(err, req.t('admin_file_unreadable')));
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
    res.render('admin/user-roles', { loadError: true, users: [], roles: [], search: '' });
  }
});

router.post('/user-roles/:userId/assign', rbac.requirePermission('roles_manage'), async (req, res) => {
  try {
    const userRes = await pool.query('SELECT username FROM users WHERE id=$1', [req.params.userId]);
    if (!userRes.rows[0]) { req.flash('error', req.t('admin_user_not_found_dot')); return res.redirect('/admin/user-roles'); }
    const requestedRoleKey = req.body.role_key || null;
    // role_key=NULL বা 'super_admin' বসানো মানে (getUserPermissions()-এ) টার্গেট পূর্ণ
    // super_admin-সমতুল্য অ্যাক্সেস পেয়ে যাওয়া — এই রুট আগে শুধু requirePermission('roles_manage')
    // দিয়ে গার্ড করা ছিল, অর্থাৎ শুধু roles_manage পাওয়া একজন সীমিত অ্যাডমিনও নিজেকে (বা যেকোনো
    // অ্যাডমিনকে) এভাবে সরাসরি super_admin বানিয়ে নিতে পারতেন। তাই শুধু এই নির্দিষ্ট
    // super-admin-grant করা assignment-এর জন্য caller-কেই আগে থেকে super_admin হতে হবে —
    // সীমিত/কাস্টম role এসাইন করা (roles_manage-এর আসল উদ্দেশ্য) আগের মতোই অপরিবর্তিত থাকে।
    if (requestedRoleKey === null || requestedRoleKey === 'super_admin') {
      const { isSuperAdmin } = await rbac.getUserPermissions(req.session.user.id);
      if (!isSuperAdmin) {
        req.flash('error', req.t('admin_only_super_admin_can_grant'));
        return res.redirect('/admin/user-roles');
      }
    }
    await rbac.assignUserRole(req.params.userId, requestedRoleKey);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ROLE_CHANGED',
      `"${userRes.rows[0].username}"-কে Role দেওয়া হয়েছে: ${requestedRoleKey || '(কোনোটা না — সুপার-অ্যাডমিন-সমতুল্য)'}`, req.ip);
    req.flash('success', req.t('admin_user_role_updated'));
    res.redirect('/admin/user-roles');
  } catch (err) {
    console.error('user role assign error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_user_role_update_failed')));
    res.redirect('/admin/user-roles');
  }
});

router.get('/bot-monitoring/ip-rules', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  try {
    const rules = await listIpRules();
    res.render('admin/bot-ip-rules', { user: req.session.user, rules });
  } catch (err) {
    console.error('ip-rules list error:', err.message);
    res.render('admin/bot-ip-rules', { loadError: true, user: req.session.user, rules: [] });
  }
});

router.post('/bot-monitoring/ip-rules', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  const { ip, type, reason } = req.body;
  try {
    if (!ip || !['block', 'whitelist'].includes(type)) {
      req.flash('error', req.t('admin_valid_ip_and_type'));
      return res.redirect('/admin/bot-monitoring/ip-rules');
    }
    await setIpRule(ip.trim(), type, sanitizeText(reason || ''), req.session.user.username);
    await logAdminAction(req.session.user.id, req.session.user.username, type === 'block' ? 'IP_BLOCKED' : 'IP_WHITELISTED', `IP: ${ip} — কারণ: ${reason || '-'}`, req.ip);
    req.flash('success', req.t('admin_ip_rule_added').replace('{value1}', ip).replace('{value2}', req.t(type === 'block' ? 'admin_word_blocked' : 'admin_word_whitelisted')));
    res.redirect('/admin/bot-monitoring/ip-rules');
  } catch (err) {
    console.error('ip-rules add error:', err.message);
    req.flash('error', req.t('common_something_went_wrong'));
    res.redirect('/admin/bot-monitoring/ip-rules');
  }
});

router.post('/bot-monitoring/ip-rules/:ip/remove', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  try {
    const ip = decodeURIComponent(req.params.ip);
    await removeIpRule(ip);
    await logAdminAction(req.session.user.id, req.session.user.username, 'IP_RULE_REMOVED', `IP: ${ip}`, req.ip);
    req.flash('success', req.t('admin_ip_rule_removed').replace('{value}', ip));
    res.redirect('/admin/bot-monitoring/ip-rules');
  } catch (err) {
    console.error('ip-rules remove error:', err.message);
    req.flash('error', req.t('common_something_went_wrong'));
    res.redirect('/admin/bot-monitoring/ip-rules');
  }
});

router.get('/activity', rbac.requirePermission('activity_log_view'), async (req, res) => {
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
    res.render('admin/activity', { loadError: true, logs: [], actionTypes: [], filters: { action_type: '', q: '' } });
  }
});

// ==================== System Diagnostics / Health Check ====================
// GET /system-diagnostics-এর নিজস্ব হ্যান্ডলার এখানে ইচ্ছাকৃতভাবে নেই — app.js-এ
// routes/adminHealthFix.js এই একই পাথ (/admin/system-diagnostics) admin.js-এর
// আগে মাউন্ট হয়, তাই এখানে থাকা একটা কপি Express-এ কখনো রিচ হতো না (dead code)।
// আসল/একমাত্র অ্যাক্টিভ হ্যান্ডলার: routes/adminHealthFix.js
// GET /api/system-diagnostics-এর হ্যান্ডলারও এখানে ইচ্ছাকৃতভাবে নেই — একই কারণে।
// আগে এখানে একটা কপি ছিল যেটা Express-এ কখনো রিচ হতো না (adminHealthFix আগে মাউন্ট),
// অর্থাৎ dead code। সেটা সরানো হয়েছে যাতে ভবিষ্যতে কেউ ভুল কপিটা সম্পাদনা না করে।

// ==================== Sentry মনিটরিং স্ট্যাটাস ও কনফিগারেশন ====================
router.get('/sentry-status', async (req, res) => {
  try {
    const sentryService = require('../services/sentry');
    res.render('admin/sentry-status', { status: sentryService.getStatus(), error: null, testSent: req.query.test === '1' });
  } catch (err) {
    console.error('Sentry status page error:', err.message);
    res.render('admin/sentry-status', { loadError: true, status: null, error: req.t('admin_sentry_status_failed'), testSent: false });
  }
});

router.post('/sentry-status/test-error', async (req, res) => {
  try {
    const sentryService = require('../services/sentry');
    if (!sentryService.isEnabled()) {
      req.flash('error', req.t('admin_sentry_disabled'));
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
    req.flash('error', req.t('admin_sentry_test_failed'));
    res.redirect('/admin/sentry-status');
  }
});

// ==================== Notification Template Management ====================
const templates = require('../services/templates');
const { sendSms } = require('../services/sms');

router.get('/notification-templates', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const { channel = '', lang = '', q = '' } = req.query;
    const list = await templates.listTemplates({ channel, lang, q });
    res.render('admin/notification-templates', { list, filters: { channel, lang, q }, error: null, success: null });
  } catch (err) {
    console.error('notification-templates list error:', err.message);
    res.render('admin/notification-templates', { loadError: true, list: [], filters: { channel: '', lang: '', q: '' }, error: req.t('admin_templates_load_failed'), success: null });
  }
});

router.get('/notification-templates/new', rbac.requirePermission('settings_edit'), (req, res) => {
  res.render('admin/notification-template-form', { tmpl: null, error: null });
});

router.post('/notification-templates', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const { template_key, channel, lang, name, subject, body, is_active } = req.body;
    const tmpl = await templates.createTemplate(
      { template_key, channel, lang, name, subject, body, is_active: is_active === 'on' || is_active === 'true' },
      req.session.user.id, req.session.user.username
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'TEMPLATE_CREATE',
      `নতুন নোটিফিকেশন টেমপ্লেট তৈরি: ${tmpl.template_key} (${tmpl.channel}/${tmpl.lang})`, req.ip);
    req.flash && req.flash('success', req.t('admin_template_created'));
    res.redirect('/admin/notification-templates');
  } catch (err) {
    console.error('template create error:', err && err.stack ? err.stack : err);
    res.render('admin/notification-template-form', { tmpl: req.body, error: publicMessage(err, req.t('admin_template_create_failed')) });
  }
});

router.get('/notification-templates/:id/edit', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const tmpl = await templates.getTemplateById(req.params.id);
    if (!tmpl) return res.redirect('/admin/notification-templates');
    res.render('admin/notification-template-form', { tmpl, error: null });
  } catch (err) {
    res.redirect('/admin/notification-templates');
  }
});

router.post('/notification-templates/:id', rbac.requirePermission('settings_edit'), async (req, res) => {
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
    console.error('template update error:', err && err.stack ? err.stack : err);
    const existing = await templates.getTemplateById(req.params.id).catch(() => null);
    res.render('admin/notification-template-form', { tmpl: existing || { id: req.params.id, ...req.body }, error: publicMessage(err, req.t('admin_template_update_failed')) });
  }
});

router.post('/notification-templates/:id/delete', rbac.requirePermission('settings_edit'), async (req, res) => {
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
router.post('/notification-templates/:id/preview', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const tmpl = await templates.getTemplateById(req.params.id);
    if (!tmpl) return res.status(404).json({ success: false, error: req.t('admin_template_not_found') });

    const sampleVars = {};
    (tmpl.variables || []).forEach(v => {
      const samples = { name: req.t('admin_template_preview_sample_name'), otp: '123456', amount: '৫,০০০', username: 'demo_user', date: new Date().toLocaleDateString('bn-BD') };
      sampleVars[v] = samples[v] || `[${v}]`;
    });
    const rendered = templates.renderTemplateRow(tmpl, { ...sampleVars, ...(req.body.variables || {}) });
    res.json({ success: true, subject: rendered.subject, body: rendered.body, sampleVars });
  } catch (err) {
    console.error('template preview error:', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, error: req.t('admin_preview_failed') });
  }
});

// টেস্ট সেন্ড — অ্যাডমিন নিজের ইমেইল/নম্বরে পাঠিয়ে দেখতে পারবে
router.post('/notification-templates/:id/test-send', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const tmpl = await templates.getTemplateById(req.params.id);
    if (!tmpl) return res.status(404).json({ success: false, error: req.t('admin_template_not_found') });

    const target = (req.body.target || '').trim();
    if (!target) return res.status(400).json({ success: false, error: req.t('admin_test_target_required') });

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
        tls: { rejectUnauthorized: false },
        // services/email.js-এর মূল transporter-এ যে কারণে এই timeout তিনটা আছে (অনেক হোস্টিং
        // প্রোভাইডার আউটবাউন্ড SMTP পোর্ট ব্লক করে দেয়, timeout ছাড়া ৬০-১২০+ সেকেন্ড ঝুলে থাকে)
        // — এই আলাদা টেস্ট-সেন্ড transporter-এও একই কারণ প্রযোজ্য।
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000
      });
      await transporter.sendMail({
        from: `"LIVO (Test)" <${process.env.EMAIL_USER}>`,
        to: target,
        subject: `[TEST] ${rendered.subject || tmpl.name}`,
        html: rendered.body
      });
      result = { ok: true, message: req.t('admin_test_email_sent').replace('{value}', target) };
    } else if (tmpl.channel === 'sms') {
      result = await sendSms(target, rendered.body);
    } else {
      // in_app — সরাসরি notifications টেবিলে ইনসার্ট করা যায়, target হবে user id
      const userId = parseInt(target, 10);
      if (!userId) return res.status(400).json({ success: false, error: req.t('admin_test_valid_user_id') });
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
        [userId, `[TEST] ${tmpl.name}`, rendered.body]
      );
      result = { ok: true, message: req.t('admin_test_notification_sent_user').replace('{value}', userId) };
    }

    await logAdminAction(req.session.user.id, req.session.user.username, 'TEMPLATE_TEST_SEND',
      `টেমপ্লেট টেস্ট-সেন্ড: ${tmpl.template_key} (${tmpl.channel}/${tmpl.lang}) → ${target}`, req.ip);

    // রিগ্রেশন: আগে success সবসময় hardcoded true থাকত, ফলে sendSms() ভেতরে ব্যর্থ হয়ে
    // { ok: false, message: '...' } রিটার্ন করলেও (services/sms.js কখনো throw করে না) এখানে
    // success:true স্প্রেড হয়ে যেত — অ্যাডমিন UI (data.success দেখেই) একটা আসল গেটওয়ে
    // ব্যর্থতাকে সবুজ "পাঠানো হয়েছে" হিসেবে দেখাত। এখন success আসল result.ok থেকে আসে।
    res.json({ ...result, success: !!result.ok });
  } catch (err) {
    // SMTP/SMS এরর মেসেজে হোস্ট, পোর্ট, ক্রেডেনশিয়াল-সংক্রান্ত ইঙ্গিত থাকতে পারে।
    console.error('template test-send error:', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, error: req.t('admin_test_send_failed') });
  }
});

// ==================== ফ্রড লগ (Fraud Detection) ====================
// ==================== Fraud Monitoring Dashboard — Risk Score, Trend, Top Signals/Users ====================
router.get('/fraud-monitoring', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  try {
    const dashStats = await getFraudDashboardStats();
    res.render('admin/fraud-monitoring', { dashStats });
  } catch (err) {
    console.error('Fraud monitoring dashboard error:', err.message);
    res.render('admin/fraud-monitoring', { loadError: true,
      dashStats: {
        riskByLevel: { high: 0, medium: 0, low: 0 },
        statusCounts: { open: 0, reviewed: 0, dismissed: 0 },
        topSignals: [], topUsers: [], trend: [], avgOpenRiskScore: 0
      }
    });
  }
});

router.get('/fraud-logs', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  try {
    const { risk_level = '', status = '', user_id = '', from = '', to = '' } = req.query;
    const page = clampPage(req.query.page);
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
    res.render('admin/fraud-logs', { loadError: true,
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { risk_level: '', status: '', user_id: '', from: '', to: '' }
    });
  }
});

router.post('/fraud-logs/:id/review', rbac.requirePermission('bot_monitoring_manage'), requireIntParam('id'), async (req, res) => {
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
    req.flash('success', req.t('admin_fraud_flag_updated'));
  } catch (err) {
    console.error('Fraud flag review error:', err.message);
    req.flash('error', req.t('admin_something_went_wrong_x'));
  }
  redirectBack(req, res, '/admin');
});

// ==================== Duplicate Account Detection ====================
router.get('/duplicate-accounts', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  try {
    const { status = '', min_score = '', user_id = '' } = req.query;
    const page = clampPage(req.query.page);
    const result = await listDuplicateFlags({ status, minScore: min_score, userId: user_id, page, limit: 25 });
    res.render('admin/duplicate-accounts', {
      logs: result.logs, page: result.page, totalPages: result.totalPages, total: result.total,
      filters: { status, min_score, user_id }
    });
  } catch (err) {
    console.error('Duplicate accounts list error:', err.message);
    res.render('admin/duplicate-accounts', { loadError: true,
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { status: '', min_score: '', user_id: '' }
    });
  }
});

router.post('/duplicate-accounts/:id/review', rbac.requirePermission('bot_monitoring_manage'), requireIntParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const action = req.body.action === 'dismiss' ? 'dismissed' : 'reviewed';
    await reviewDuplicateFlag(id, action, req.session.user.id, req.session.user.username, req.ip);
    req.flash('success', req.t('admin_duplicate_flag_updated'));
  } catch (err) {
    console.error('Duplicate flag review error:', err.message);
    req.flash('error', req.t('admin_something_went_wrong_x'));
  }
  redirectBack(req, res, '/admin');
});

router.post('/duplicate-accounts/scan', rbac.requirePermission('bot_monitoring_manage'), async (req, res) => {
  try {
    const count = await scanAllUsers();
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'DUPLICATE_ACCOUNT_SCAN_RUN',
      `ম্যানুয়াল স্ক্যান চালানো হয়েছে — ${count}টি নতুন ফ্ল্যাগ তৈরি হয়েছে`, req.ip
    );
    req.flash('success', req.t('admin_scan_complete').replace('{value}', count));
  } catch (err) {
    console.error('Duplicate account scan error:', err.message);
    req.flash('error', req.t('admin_scan_failed'));
  }
  res.redirect('/admin/duplicate-accounts');
});


router.get('/reports', rbac.requirePermission('reports_view'), async (req, res) => {
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
    res.render('admin/reports', { loadError: true,
      from: '', to: '',
      deposits: { total: 0, cnt: 0 }, withdrawals: { total: 0, cnt: 0 },
      bets: { total_stake: 0, cnt: 0, total_payout: 0 }, newUsers: 0, netRevenue: 0,
      ggrTrend: [], userTrend: []
    });
  }
});

// ==================== Background Queue System ড্যাশবোর্ড (BullMQ + Redis) ====================
// এই তিনটে read এন্ডপয়েন্টে requirePermission ছিল না, অথচ নিচের সব queue mutation রুট
// 'cron_jobs_manage' চায়। ফলে সীমিত-অনুমতির স্টাফ অ্যাকাউন্ট (support/finance ইত্যাদি)
// dead-letter জবের পে-লোড, ব্যর্থ জবের বিবরণ ও Redis হেলথ দেখে ফেলতে পারত। mutation
// রুটগুলোর সাথে মিলিয়ে একই permission-এ আনা হলো (isAdmin গেট আগের মতোই অপরিবর্তিত)।
router.get('/queues', rbac.requirePermission('cron_jobs_manage'), async (req, res) => {
  try {
    const { getQueueHealthStats } = require('../queues');
    const health = await getQueueHealthStats();

    const dlqRes = await pool.query(
      `SELECT * FROM queue_dead_letter WHERE status = 'dead' ORDER BY created_at DESC LIMIT 100`
    );

    res.render('admin/queues', { health, deadLetterJobs: dlqRes.rows });
  } catch (err) {
    console.error('Queue dashboard error:', err && err.stack ? err.stack : err);
    res.render('admin/queues', { loadError: true, health: { redisConnected: false, queues: [] }, deadLetterJobs: [] });
  }
});

// লাইভ স্ট্যাটাস পোলিং-এর জন্য JSON এন্ডপয়েন্ট (ড্যাশবোর্ড প্রতি কয়েক সেকেন্ডে রিফ্রেশ করে)
router.get('/queues/api/stats', rbac.requirePermission('cron_jobs_manage'), async (req, res) => {
  try {
    const { getQueueHealthStats } = require('../queues');
    const health = await getQueueHealthStats();
    res.json({ success: true, health });
  } catch (err) {
    // Redis/BullMQ এররে হোস্ট, পোর্ট ও কানেকশন বিবরণ থাকে — ব্রাউজারে পাঠানো হয় না।
    console.error('queue stats API error:', err && err.stack ? err.stack : err);
    res.json({ success: false, error: req.t('admin_queue_status_failed') });
  }
});

// নির্দিষ্ট Queue-এর একটা state (waiting/active/failed ইত্যাদি)-এর জব লিস্ট
router.get('/queues/api/jobs/:queueName', rbac.requirePermission('cron_jobs_manage'), async (req, res) => {
  try {
    const { getRecentJobs } = require('../queues');
    const state = req.query.state || 'failed';
    const jobs = await getRecentJobs(req.params.queueName, state, 30);
    res.json({ success: true, jobs });
  } catch (err) {
    console.error('queue jobs API error:', err && err.stack ? err.stack : err);
    res.json({ success: false, error: req.t('admin_jobs_load_failed') });
  }
});

// Dead-letter জব রিট্রাই (আবার মূল Queue-তে পাঠানো)
router.post('/queues/dead-letter/:id/retry', rbac.requirePermission('cron_jobs_manage'), requireIntParam('id'), async (req, res) => {
  try {
    const { retryDeadLetterJob } = require('../queues');
    await retryDeadLetterJob(req.params.id);
    await logAdminAction(req.session.user.id, req.session.user.username, 'QUEUE_DLQ_RETRY',
      `Dead-letter job #${req.params.id} রিট্রাই করা হয়েছে`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'QUEUE_DLQ_RETRIED', category: 'queue', status: 'success', riskLevel: 'medium',
      details: { jobId: req.params.id }
    }).catch(e => console.error('logAuditEvent (QUEUE_DLQ_RETRIED) error:', e.message));
    res.json({ success: true });
  } catch (err) {
    console.error('queue DLQ retry error:', err && err.stack ? err.stack : err);
    res.json({ success: false, error: req.t('admin_job_retry_failed') });
  }
});

// Dead-letter জব ডিলিট
router.post('/queues/dead-letter/:id/delete', rbac.requirePermission('cron_jobs_manage'), requireIntParam('id'), async (req, res) => {
  try {
    const { deleteDeadLetterJob } = require('../queues');
    await deleteDeadLetterJob(req.params.id);
    await logAdminAction(req.session.user.id, req.session.user.username, 'QUEUE_DLQ_DELETE',
      `Dead-letter job #${req.params.id} মুছে ফেলা হয়েছে`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'QUEUE_DLQ_DELETED', category: 'queue', status: 'success', riskLevel: 'medium',
      details: { jobId: req.params.id }
    }).catch(e => console.error('logAuditEvent (QUEUE_DLQ_DELETED) error:', e.message));
    res.json({ success: true });
  } catch (err) {
    console.error('queue DLQ delete error:', err && err.stack ? err.stack : err);
    res.json({ success: false, error: req.t('admin_job_delete_failed') });
  }
});

// ম্যানুয়ালি একটা Fraud Scan ট্রিগার করা (টেস্টিং/অ্যাডহক ব্যবহারের জন্য)
router.post('/queues/fraud-scan/:userId', rbac.requirePermission('cron_jobs_manage'), requireIntParam('userId'), async (req, res) => {
  try {
    const { enqueueFraudScan } = require('../queues');
    const result = await enqueueFraudScan({ userId: parseInt(req.params.userId, 10), triggeredBy: 'admin' });
    await logAdminAction(req.session.user.id, req.session.user.username, 'QUEUE_FRAUD_SCAN_TRIGGERED',
      `ইউজার #${req.params.userId}-এর জন্য ম্যানুয়ালি fraud scan ট্রিগার করা হয়েছে`, req.ip);
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'QUEUE_FRAUD_SCAN_TRIGGERED', category: 'queue', status: 'success', riskLevel: 'low',
      details: { targetUserId: req.params.userId }
    }).catch(e => console.error('logAuditEvent (QUEUE_FRAUD_SCAN_TRIGGERED) error:', e.message));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('queue fraud-scan enqueue error:', err && err.stack ? err.stack : err);
    res.json({ success: false, error: req.t('admin_fraud_scan_trigger_failed') });
  }
});

// ==================== LOGIN HISTORY (সব ইউজারের, সার্চ/ফিল্টার সহ) ====================
router.get('/login-history', rbac.requirePermission('activity_log_view'), async (req, res) => {
  try {
    const { q = '', new_device = '', from = '', to = '' } = req.query;
    const page = clampPage(req.query.page);
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

    const logs = result.rows.map(row => ({ ...row, ...parseUserAgent(row.user_agent) }));

    res.render('admin/login-history', {
      logs, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)),
      filters: { q, new_device, from, to }
    });
  } catch (err) {
    console.error('Login history error:', err && err.stack ? err.stack : err);
    res.render('admin/login-history', { loadError: true,
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

router.get('/api-keys', rbac.requirePermission('settings_view'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT k.*, u.username AS created_by_username
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
       ORDER BY k.created_at DESC`
    );
    res.render('admin/api-keys', { keys: result.rows, newKey: null });
  } catch (err) {
    console.error('API keys list error:', err.message);
    res.render('admin/api-keys', { loadError: true, keys: [], newKey: null });
  }
});

router.post('/api-keys/create', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const name = sanitizeText(req.body.name || '').slice(0, 100);
    const description = sanitizeText(req.body.description || '').slice(0, 500);
    const scopesInput = Array.isArray(req.body.scopes) ? req.body.scopes : (req.body.scopes ? [req.body.scopes] : []);
    const allowedScopes = ['read:matches', 'read:leaderboard', 'read:tournaments'];
    const scopes = scopesInput.filter(s => allowedScopes.includes(s));
    const expiresInDays = parseInt(req.body.expires_in_days) || null;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null;

    if (!name) {
      req.flash('error', req.t('admin_key_name_required'));
      return res.redirect('/admin/api-keys');
    }
    if (!scopes.length) {
      req.flash('error', req.t('admin_scope_required'));
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
    req.flash('error', req.t('admin_api_key_create_failed'));
    res.redirect('/admin/api-keys');
  }
});

router.post('/api-keys/:id/toggle', rbac.requirePermission('settings_edit'), requireIntParam('id'), async (req, res) => {
  try {
    const r = await pool.query(`UPDATE api_keys SET enabled = NOT enabled WHERE id = $1 RETURNING name, enabled`, [req.params.id]);
    if (r.rows[0]) {
      await logAdminAction(req.session.user.id, req.session.user.username, 'API_KEY_TOGGLED',
        `API key "${r.rows[0].name}" ${r.rows[0].enabled ? 'চালু' : 'বন্ধ'} করা হয়েছে`, req.ip);
      logAuditEvent({
        req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
        action: 'API_KEY_TOGGLED', category: 'api', status: 'success', riskLevel: 'medium',
        details: { keyId: req.params.id, name: r.rows[0].name, enabled: r.rows[0].enabled }
      }).catch(e => console.error('logAuditEvent (API_KEY_TOGGLED) error:', e.message));
      req.flash('success', req.t('admin_api_key_toggled').replace('{value}', req.t(r.rows[0].enabled ? 'admin_word_enabled' : 'admin_word_disabled')));
    }
  } catch (err) {
    console.error('API key toggle error:', err.message);
    req.flash('error', req.t('common_something_went_wrong'));
  }
  res.redirect('/admin/api-keys');
});

router.post('/api-keys/:id/revoke', rbac.requirePermission('settings_edit'), requireIntParam('id'), async (req, res) => {
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
      req.flash('success', req.t('admin_api_key_revoked'));
    }
  } catch (err) {
    console.error('API key revoke error:', err.message);
    req.flash('error', req.t('common_something_went_wrong'));
  }
  res.redirect('/admin/api-keys');
});

// ==================== API USAGE লগ ও অ্যানালিটিক্স ====================
router.get('/api-logs', rbac.requirePermission('reports_view'), async (req, res) => {
  try {
    const { endpoint = '', method = '', status = '', ip = '', api_key_id = '', from = '', to = '' } = req.query;
    const page = clampPage(req.query.page);
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
    res.render('admin/api-logs', { loadError: true,
      logs: [], page: 1, totalPages: 1, total: 0,
      filters: { endpoint: '', method: '', status: '', ip: '', api_key_id: '', from: '', to: '' },
      analytics: { total_requests: 0, success_count: 0, error_count: 0, avg_response_ms: 0, max_response_ms: 0 },
      topKeys: [], apiKeys: []
    });
  }
});

router.get('/api-logs/export.csv', rbac.requirePermission('reports_view'), async (req, res) => {
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
    res.render('admin/cache', { loadError: true,
      cacheStats: { enabled: false, connected: false, totalKeys: 0, categories: [], hits: 0, misses: 0, hitRatePercent: null, memoryUsed: null },
      cleared: ''
    });
  }
});

router.post('/cache/clear', rbac.requirePermission('cron_jobs_manage'), async (req, res) => {
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

router.get('/backups', rbac.requirePermission('backups_manage'), async (req, res) => {
  try {
    const { type = '' } = req.query;
    const backups = await backupManager.listBackups({ type, limit: 100 });
    res.render('admin/backups', {
      backups, filterType: type,
      encryptionEnabled: backupManager.isEncryptionEnabled(),
      created: req.query.created || '', restored: req.query.restored || '',
      skipped: req.query.skipped || '', error: adminErrorMessage(req.query.error)
    });
  } catch (err) {
    console.error('Backups page error:', err && err.stack ? err.stack : err);
    res.render('admin/backups', { loadError: true, backups: [], filterType: '', encryptionEnabled: false, created: '', restored: '', skipped: '', error: adminErrorMessage('load_failed') });
  }
});

router.post('/backups/create', rbac.requirePermission('backups_manage'), async (req, res) => {
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

router.get('/backups/:id/download', rbac.requirePermission('backups_manage'), async (req, res) => {
  try {
    const record = await backupManager.getBackupById(req.params.id);
    if (!record || record.status !== 'completed') return res.status(404).send(req.t('admin_backup_not_found'));
    const filePath = backupManager.getBackupFilePath(record);
    await logAdminAction(req.session.user.id, req.session.user.username, 'BACKUP_DOWNLOADED', `${record.type} ব্যাকআপ ডাউনলোড হয়েছে (${record.filename})`, req.ip);
    res.download(filePath, record.filename);
  } catch (err) {
    console.error('Backup download error:', err && err.stack ? err.stack : err);
    res.status(500).send(req.t('admin_download_failed'));
  }
});

router.post('/backups/:id/restore', rbac.requirePermission('backups_manage'), async (req, res) => {
  try {
    const record = await backupManager.getBackupById(req.params.id);
    if (!record) return res.redirect('/admin/backups?error=not_found');
    const result = await backupManager.restoreBackup(record);

    // restoreDatabaseBackup() FK/কনস্ট্রেইন্টে ব্যর্থ হওয়া সারিগুলো result._skipped-এ গোনে।
    // আগে সেই গুনতিটা শুধু অডিট লগে যেত আর অ্যাডমিন পেজে নিঃশর্তভাবে "রিস্টোর সম্পন্ন হয়েছে"
    // দেখানো হতো — অর্থাৎ আংশিক (ডেটা-হারানো) রিস্টোর পুরোপুরি সফল বলে রিপোর্ট হতো, যেটা
    // ঠিক করার জন্যই skipped-গণনা যোগ করা হয়েছিল। এখন সেটা ব্যানারেও পৌঁছায়।
    const skipped = (result && result._skipped) || null;
    const skippedRows = skipped ? Object.values(skipped).reduce((a, b) => a + b, 0) : 0;

    await logAdminAction(
      req.session.user.id, req.session.user.username,
      skippedRows > 0 ? 'BACKUP_RESTORE_PARTIAL' : 'BACKUP_RESTORED',
      `${record.type} ব্যাকআপ রিস্টোর করা হয়েছে (${record.filename}) — ${JSON.stringify(result).slice(0, 300)}`,
      req.ip
    );
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: skippedRows > 0 ? 'BACKUP_RESTORE_PARTIAL' : 'BACKUP_RESTORED', category: 'restore',
      status: skippedRows > 0 ? 'failure' : 'success', riskLevel: 'critical',
      details: { backupId: req.params.id, type: record.type, filename: record.filename, skipped }
    }).catch(e => console.error('logAuditEvent (BACKUP_RESTORED) error:', e.message));

    if (skippedRows > 0) {
      // টেবিলের নাম বা pg-এর কারণ URL-এ যায় না — শুধু গুনতি, বাকিটা সার্ভার/অডিট লগে।
      return res.redirect(`/admin/backups?restored=${encodeURIComponent(record.type)}&skipped=${skippedRows}&error=restore_partial`);
    }
    res.redirect(`/admin/backups?restored=${encodeURIComponent(record.type)}`);
  } catch (err) {
    console.error('Backup restore error:', err && err.stack ? err.stack : err);
    await logAdminAction(req.session.user.id, req.session.user.username, 'BACKUP_RESTORE_FAILED', `রিস্টোর ব্যর্থ (#${req.params.id}): ${err.message}`, req.ip).catch(() => {});
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'BACKUP_RESTORE_FAILED', category: 'restore', status: 'failure', riskLevel: 'critical',
      details: { backupId: req.params.id, error: err.message }
    }).catch(e => console.error('logAuditEvent (BACKUP_RESTORE_FAILED) error:', e.message));
    // err.message-এ pg-এর কাঁচা মেসেজ (টেবিল/কলামের নাম, কনস্ট্রেইন্ট, ফাইল পাথ) থাকতে
    // পারে। সেটা রিডাইরেক্ট URL-এ বসালে ব্রাউজার হিস্ট্রি, রেফারার হেডার ও প্রক্সি/অ্যাক্সেস
    // লগে ডেটাবেস internals লিখে যায়। পূর্ণ কারণটা সার্ভার লগ ও অডিট লগেই থাকে।
    res.redirect('/admin/backups?error=restore_failed');
  }
});

router.post('/backups/:id/delete', rbac.requirePermission('backups_manage'), async (req, res) => {
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
router.get('/audit-logs', rbac.requirePermission('activity_log_view'), async (req, res) => {
  try {
    const { q = '', actorType = '', category = '', status = '', riskLevel = '', action = '', from = '', to = '' } = req.query;
    const page = clampPage(req.query.page);
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
    res.render('admin/audit-logs', { loadError: true,
      logs: [], total: 0, page: 1, totalPages: 1,
      filters: { q: '', actorType: '', category: '', status: '', riskLevel: '', action: '', from: '', to: '' },
      categoryCounts: [], riskCounts: { low: 0, medium: 0, high: 0, critical: 0 },
      categories: VALID_CATEGORIES, riskLevels: VALID_RISK_LEVELS
    });
  }
});

// Log Details Modal-এর জন্য — AJAX দিয়ে fetch হয়
router.get('/audit-logs/:id.json', rbac.requirePermission('activity_log_view'), requireIntParam('id'), async (req, res) => {
  try {
    const log = await getAuditLogById(req.params.id);
    if (!log) return res.status(404).json({ error: req.t('admin_not_found') });
    res.json(log);
  } catch (err) {
    console.error('Audit log detail error:', err.message);
    res.status(500).json({ error: req.t('common_server_error_short') });
  }
});

router.get('/audit-logs/export.csv', rbac.requirePermission('activity_log_view'), async (req, res) => {
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

// অ্যাডমিন পেজে ?error=<code> কোডগুলোকে পড়ার মতো বার্তায় রূপান্তর।
// কাঁচা err.message কখনো URL-এ যায় না (ব্রাউজার হিস্ট্রি/রেফারার/প্রক্সি লগে ডেটাবেস
// internals লিখে যেত), তাই রুটগুলো ছোট কোড পাঠায় এবং সেই কোডই এখানে ম্যাপ হয়।
// অচেনা কোড এলে একটা জেনেরিক বার্তা — ইউজার-কন্ট্রোল্ড query string সরাসরি পেজে বসে না।
const ADMIN_ERROR_MESSAGES = {
  load_failed: 'তথ্য লোড করা যায়নি — সার্ভার/ডেটাবেস ত্রুটি।',
  not_found: 'রেকর্ডটি পাওয়া যায়নি।',
  restore_failed: 'রিস্টোর ব্যর্থ হয়েছে — বিস্তারিত সার্ভার লগ ও অডিট লগে আছে।',
  restore_partial: 'রিস্টোর আংশিকভাবে সম্পন্ন হয়েছে — কিছু সারি ঢোকানো যায়নি। এটি সম্পূর্ণ সফল রিস্টোর নয়; বিস্তারিত সার্ভার লগ ও অডিট লগে আছে।',
  create_failed: 'তৈরি করা যায়নি — বিস্তারিত সার্ভার লগে আছে।',
  delete_failed: 'মুছে ফেলা যায়নি — বিস্তারিত সার্ভার লগে আছে।',
  feature_protected: 'সিস্টেম ফিচার ডিলিট করা যায় না — বন্ধ করতে ON/OFF টগল ব্যবহার করুন।'
};
function adminErrorMessage(code) {
  if (!code) return '';
  return ADMIN_ERROR_MESSAGES[code] || 'একটি সমস্যা হয়েছে।';
}

// ==================== FEATURE FLAGS & CONFIGURATION MANAGEMENT ====================
const featureFlags = require('../services/featureFlags');

// Feature Management — কেন্দ্রীয় ON/OFF কনসোল।
// /admin/features হলো প্রাথমিক পাথ; /admin/feature-flags পুরনো বুকমার্ক/লিংকের
// জন্য ব্যাকওয়ার্ড-কম্প্যাটিবল অ্যালিয়াস হিসেবে রাখা হয়েছে।
async function renderFeatureManagement(req, res) {
  try {
    const { groups, flags } = await featureFlags.getManagementView();
    res.render('admin/feature-flags', {
      groups, flags,
      created: req.query.created || '',
      toggled: req.query.toggled || '',
      error: adminErrorMessage(req.query.error)
    });
  } catch (err) {
    console.error('Feature flags page error:', err && err.stack ? err.stack : err);
    res.render('admin/feature-flags', {
      loadError: true, groups: [], flags: [], created: '', toggled: '',
      error: adminErrorMessage('load_failed')
    });
  }
}

router.get('/features', rbac.requirePermission('settings_edit'), renderFeatureManagement);
router.get('/feature-flags', rbac.requirePermission('settings_edit'), renderFeatureManagement);

router.post('/feature-flags/:id/toggle', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM feature_flags WHERE id = $1', [req.params.id]);
    const flag = r.rows[0];
    if (!flag) return res.redirect('/admin/features?error=not_found');
    const newState = !flag.enabled;
    await featureFlags.setFlag(flag.key, newState, req.session.user.id, req.session.user.username);
    // অডিট রেকর্ডে আগের ও নতুন অবস্থা দুটোই রাখা হয় — শুধু "বন্ধ করা হয়েছে"
    // লিখলে পরে জানা যেত না আগে কী ছিল (একই টগল দুইবার চাপলে আলাদা করা যেত না)।
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'FEATURE_FLAG_TOGGLED',
      `"${flag.label}" (${flag.key}): ${flag.enabled ? 'ON' : 'OFF'} → ${newState ? 'ON' : 'OFF'}`, req.ip
    );
    res.redirect('/admin/features?toggled=' + encodeURIComponent(flag.key));
  } catch (err) {
    console.error('Feature flag toggle error:', err && err.stack ? err.stack : err);
    res.redirect('/admin/features?error=toggle_failed');
  }
});

router.post('/feature-flags/create', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const { key, label, category, description } = req.body;
    const created = await featureFlags.createFlag({
      key: (key || '').trim(), label: (label || '').trim(), category, description,
      enabled: false, adminId: req.session.user.id, adminUsername: req.session.user.username
    });
    await logAdminAction(req.session.user.id, req.session.user.username, 'FEATURE_FLAG_CREATED', `নতুন ফ্ল্যাগ তৈরি হয়েছে: "${created.label}" (${created.key}, ${created.category})`, req.ip);
    res.redirect('/admin/features?created=1');
  } catch (err) {
    console.error('Feature flag create error:', err && err.stack ? err.stack : err);
    // উপরের backups রিস্টোরের মতোই — কাঁচা DB এরর URL-এ যায় না।
    res.redirect('/admin/features?error=create_failed');
  }
});

router.post('/feature-flags/:id/delete', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM feature_flags WHERE id = $1', [req.params.id]);
    const flag = r.rows[0];
    await featureFlags.deleteFlag(req.params.id);
    if (flag) await logAdminAction(req.session.user.id, req.session.user.username, 'FEATURE_FLAG_DELETED', `"${flag.label}" (${flag.key}) ডিলিট করা হয়েছে`, req.ip);
    res.redirect('/admin/features');
  } catch (err) {
    console.error('Feature flag delete error:', err && err.stack ? err.stack : err);
    // রেজিস্ট্রি-ম্যানেজড ফিচার ডিলিটের চেষ্টা একটা ইচ্ছাকৃত (PublicError)
    // ভ্যালিডেশন — অ্যাডমিনকে কারণটা জানানো দরকার। তবে বার্তাটা সরাসরি URL-এ
    // না বসিয়ে একটা কোডে ম্যাপ করা হয়: adminErrorMessage() শুধু কোড চেনে, আর
    // কাঁচা টেক্সট query string-এ রিফ্লেক্ট করা ঠিক সেই প্যাটার্ন যেটা
    // tests/security/adminReflectedOutput.test.js আটকায়।
    if (err && err.expose === true) return res.redirect('/admin/features?error=feature_protected');
    res.redirect('/admin/features?error=delete_failed');
  }
});

const fs = require('fs');
const path = require('path');
const { tr } = require('../utils/i18n');
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

router.get('/localization', rbac.requirePermission('settings_edit'), (req, res) => {
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
    res.render('admin/localization', { loadError: true, rows: [], q: '', total: 0, missingCount: 0, saved: false });
  }
});

router.post('/localization/create', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    const bnVal = req.body.bn || '';
    const enVal = req.body.en || '';
    if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) {
      req.flash('error', req.t('admin_key_format'));
      return res.redirect('/admin/localization');
    }
    const bn = readLocale('bn'); const en = readLocale('en');
    bn[key] = bnVal; en[key] = enVal;
    writeLocale('bn', bn); writeLocale('en', en);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_KEY_CREATED', `Key তৈরি: ${key}`, req.ip);
    req.flash('success', req.t('admin_key_created'));
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', req.t('admin_key_create_failed'));
    res.redirect('/admin/localization');
  }
});

router.post('/localization/update', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    const bnVal = req.body.bn || '';
    const enVal = req.body.en || '';
    if (!key) { req.flash('error', req.t('admin_key_not_found')); return res.redirect('/admin/localization'); }
    const bn = readLocale('bn'); const en = readLocale('en');
    bn[key] = bnVal; en[key] = enVal;
    writeLocale('bn', bn); writeLocale('en', en);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_KEY_UPDATED', `Key আপডেট: ${key}`, req.ip);
    req.flash('success', req.t('admin_key_updated'));
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', req.t('admin_key_update_failed'));
    res.redirect('/admin/localization');
  }
});

router.post('/localization/delete', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const key = (req.body.key || '').trim();
    const bn = readLocale('bn'); const en = readLocale('en');
    delete bn[key]; delete en[key];
    writeLocale('bn', bn); writeLocale('en', en);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_KEY_DELETED', `Key ডিলিট: ${key}`, req.ip);
    req.flash('success', req.t('admin_key_deleted'));
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', req.t('admin_key_delete_failed'));
    res.redirect('/admin/localization');
  }
});

router.get('/localization/export/:lang', rbac.requirePermission('settings_edit'), (req, res) => {
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

router.get('/audit-logs/export.xlsx', rbac.requirePermission('activity_log_view'), async (req, res) => {
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

router.post('/localization/import/:lang', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const lang = req.params.lang === 'en' ? 'en' : 'bn';
    let incoming;
    try { incoming = JSON.parse(req.body.json || '{}'); } catch (e) {
      req.flash('error', req.t('admin_invalid_json'));
      return res.redirect('/admin/localization');
    }
    if (typeof incoming !== 'object' || Array.isArray(incoming) || incoming === null) {
      req.flash('error', req.t('admin_json_must_be_object'));
      return res.redirect('/admin/localization');
    }
    const current = readLocale(lang);
    const merged = Object.assign({}, current, incoming);
    writeLocale(lang, merged);
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_IMPORTED', `${lang}.json import (${Object.keys(incoming).length}টি key)`, req.ip);
    req.flash('success', req.t('admin_keys_imported').replace('{value1}', Object.keys(incoming).length).replace('{value2}', lang));
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', req.t('admin_import_failed'));
    res.redirect('/admin/localization');
  }
});

router.post('/localization/refresh-cache', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    refreshCache(req);
    await logAdminAction(req.session.user.id, req.session.user.username, 'LOCALIZATION_CACHE_REFRESHED', 'Translation cache রিফ্রেশ করা হয়েছে', req.ip);
    req.flash('success', req.t('admin_cache_refreshed'));
    res.redirect('/admin/localization');
  } catch (err) {
    req.flash('error', req.t('admin_cache_refresh_failed'));
    res.redirect('/admin/localization');
  }
});

// ==================== Announcement / Broadcast System ====================
router.get('/announcements', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
    res.render('admin/announcements', { list: r.rows, error: req.query.error || '', created: req.query.created === '1' });
  } catch (err) {
    console.error('Announcements list error:', err.message);
    res.render('admin/announcements', { loadError: true, list: [], error: 'load_failed', created: false });
  }
});

router.post('/announcements/create', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const { type, title_bn, title_en, message_bn, message_en, target_type, target_role, target_user_id, starts_at, expires_at } = req.body;
    if (!message_bn || !message_bn.trim()) {
      return res.redirect('/admin/announcements?error=' + encodeURIComponent(req.t('admin_bengali_message_required')));
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
    res.redirect('/admin/announcements?error=' + encodeURIComponent(req.t('admin_create_failed')));
  }
});

router.post('/announcements/:id/update', rbac.requirePermission('settings_edit'), async (req, res) => {
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
    res.redirect('/admin/announcements?error=' + encodeURIComponent(req.t('admin_update_failed')));
  }
});

router.post('/announcements/:id/toggle', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const r = await pool.query('UPDATE announcements SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING active', [req.params.id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ANNOUNCEMENT_TOGGLED', `Announcement #${req.params.id} ${r.rows[0].active ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে`, req.ip);
    res.redirect('/admin/announcements');
  } catch (err) {
    res.redirect('/admin/announcements?error=toggle_failed');
  }
});

router.post('/announcements/:id/expire-now', rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    await pool.query('UPDATE announcements SET expires_at = NOW(), updated_at = NOW() WHERE id = $1', [req.params.id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'ANNOUNCEMENT_EXPIRED', `Announcement #${req.params.id} এখনই expire করা হয়েছে`, req.ip);
    res.redirect('/admin/announcements');
  } catch (err) {
    res.redirect('/admin/announcements?error=expire_failed');
  }
});

router.post('/announcements/:id/delete', rbac.requirePermission('settings_edit'), async (req, res) => {
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
    res.render('admin/diagnostics', { loadError: true,
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
    console.error('diagnostics json error:', err.message);
    res.status(500).json({ overall: 'error', error: req.t('admin_diagnostic_failed') });
  }
});

// ==================== Cron Jobs Monitor (প্রোডাকশন-রেডি Scheduler ম্যানেজমেন্ট) ====================
router.get('/cron-jobs', rbac.requirePermission('cron_jobs_manage'), async (req, res) => {
  try {
    const jobs = await scheduler.listJobs();
    const recentLogs = await scheduler.getRecentLogs(20);
    res.render('admin/cron-jobs', { jobs, recentLogs, active: 'cron-jobs' });
  } catch (err) {
    console.error('Cron jobs list error:', err.message);
    res.render('admin/cron-jobs', { loadError: true, jobs: [], recentLogs: [], active: 'cron-jobs' });
  }
});

// একটা নির্দিষ্ট Job-এর সম্পূর্ণ Execution History
router.get('/cron-jobs/:key/logs', rbac.requirePermission('cron_jobs_manage'), async (req, res) => {
  try {
    const key = req.params.key;
    const logs = await scheduler.getJobLogs(key, 100);
    const jobs = await scheduler.listJobs();
    const job = jobs.find(j => j.key === key) || { key, label: key, description: '' };
    res.render('admin/cron-job-logs', { job, logs, active: 'cron-jobs' });
  } catch (err) {
    console.error('Cron job logs error:', err.message);
    req.flash('error', req.t('admin_job_history_failed'));
    res.redirect('/admin/cron-jobs');
  }
});

// Run Now — ম্যানুয়ালি একটা Job অবিলম্বে ট্রিগার করা (schedule অপেক্ষা না করে)
router.post('/cron-jobs/:key/run', rbac.requirePermission('cron_jobs_manage'), adminActionLimiter, async (req, res) => {
  try {
    const key = req.params.key;
    if (!scheduler.JOB_DEFINITIONS[key]) {
      req.flash('error', req.t('admin_unknown_cron_job').replace('{value}', key));
      return res.redirect('/admin/cron-jobs');
    }
    const result = await scheduler.runJob(key, { triggeredBy: `manual:${req.session.user.username}` });
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'CRON_JOB_RUN_NOW',
      `Cron job "${key}" ম্যানুয়ালি রান করা হয়েছে — status: ${result.status}, duration: ${result.durationMs}ms`,
      req.ip
    );
    req.flash(result.status === 'success' ? 'success' : 'error',
      req.t('admin_cron_job_ran').replace('{value1}', key).replace('{value2}', result.durationMs).replace('{value3}', result.message));
    res.redirect('/admin/cron-jobs');
  } catch (err) {
    console.error('Cron run-now error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_job_run_failed')));
    res.redirect('/admin/cron-jobs');
  }
});

// Enable/Disable — সার্ভার রিস্টার্ট ছাড়াই কার্যকর হয় (প্রতিবার রানের আগে DB থেকে ফ্রেশ চেক হয়)
router.post('/cron-jobs/:key/toggle', rbac.requirePermission('cron_jobs_manage'), adminActionLimiter, async (req, res) => {
  try {
    const key = req.params.key;
    if (!scheduler.JOB_DEFINITIONS[key]) {
      req.flash('error', req.t('admin_unknown_cron_job').replace('{value}', key));
      return res.redirect('/admin/cron-jobs');
    }
    const enabled = req.body.enabled === 'true' || req.body.enabled === '1';
    await scheduler.setEnabled(key, enabled);
    await logAdminAction(
      req.session.user.id, req.session.user.username, 'CRON_JOB_TOGGLE',
      `Cron job "${key}" ${enabled ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে`, req.ip
    );
    req.flash('success', req.t('admin_cron_job_toggled').replace('{value1}', key).replace('{value2}', req.t(enabled ? 'admin_word_active' : 'admin_word_inactive')));
    res.redirect('/admin/cron-jobs');
  } catch (err) {
    console.error('Cron toggle error:', err && err.stack ? err.stack : err);
    req.flash('error', publicMessage(err, req.t('admin_job_toggle_failed')));
    res.redirect('/admin/cron-jobs');
  }
});

// Cron Jobs JSON API (পোলিং — লাইভ লাস্ট-রান স্ট্যাটাসের জন্য)
router.get('/cron-jobs/status/json', rbac.requirePermission('cron_jobs_manage'), async (req, res) => {
  try {
    const jobs = await scheduler.listJobs();
    res.json({ success: true, jobs });
  } catch (err) {
    console.error('Cron status JSON error:', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, message: req.t('admin_cron_status_failed') });
  }
});


// ==================== LOGIN HISTORY (সব ইউজারের, সার্চ/ফিল্টার সহ) ====================

module.exports = router;
