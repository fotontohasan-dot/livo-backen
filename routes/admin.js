const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { grantFreeBet } = require('../services/freebet');
const { syncMatches } = require('../services/matchUpdater');
const { runBackupNow, restoreFromBackup, getBackupStatus } = require('../services/backup');
const { loadSettings } = require('../services/settings');
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

// ==================== ADMIN ACTIVITY LOG HELPER ====================
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
}

// ==================== ADMIN LOGIN ====================
router.get('/login', (req, res) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
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

router.post('/login/2fa', async (req, res) => {
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
    logAdminAction(admin.id, admin.username, 'LOGIN_2FA', '2FA দিয়ে লগইন সম্পন্ন', req.ip);
    res.redirect('/admin');
  } catch (err) {
    console.error('2FA verify error:', err.message);
    res.render('admin/2fa-verify', { error: 'সার্ভার এরর হয়েছে', username: pending.username });
  }
});

// ==================== TEMPORARY: CREATE ADMIN LOGS TABLE ====================
router.get('/create-activity-table', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id),
        admin_username VARCHAR(100),
        action_type VARCHAR(100) NOT NULL,
        details TEXT,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    res.send('✅ Admin Logs টেবিল সফলভাবে তৈরি হয়েছে!');
  } catch (err) {
    console.error(err);
    res.send('❌ সমস্যা হয়েছে: ' + err.message);
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

router.post('/2fa/setup/verify', async (req, res) => {
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
      'UPDATE users SET totp_secret = $1, totp_enabled = true, totp_backup_codes = $2 WHERE id = $3',
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

// ==================== ডায়াগনস্টিক: 2FA স্ট্যাটাস যাচাই ====================
// এটা টেম্পোরারি — সমস্যাটা বোঝার পর সরিয়ে ফেলা উচিত।
// লগইন করা অ্যাডমিন এখানে এসে দেখতে পারবে তার নিজের অ্যাকাউন্টে totp_enabled আসলেই true কিনা,
// এবং সিস্টেমে মোট কতজন admin আছে (একাধিক admin অ্যাকাউন্ট থাকলে ভুল অ্যাকাউন্টে লগইন হচ্ছে কিনা বোঝা যাবে)।
router.get('/2fa/status', async (req, res) => {
  try {
    const me = await pool.query('SELECT id, username, email, role, totp_enabled FROM users WHERE id = $1', [req.session.user.id]);
    const allAdmins = await pool.query(`SELECT id, username, email, totp_enabled FROM users WHERE role = 'admin' ORDER BY id`);
    let html = `<h3>তুমি এখন লগইন করা আছ এই অ্যাকাউন্টে:</h3>
      <pre>${JSON.stringify(me.rows[0], null, 2)}</pre>
      <h3>সিস্টেমের সব admin অ্যাকাউন্ট:</h3>
      <pre>${JSON.stringify(allAdmins.rows, null, 2)}</pre>`;
    res.send(html);
  } catch (err) {
    res.send('এরর: ' + err.message);
  }
});

router.post('/2fa/disable', async (req, res) => {
  try {
    const { password, token } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const admin = result.rows[0];

    const passOk = admin && await bcrypt.compare(password || '', admin.password);
    const codeOk = admin && verifyTotpToken(admin.totp_secret, token);

    if (!passOk || !codeOk) {
      return res.render('admin/2fa-setup', {
        alreadyEnabled: true, qrDataUrl: null, base32: null,
        error: 'পাসওয়ার্ড অথবা 2FA কোড সঠিক নয়'
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
      "UPDATE kyc_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1 RETURNING user_id",
      [id]
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
  'deposit_commission_percent', 'withdraw_commission_percent', 'min_deposit', 'min_withdraw'
];

router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    settings.maintenance_mode = settings.maintenance_mode === 'true';

    const adminsRes = await pool.query(
      "SELECT id, username, email, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC"
    );

    res.render('admin/settings', { settings, admins: adminsRes.rows, saved: req.query.saved === '1' });
  } catch (err) {
    console.error('Settings load error:', err.message);
    res.render('admin/settings', { settings: {}, admins: [], saved: false });
  }
});

router.post('/settings/update', async (req, res) => {
  try {
    for (const key of SETTING_KEYS) {
      if (!(key in req.body)) continue;
      let value = req.body[key];
      if (key === 'maintenance_mode') {
        value = Array.isArray(value) ? value[value.length - 1] : value;
      }
      await pool.query(
        `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value)]
      );
    }
    await loadSettings();
    await logAdminAction(req.session.user.id, req.session.user.username, 'SETTINGS_UPDATE', 'সাইট সেটিংস পরিবর্তন করা হয়েছে', req.ip);
    res.redirect('/admin/settings?saved=1');
  } catch (err) {
    console.error('Settings update error:', err.message);
    res.redirect('/admin/settings');
  }
});

router.post('/settings/admins/promote', async (req, res) => {
  try {
    const { username } = req.body;
    const r = await pool.query("UPDATE users SET role = 'admin' WHERE username = $1 RETURNING id", [username]);
    if (r.rows[0]) {
      await logAdminAction(req.session.user.id, req.session.user.username, 'ADMIN_PROMOTE', `${username} কে অ্যাডমিন করা হয়েছে`, req.ip);
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
    res.redirect('/admin/settings');
  } catch (err) {
    console.error('Admin demote error:', err.message);
    res.redirect('/admin/settings');
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

    const demoStats = await getDemoStats().catch(e => {
      console.error('demo stats error:', e.message);
      return { totalDemo: 0, userHeldDemo: 0, casinoDemoWagered: 0, sportsDemoWagered: 0 };
    });

    res.render('admin/dashboard', {
      demoStats,
      stats: {
        total_users: users.rows[0].count,
        total_coins_in_system: totalCoins.rows[0].total || 0,
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
      suspicious: suspicious.rows
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', {
      demoStats: { totalDemo: 9999999, userHeldDemo: 0, casinoDemoWagered: 0, sportsDemoWagered: 0 },
      stats: {}, revenueTrend: [], userGrowth: [], recentBets: [], recentDeposits: [], recentWithdrawals: [], recentActivity: [], recentMatches: [], recentUsers: [], suspicious: []
    });
  }
});

// ==================== ড্যাশবোর্ড লাইভ স্ট্যাটস (পোলিং API) ====================
router.get('/api/dashboard-stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');

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

router.post('/api/deposits/:id/approve', async (req, res) => {
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
    await creditApprovedDeposit(client, request);
    await client.query('COMMIT');
    await logAdminAction(req.session.user.id, req.session.user.username, 'deposit_approve', `Deposit #${id} approved`, req.ip);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deposit approve error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি: ' + err.message });
  } finally {
    client.release();
  }
});

router.post('/api/deposits/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
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
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error')`,
      [request.user_id, 'ডিপোজিট বাতিল', `আপনার ${request.amount} টাকার ডিপোজিট বাতিল হয়েছে।${reason ? ' কারণ: ' + reason : ''}`]
    );
    await client.query('COMMIT');
    await logAdminAction(req.session.user.id, req.session.user.username, 'deposit_reject', `Deposit #${id} rejected: ${reason || ''}`, req.ip);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deposit reject error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি: ' + err.message });
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

router.post('/api/withdrawals/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { txn } = req.body;
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
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
      [request.user_id, 'উইথড্র অনুমোদন', `আপনার ${request.amount} টাকার উইথড্র সম্পন্ন হয়েছে!${txn ? ' Ref: ' + txn : ''}`]
    );
    await client.query('COMMIT');
    await logAdminAction(req.session.user.id, req.session.user.username, 'withdraw_approve', `Withdrawal #${id} approved`, req.ip);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('withdraw approve error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি: ' + err.message });
  } finally {
    client.release();
  }
});

router.post('/api/withdrawals/:id/reject', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
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
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error')`,
      [request.user_id, 'উইথড্র বাতিল', `আপনার ${request.amount} টাকার উইথড্র বাতিল হয়েছে, কয়েন ফেরত দেওয়া হয়েছে।${reason ? ' কারণ: ' + reason : ''}`]
    );
    await client.query('COMMIT');
    await logAdminAction(req.session.user.id, req.session.user.username, 'withdraw_reject', `Withdrawal #${id} rejected: ${reason || ''}`, req.ip);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('withdraw reject error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি: ' + err.message });
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

router.post('/api/support/:userId/reply', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'মেসেজ লিখুন' });
    await pool.query(
      `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, is_read, created_at) VALUES ($1,$2,$3,true,true,NOW())`,
      [req.session.user.id, userId, message.trim()]
    );
    // ইউজারের পাঠানো মেসেজগুলো রিড হিসেবে মার্ক করা
    await pool.query(`UPDATE chat_messages SET is_read=true WHERE sender_id=$1 AND is_admin=false`, [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('support reply error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি: ' + err.message });
  }
});

router.post('/api/support/:userId/resolve', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    await pool.query(`UPDATE chat_messages SET is_read=true WHERE sender_id=$1 AND is_admin=false`, [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('support resolve error:', err);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি: ' + err.message });
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
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM users ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT id, username, email, phone, coins, total_points, is_banned, created_at FROM users ${where}
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

    res.render('admin/user-detail', { u: user, bets, transactions, payments, sameIp, referralCount, stats });
  } catch (err) {
    console.error('user detail error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
    res.redirect('/admin/users');
  }
});

// ==================== USER ACTIONS ====================
router.post('/users/:id/ban', async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1', [req.params.id]);
    req.flash('success', 'স্ট্যাটাস আপডেট হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/delete', async (req, res) => {
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

router.post('/users/:id/coins/add', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'সঠিক পরিমাণ দিন!'); return res.redirect('back'); }
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_add','অ্যাডমিন কয়েন যোগ')`, [req.params.id, amount]);
    req.flash('success', '✅ কয়েন যোগ হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/coins/remove', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'সঠিক পরিমাণ দিন!'); return res.redirect('back'); }
    await pool.query('UPDATE users SET coins = GREATEST(coins - $1, 0) WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_remove','অ্যাডমিন কয়েন কমানো')`, [req.params.id, -amount]);
    req.flash('success', '✅ কয়েন কমানো হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/freebet', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'সঠিক পরিমাণ দিন!'); return res.redirect('back'); }
    await grantFreeBet(req.params.id, amount, 'admin');
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
    req.flash('success', 'মার্কেট আপডেট হয়েছে!');
    res.redirect(`/admin/markets/${match_id}`);
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); res.redirect('/admin/matches'); }
});

router.post('/markets/:marketId/toggle', async (req, res) => {
  try {
    await pool.query('UPDATE markets SET status = $1 WHERE id = $2', [req.body.status, req.params.marketId]);
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
    for (const bet of bets.rows) {
      if (String(bet.runner) === String(winning_runner)) {
        const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
        await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [payout, bet.user_id]);
        await client.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'bet_win','বেট জয়')`, [bet.user_id, payout]);
        await client.query(`UPDATE bets SET status = 'won' WHERE id = $1`, [bet.id]);
        await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট জয়!',$2,'success')`, [bet.user_id, `আপনি ${payout} কয়েন জিতেছেন!`]);
        winnersCount++;
      } else {
        await client.query(`UPDATE bets SET status = 'lost' WHERE id = $1`, [bet.id]);
      }
    }
    await client.query(`UPDATE markets SET status = 'settled', updated_at = NOW() WHERE id = $1`, [marketId]);
    await settleSelectionsForMarket(client, marketId, winning_runner);
    await client.query('COMMIT');
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
    if (result === 'won') {
      const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [payout, bet.user_id]);
      await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট জিতেছেন!',$2,'success')`, [bet.user_id, `আপনি ৳${payout} জিতেছেন!`]);
    } else {
      await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট ফলাফল',$2,'error')`, [bet.user_id, `আপনার ৳${bet.stake} বেটটি হেরে গেছে।`]);
    }
    await client.query('COMMIT');
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
    const { username, bonus_type, bonus_amount, sports_required, casino_required } = req.body;
    const userRes = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (!userRes.rows[0]) return res.redirect('/admin/bonuses');
    await pool.query(
      `INSERT INTO bonuses (user_id, bonus_type, bonus_amount, sports_required, casino_required, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [userRes.rows[0].id, bonus_type, bonus_amount, sports_required || 0, casino_required || 0]
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
    const { title, image_url, link_url, position } = req.body;
    await pool.query(
      'INSERT INTO promotions (title, image_url, link_url, position, active) VALUES ($1, $2, $3, $4, true)',
      [title || null, image_url, link_url || null, position || 0]
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
    const { title, content, image_url, sport } = req.body;
    await pool.query(
      'INSERT INTO news (title, content, image_url, sport, author_id) VALUES ($1, $2, $3, $4, $5)',
      [title, content || null, image_url || null, sport || null, req.session.user.id]
    );
    await logAdminAction(req.session.user.id, req.session.user.username, 'NEWS_ADD', `নতুন নিউজ যোগ করা হয়েছে: ${title}`, req.ip);
    res.redirect('/admin/news');
  } catch (err) {
    console.error('News add error:', err.message);
    res.redirect('/admin/news');
  }
});

router.post('/news/:id/delete', async (req, res) => {
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

// ==================== অ্যাক্টিভিটি লগ ====================
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

// ==================== রিপোর্টিং ====================
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

module.exports = router;
