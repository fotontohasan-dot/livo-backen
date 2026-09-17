const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
// রেফারেল/শেয়ার লিংক ক্লায়েন্টের Host হেডার থেকে বানানো হয় না —
// utils/publicUrl.js-এর নোট দ্রষ্টব্য (Host header poisoning)।
const { getBaseUrl } = require('../utils/publicUrl');
const { listActiveSessions, revokeAllOtherSessions, revokeDeviceSession, listLoginHistory } = require('../services/deviceTracking');
const { isWeakPin, createPin, updatePin, verifyPin, getPinStatus } = require('../services/withdrawPin');
const { logAdminAction } = require('../services/fraudDetection');
const { createLimiter } = require('../middleware/rateLimitFactory');
const cache = require('../services/cache');

// একটা ইউজার ১ মিনিটে সর্বোচ্চ ১০বার claim করতে পারবে। এটা ছাড়া spin/daily
// reward/red packet endpoints-গুলো শুধু generalLimiter-এর আওতায় পড়ত।
const claimLimiter = createLimiter('claim', {
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.session && req.session.user ? String(req.session.user.id) : req.ip),
  handler: (req, res) => {
    res.status(429).json({ ok: false, success: false, message: req.t('common_rate_limited_soft') });
  }
});

// PIN তৈরি/পরিবর্তন/রিসেট — প্রতি ইউজারে ১৫ মিনিটে সর্বোচ্চ ৬ বার। এটা ছাড়া
// রুটগুলো কেবল generalLimiter-এর ৩০০/১৫মিনিটের আওতায় পড়ত, যা PIN অনুমান
// করার জন্য কার্যত কোনো বাধা নয়।
const accountSecurityLimiter = createLimiter('account_security', {
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: (req) => req.t('common_rate_limited_15m'),
  keyGenerator: (req) => (req.session && req.session.user) ? `u_${req.session.user.id}` : req.ip
});
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// প্রোফাইল ছবি — শুধু image/* মাইমটাইপ, ৩MB পর্যন্ত। memoryStorage ব্যবহার
// করা হচ্ছে (chat.js-এর মতো) যাতে ডিস্কে অস্থায়ী ফাইল না লেখা লাগে, বাফার
// সরাসরি Cloudinary-তে স্ট্রিম হয়।
const AVATAR_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!AVATAR_ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('unsupported_type'));
    }
    cb(null, true);
  }
});
const { getTodayReward, claimDailyReward } = require('../services/dailyReward');
const { getReferralStats } = require('../services/referral');
const { getCashbackStatus, claimCashback } = require('../services/cashback');
const { getVipStatus } = require('../services/vip');
const { getMissions, claimMission } = require('../services/missions');
const { getSegments, canSpin, spin, getHistory: getWheelHistory, getTodayResult } = require('../services/wheel');
const { getLoyalty, redeemPoints } = require('../services/loyalty');
const { getStreak } = require('../services/streak');
const { getBadges } = require('../services/badges');
const { getAllFreeBets, claimFreeBet } = require('../services/freebet');
const { getWeeklyStatus, claimWeekly, getMonthlyStatus, claimMonthly } = require('../services/periodicReward');
const { getShareStatus, claimShare } = require('../services/social');
const { getLeaderboard, getPastContests } = require('../services/contest');
const { getRewardStatus, claimRedPacket, claimGoldenEgg } = require('../services/redpacket');


router.get('/api/balance', isAuth, async (req, res) => {
  try {
    const u = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    res.json({ success: true, coins: Number(u.rows[0]?.coins) || 0 });
  } catch (err) {
    console.error('profile/api/balance error:', err.message);
    res.status(500).json({ error: req.t('profile_balance_load_failed') });
  }
});

// প্রোফাইল ছবি বদলানোর ফিচার আগে সম্পূর্ণ অসম্পূর্ণ ছিল: ফ্রন্টএন্ড
// /profile/update-avatar এ POST করত কিন্তু এই রুটটাই কখনো তৈরি হয়নি,
// তাই ইউজার নতুন ছবি সিলেক্ট করলেও কিছুই হতো না (404)।
const ALLOWED_AVATARS = [
  'https://i.pravatar.cc/300?img=12',
  'https://i.pravatar.cc/300?img=33',
  'https://i.pravatar.cc/300?img=5',
  'https://i.pravatar.cc/300?img=47',
  'https://i.pravatar.cc/300?img=8',
  'https://i.pravatar.cc/300?img=25',
  'https://i.pravatar.cc/300?img=15',
  'https://i.pravatar.cc/300?img=44',
  'https://i.pravatar.cc/300?img=68',
  'https://i.pravatar.cc/300?img=32',
  'https://i.pravatar.cc/300?img=60',
  'https://i.pravatar.cc/300?img=51',
  'https://i.pravatar.cc/300?img=20',
  'https://i.pravatar.cc/300?img=49',
  'https://i.pravatar.cc/300?img=65',
  'https://i.pravatar.cc/300?img=57'
];

router.post('/update-avatar', isAuth, async (req, res) => {
  try {
    const { avatar } = req.body || {};
    // শুধুমাত্র পূর্বনির্ধারিত তালিকার URL গ্রহণযোগ্য — নইলে ইউজার
    // যেকোনো external/malicious URL সেট করতে পারত।
    if (!avatar || !ALLOWED_AVATARS.includes(avatar)) {
      return res.status(400).json({ success: false, error: req.t('profile_avatar_invalid') });
    }
    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [avatar, req.session.user.id]);
    req.session.user.avatar = avatar;
    res.json({ success: true, avatar });
  } catch (err) {
    console.error('profile/update-avatar error:', err.message);
    res.status(500).json({ success: false, error: req.t('profile_avatar_update_failed') });
  }
});

router.get('/', isAuth, async (req, res) => {
  try {
    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);

    // আগে এখানে 'predictions' নামের একটা টেবিল থেকে (predictions/tournaments/stats)
    // ডেটা আনার চেষ্টা হতো, কিন্তু ডাটাবেজে ওই টেবিলটাই নেই (আসল টেবিলের নাম 'bets' —
    // দেখুন routes/api.js-এর একই নোট)। ফলে প্রতিবার /profile লোড করতেই query fail
    // করত, catch ব্লক ধরত, আর ইউজারকে flash এরর সহ হোমে ফেরত পাঠাত। যাচাই করে
    // দেখা গেছে views/profile/index.ejs টেমপ্লেট এই তিনটার একটাও ব্যবহার করে না,
    // তাই মৃত কোড হিসেবে বাদ দেওয়া হলো।
    const baseUrl = getBaseUrl(req);
    res.render('profile/index', {
      user: user.rows[0],
      profileUser: user.rows[0],
      baseUrl
    });
  } catch (err) {
    console.error('Profile error:', err);
    req.flash('error', req.t('profile_load_failed'));
    res.redirect('/');
  }
});

// প্রোফাইল ছবি পরিবর্তন — আগে এই ফিচারটাই কোডবেসে ছিল না (শুধু ইউজারনেমের
// প্রথম অক্ষর দিয়ে অ্যাভাটার দেখানো হতো), তাই "নতুন ছবি সিলেক্ট করা যাচ্ছে না"
// অভিযোগ আসছিল — বাটন/ইনপুট আদৌ ছিল না। এখন multer দিয়ে ফাইল রিসিভ করে
// Cloudinary-তে আপলোড হয় এবং users.avatar কলামে URL সেভ হয়।
router.post('/avatar', isAuth, function (req, res, next) {
  avatarUpload.single('avatar')(req, res, function (err) {
    if (err) {
      req.flash('error', req.t('profile_upload_rejected'));
      return res.redirect('/profile');
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    req.flash('error', req.t('profile_no_image_selected'));
    return res.redirect('/profile');
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'livo/avatars', resource_type: 'image', timeout: 20000, transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }] },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });
    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [result.secure_url, req.session.user.id]);
    req.session.user.avatar = result.secure_url;
    req.flash('success', req.t('profile_avatar_updated'));
    res.redirect('/profile');
  } catch (e) {
    console.error('avatar upload error:', e.message);
    req.flash('error', req.t('profile_upload_failed_retry'));
    res.redirect('/profile');
  }
});

router.post('/update', isAuth, async (req, res) => {
  try {
    const { username } = req.body;
    await pool.query(`UPDATE users SET username=$1 WHERE id=$2`, [username, req.session.user.id]);
    req.session.user.username = username;
    req.flash('success', req.t('profile_updated'));
  } catch (err) {
    req.flash('error', req.t('common_update_failed'));
  }
  res.redirect('/profile');
});

router.post('/update-personal', isAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    await pool.query(`UPDATE users SET full_name=$1, phone=$2 WHERE id=$3`, [full_name, phone, req.session.user.id]);
    req.session.user.full_name = full_name;
    req.session.user.phone = phone;

    req.flash('success', req.t('profile_info_updated'));
  } catch (err) {
    req.flash('error', req.t('common_update_failed_x'));
  }
  res.redirect('/profile/security');
});

router.post('/add-bank-card', isAuth, async (req, res) => {
  try {
    const { bank_name, account_number, holder_name } = req.body;
    await pool.query(
      `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1, $2, $3, $4)`,
      [req.session.user.id, bank_name, account_number, holder_name]
    );
    req.flash('success', req.t('profile_card_added'));
  } catch (err) {
    req.flash('error', req.t('profile_card_add_failed'));
  }
  res.redirect('/profile/security');
});

router.post('/delete-bank-card/:id', isAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM bank_cards WHERE id=$1 AND user_id=$2`, [req.params.id, req.session.user.id]);
    req.flash('success', req.t('profile_card_deleted'));
  } catch (err) {
    req.flash('error', req.t('profile_card_delete_failed'));
  }
  res.redirect('/profile/security');
});

router.post('/change-password', isAuth, async (req, res) => {
  try {
    const { current_password, new_password, currentPassword, newPassword, confirmPassword } = req.body;
    const cp = current_password || currentPassword;
    const np = new_password || newPassword;

    if (confirmPassword && np !== confirmPassword) {
      req.flash('error', req.t('profile_password_mismatch'));
      return res.redirect('/profile/security');
    }
    if (!np || np.length < 8) {
      req.flash('error', req.t('profile_password_min_length'));
      return res.redirect('/profile/security');
    }

    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
    if (!(await bcrypt.compare(cp, user.rows[0].password))) {
      req.flash('error', req.t('profile_current_password_wrong'));
      return res.redirect('/profile/security');
    }
    const hashed = await bcrypt.hash(np, 10);
    await pool.query(`UPDATE users SET password=$1, password_changed_at=NOW() WHERE id=$2`, [hashed, req.session.user.id]);

    // পাসওয়ার্ড বদলানোর আসল নিরাপত্তা-উদ্দেশ্য: চলমান অন্য সেশনগুলো কেটে
    // দেওয়া। নাহলে পাসওয়ার্ড ফাঁস হয়ে থাকলেও আক্রমণকারীর পুরনো কুকি বৈধ
    // থেকেই যেত — পাসওয়ার্ড বদলানো কার্যত অর্থহীন হয়ে পড়ত। routes/auth.js-এর
    // password-reset ফ্লো এটা আগে থেকেই করে; change-password ফ্লো করত না।
    try {
      await revokeAllOtherSessions(req.session.user.id, req.sessionID, 'PASSWORD_CHANGE');
    } catch (e) {
      console.error('revokeAllOtherSessions error:', e.message);
    }

    req.flash('success', req.t('profile_password_changed_ok'));
    res.redirect('/profile/security');
  } catch (err) {
    req.flash('error', req.t('profile_password_change_failed'));
    res.redirect('/profile/security');
  }
});

// 'predictions' নামে কোনো টেবিল নেই — বাজির আসল টেবিলের নাম 'bets' (দ্রষ্টব্য:
// routes/api.js, routes/admin.js একই টেবিল ব্যবহার করে)। আগে এই দুটো রুট সবসময়
// DB এরর দিয়ে ব্যর্থ হতো এবং নিঃশব্দে /profile-এ রিডাইরেক্ট করত (ইউজারের কাছে
// মনে হতো বাটনে কিছুই হচ্ছে না)। এছাড়া views/profile/history.ejs ও stats.ejs
// একটা `filter` অবজেক্ট আশা করে (quick/from/to/status) যা আগে পাঠানোই হতো না।
function resolveDateRange(query) {
  const { quick, from, to } = query;
  const fmt = (d) => d.toISOString().slice(0, 10);
  let dateFrom = from || '', dateTo = to || '';
  const today = new Date();
  if (quick === 'today') {
    dateFrom = dateTo = fmt(today);
  } else if (quick === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    dateFrom = dateTo = fmt(y);
  } else if (quick === '7days') {
    const d7 = new Date(today); d7.setDate(d7.getDate() - 7);
    dateFrom = fmt(d7); dateTo = fmt(today);
  }
  return { dateFrom, dateTo };
}

router.get('/history', isAuth, async (req, res) => {
  try {
    const { quick = '', status = '' } = req.query;
    const { dateFrom, dateTo } = resolveDateRange(req.query);

    let sql = `SELECT b.*, m.title, m.team_a, m.team_b
               FROM bets b LEFT JOIN matches m ON b.match_id = m.id
               WHERE b.user_id = $1`;
    const params = [req.session.user.id];
    if (dateFrom) { params.push(dateFrom); sql += ` AND b.created_at::date >= $${params.length}`; }
    if (dateTo) { params.push(dateTo); sql += ` AND b.created_at::date <= $${params.length}`; }
    if (['won', 'lost', 'pending'].includes(status)) { params.push(status); sql += ` AND b.status = $${params.length}`; }
    sql += ` ORDER BY b.created_at DESC LIMIT 100`;

    const bets = await pool.query(sql, params);
    res.render('profile/history', {
      bets: bets.rows,
      user: req.session.user,
      filter: { quick, from: req.query.from || '', to: req.query.to || '', status }
    });
  } catch (err) {
    console.error('profile/history error:', err.message);
    req.flash('error', req.t('common_history_load_failed'));
    res.redirect('/profile');
  }
});

router.get('/stats', isAuth, async (req, res) => {
  try {
    const { quick = '' } = req.query;
    const { dateFrom, dateTo } = resolveDateRange(req.query);

    let sql = `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'won')::int AS won,
        COUNT(*) FILTER (WHERE status = 'lost')::int AS lost,
        COALESCE(SUM(stake), 0) AS total_staked,
        COALESCE(SUM(stake * odd) FILTER (WHERE status = 'won'), 0) AS total_won_amount
      FROM bets WHERE user_id = $1`;
    const params = [req.session.user.id];
    if (dateFrom) { params.push(dateFrom); sql += ` AND created_at::date >= $${params.length}`; }
    if (dateTo) { params.push(dateTo); sql += ` AND created_at::date <= $${params.length}`; }

    const result = await pool.query(sql, params);
    const row = result.rows[0];
    const stats = {
      total: row.total,
      won: row.won,
      lost: row.lost,
      total_staked: Number(row.total_staked),
      total_won_amount: Number(row.total_won_amount),
      net_profit: Number(row.total_won_amount) - Number(row.total_staked)
    };
    res.render('profile/stats', {
      stats,
      user: req.session.user,
      filter: { quick, from: req.query.from || '', to: req.query.to || '' }
    });
  } catch (err) {
    console.error('profile/stats error:', err.message);
    req.flash('error', req.t('common_stats_load_failed'));
    res.redirect('/profile');
  }
});

router.get('/security', isAuth, async (req, res) => {
  try {
    const cards = await pool.query('SELECT id, user_id, bank_name, account_number, holder_name, created_at FROM bank_cards WHERE user_id = $1 ORDER BY created_at DESC', [req.session.user.id]);
    let pinStatus = { configured: false, locked: false };
    try { pinStatus = await getPinStatus(req.session.user.id); } catch (e) {}

    let activeSessions = [];
    let recentLogins = [];
    try {
      activeSessions = await listActiveSessions(req.session.user.id, req.sessionID);
      recentLogins = await listLoginHistory(req.session.user.id, 5, 0);
    } catch (e) { console.error('security devices load error:', e.message); }

    // ==================== Security Center — ইমেইল ভেরিফিকেশন ও পাসওয়ার্ড স্ট্যাটাস (সবসময় DB থেকে ফ্রেশ, সেশন স্টেল হতে পারে) ====================
    let emailStatus = { verified: true, hasEmail: false, lastSentAt: null };
    let passwordChangedAt = null;
    try {
      const u = await pool.query(
        'SELECT email, email_verified, last_verification_sent_at, password_changed_at FROM users WHERE id = $1',
        [req.session.user.id]
      );
      if (u.rows[0]) {
        emailStatus = {
          verified: !!u.rows[0].email_verified,
          hasEmail: !!u.rows[0].email,
          lastSentAt: u.rows[0].last_verification_sent_at
        };
        passwordChangedAt = u.rows[0].password_changed_at;
      }
    } catch (e) { console.error('security email/password status load error:', e.message); }

    // সাম্প্রতিক অ্যাক্টিভিটি — লগইন + ডিপোজিট/উইথড্র + রিওয়ার্ড/VIP, একই cache key পুনঃব্যবহার করা হয়েছে যাতে ডুপ্লিকেট কোয়েরি না হয়
    let recentActivity = [];
    try {
      recentActivity = await cache.getOrSet(`profile:recent:${req.session.user.id}`, 20, async () => {
        const r = await pool.query(
          `(SELECT 'login' AS kind, created_at, NULL::numeric AS amount FROM login_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5)
           UNION ALL
           (SELECT type AS kind, created_at, amount FROM payment_requests WHERE user_id=$1 AND status='approved' ORDER BY created_at DESC LIMIT 5)
           UNION ALL
           (SELECT CASE WHEN type='vip_upgrade' THEN 'vip_upgrade' ELSE 'reward_claim' END AS kind, created_at, amount
              FROM coin_transactions WHERE user_id=$1 AND amount > 0
                AND type IN ('badge','mission','loyalty_redeem','weekly_cashback','monthly_reward','social_share','daily_bonus','cashback','free_bet','lucky_wheel','vip_upgrade','win_streak')
              ORDER BY created_at DESC LIMIT 5)
           ORDER BY created_at DESC LIMIT 10`,
          [req.session.user.id]
        );
        return r.rows;
      });
    } catch (e) { console.error('security recent activity error:', e.message); }

    res.render('profile/security', {
      user: req.session.user, bankCards: cards.rows, pinStatus, activeSessions, recentLogins,
      emailStatus, passwordChangedAt, recentActivity, loadError: false
    });
  } catch (err) {
    // খালি bankCards দেখলে ইউজার ভাবতে পারে তার সংরক্ষিত ওয়ালেট মুছে
    // গেছে — এটাই withdraw-এর গন্তব্য, তাই "খালি" আর "জানা যায়নি" আলাদা।
    console.error('security page error:', err.message);
    res.render('profile/security', {
      user: req.session.user, bankCards: [], pinStatus: { configured: false, locked: false }, activeSessions: [], recentLogins: [],
      emailStatus: { verified: true, hasEmail: false, lastSentAt: null }, passwordChangedAt: null, recentActivity: [], loadError: true
    });
  }
});

// একটা ডিভাইস সেশন লগআউট — মালিকানা যাচাই revokeDeviceSession-এর ভেতরেই
// (WHERE id=$1 AND user_id=$2), তাই URL-এর :id অন্য কারো হলে চুপচাপ কিছুই
// হয় না, 404/403 leak করে না (কোন id গুলো বৈধ তা অনুমান করা ঠেকাতে)।
router.post('/devices/:id/logout', isAuth, async (req, res) => {
  try {
    await revokeDeviceSession(req.session.user.id, parseInt(req.params.id, 10), req.session.user.username);
    req.flash('success', req.t('profile_device_logged_out'));
  } catch (err) {
    console.error('device logout error:', err.message);
    req.flash('error', req.t('profile_device_logout_failed'));
  }
  res.redirect('/profile/security');
});

router.post('/devices/logout-all-others', isAuth, async (req, res) => {
  try {
    const count = await revokeAllOtherSessions(req.session.user.id, req.sessionID, req.session.user.username);
    req.flash('success', count > 0 ? req.t('profile_devices_logged_out_count').replace('{value}', count) : req.t('profile_no_other_devices'));
  } catch (err) {
    console.error('logout-all-others error:', err.message);
    req.flash('error', req.t('common_retry_error'));
  }
  res.redirect('/profile/security');
});

router.get('/login-history', isAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 20;
  try {
    const logins = await listLoginHistory(req.session.user.id, limit + 1, (page - 1) * limit);
    const hasMore = logins.length > limit;
    res.render('profile/login-history', {
      user: req.session.user,
      logins: logins.slice(0, limit),
      page,
      hasMore
    });
  } catch (err) {
    console.error('login-history load error:', err.message);
    res.render('profile/login-history', { user: req.session.user, logins: [], page, hasMore: false, loadError: true });
  }
});

// ==================== দায়িত্বশীল গেমিং ====================
router.get('/responsible', isAuth, async (req, res) => {
  try {
    const u = await pool.query(
      `SELECT daily_deposit_limit, self_exclude_until FROM users WHERE id = $1`,
      [req.session.user.id]
    );
    res.render('profile/responsible', { user: req.session.user, rg: u.rows[0] || {} });
  } catch (err) {
    console.error('responsible page error:', err.message);
    res.render('profile/responsible', { user: req.session.user, rg: {} });
  }
});

router.post('/responsible/deposit-limit', isAuth, async (req, res) => {
  try {
    const limit = req.body.limit ? parseInt(req.body.limit) : null;
    if (limit !== null && (isNaN(limit) || limit < 0)) {
      req.flash('error', req.t('profile_limit_invalid'));
      return res.redirect('/profile/responsible');
    }
    await pool.query(`UPDATE users SET daily_deposit_limit = $1 WHERE id = $2`, [limit, req.session.user.id]);
    req.flash('success', limit ? req.t('profile_deposit_limit_set').replace('{value}', limit) : req.t('profile_deposit_limit_removed'));
  } catch (err) {
    console.error('deposit-limit error:', err.message);
    req.flash('error', req.t('common_something_went_wrong'));
  }
  res.redirect('/profile/responsible');
});

router.post('/responsible/self-exclude', isAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days);
    if (isNaN(days) || days < 1) {
      req.flash('error', req.t('profile_days_invalid'));
      return res.redirect('/profile/responsible');
    }
    const until = new Date();
    until.setDate(until.getDate() + days);
    await pool.query(`UPDATE users SET self_exclude_until = $1 WHERE id = $2`, [until, req.session.user.id]);
    req.flash('success', req.t('profile_self_excluded_days').replace('{value}', days));
    return req.session.destroy(() => res.redirect('/login'));
  } catch (err) {
    console.error('self-exclude error:', err.message);
    req.flash('error', req.t('common_something_went_wrong'));
    res.redirect('/profile/responsible');
  }
});

// ==================== লাকি হুইল ====================
router.get('/wheel', isAuth, requireFeature('lucky_wheel'), async (req, res) => {
  try {
    const segments = getSegments();
    const status = await canSpin(req.session.user.id);
    const history = await getWheelHistory(req.session.user.id);
    res.render('profile/wheel', { user: req.session.user, segments, status, history, remainingToday: status.canSpin ? 1 : 0 });
  } catch (err) {
    console.error('wheel page error:', err.message);
    res.render('profile/wheel', { user: req.session.user, segments: [], status: { canSpin: false }, history: [], remainingToday: 0 });
  }
});

router.post('/wheel/spin', isAuth, claimLimiter, async (req, res) => {
  try {
    const result = await spin(req.session.user.id, req.lang);
    // স্পিন রেসপন্সে prize/message পাঠানো হতো না (message-এও প্রাইজের
    // অঙ্ক বাংলা টেক্সটে বসানো থাকত, যেমন "৫ কয়েন জিতেছেন!") — ক্লায়েন্ট
    // অ্যানিমেশন শেষ হওয়ার আগেই DevTools Network থেকে ফলাফল পড়া যেত।
    // ব্যর্থতার (already-spun/locked) মেসেজ প্রাইজ প্রকাশ করে না, তাই
    // সেটা রাখা নিরাপদ — শুধু সফল স্পিনেই message বাদ দেওয়া হলো।
    if (result.success) {
      res.json({ success: true, index: result.index });
    } else {
      res.json({ success: false, message: result.message });
    }
  } catch (err) {
    console.error('wheel spin error:', err.message);
    res.json({ success: false, message: req.t('common_server_error') });
  }
});

router.get('/wheel/result', isAuth, async (req, res) => {
  try {
    const result = await getTodayResult(req.session.user.id, req.lang || 'bn');
    if (!result) return res.json({ success: false, message: req.t('profile_no_spin_today') });
    res.json({ success: true, prize: result.prize, message: result.message });
  } catch (err) {
    console.error('wheel result error:', err.message);
    res.json({ success: false, message: req.t('common_server_error') });
  }
});

// ==================== ডেইলি মিশন ====================
router.get('/missions', isAuth, requireFeature('missions'), async (req, res) => {
  try {
    const missions = await getMissions(req.session.user.id);
    res.render('profile/missions', { user: req.session.user, missions });
  } catch (err) {
    console.error('missions page error:', err.message);
    res.render('profile/missions', { user: req.session.user, missions: { daily: [], weekly: [], special: [] } });
  }
});

router.post('/missions/claim/:id', isAuth, requireFeature('missions'), claimLimiter, async (req, res) => {
  try {
    const result = await claimMission(req.session.user.id, parseInt(req.params.id), req.lang);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('mission claim error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/missions');
});

// ==================== দৈনিক রিওয়ার্ড ====================
router.get('/rewards', isAuth, requireFeature('daily_rewards'), async (req, res) => {
  try {
    const reward = await getTodayReward(req.session.user.id);
    res.render('profile/rewards', { user: req.session.user, reward });
  } catch (err) {
    console.error('rewards page error:', err.message);
    res.render('profile/rewards', { user: req.session.user, reward: null });
  }
});

router.post('/rewards/claim', isAuth, async (req, res) => {
  try {
    const result = await claimDailyReward(req.session.user.id, req.lang);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('claim error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/rewards');
});

// ==================== লাল প্যাকট + সোনার ডিম (JSON API) ====================
router.get('/daily-rewards/status', isAuth, requireFeature('daily_rewards'), async (req, res) => {
  try {
    const status = await getRewardStatus(req.session.user.id);
    res.json({ ok: true, status });
  } catch (err) {
    console.error('daily-rewards status error:', err.message);
    res.json({ ok: false });
  }
});

router.post('/daily-rewards/red-packet/claim', isAuth, requireFeature('daily_rewards'), claimLimiter, async (req, res) => {
  try {
    const result = await claimRedPacket(req.session.user.id, req.lang);
    if (result.ok) {
      const r = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
      if (r.rows[0]) req.session.user.coins = r.rows[0].coins;
    }
    res.json(result);
  } catch (err) {
    console.error('red-packet claim error:', err.message);
    res.json({ ok: false, message: req.t('common_server_error') });
  }
});

router.post('/daily-rewards/golden-egg/claim', isAuth, requireFeature('daily_rewards'), claimLimiter, async (req, res) => {
  try {
    let idx = parseInt(req.body.pickedIndex, 10);
    if (isNaN(idx) || idx < 0 || idx > 7) idx = 0;
    const result = await claimGoldenEgg(req.session.user.id, idx);
    if (result.ok) {
      const r = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
      if (r.rows[0]) req.session.user.coins = r.rows[0].coins;
    }
    res.json(result);
  } catch (err) {
    console.error('golden-egg claim error:', err.message);
    res.json({ ok: false, message: req.t('common_server_error') });
  }
});


// ==================== ক্যাশবক ====================
router.get('/cashback', isAuth, requireFeature('cashback'), async (req, res) => {
  try {
    const cashback = await getCashbackStatus(req.session.user.id);
    res.render('profile/cashback', { user: req.session.user, cashback });
  } catch (err) {
    console.error('cashback page error:', err.message);
    res.render('profile/cashback', { user: req.session.user, cashback: null });
  }
});

router.post('/cashback/claim', isAuth, requireFeature('cashback'), async (req, res) => {
  try {
    const result = await claimCashback(req.session.user.id, req.body.category);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('cashback claim error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/cashback');
});

// ==================== VIP ====================
router.get('/support', isAuth, (req, res) => {
  res.render('profile/support', { user: req.session.user });
});

router.get('/vip', isAuth, requireFeature('vip'), async (req, res) => {
  try {
    const vip = await getVipStatus(req.session.user.id);
    res.render('profile/vip', { user: req.session.user, vip });
  } catch (err) {
    console.error('vip page error:', err.message);
    res.render('profile/vip', { user: req.session.user, vip: null });
  }
});

router.get('/api/vip-progress', isAuth, requireFeature('vip'), async (req, res) => {
  try {
    const vip = await getVipStatus(req.session.user.id);
    res.json({ success: true, vip });
  } catch (err) {
    console.error('vip-progress error:', err.message);
    res.status(500).json({ success: false, error: req.t('profile_vip_load_failed') });
  }
});

// ==================== রেফারেল ====================
router.get('/referral', isAuth, requireFeature('referral'), async (req, res) => {
  try {
    const stats = await getReferralStats(req.session.user.id);
    const baseUrl = getBaseUrl(req);
    res.render('profile/referral', {
      user: req.session.user,
      referralCount: stats.totalReferrals,
      stats,
      baseUrl
    });
  } catch (err) {
    console.error('referral page error:', err.message);
    const baseUrl = getBaseUrl(req);
    res.render('profile/referral', {
      user: req.session.user,
      referralCount: 0,
      stats: { totalReferrals: 0, successfulReferrals: 0, totalEarnings: 0, nextBonus: 100, history: [], team: [] },
      baseUrl
    });
  }
});

router.get('/transactions', isAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.session.user.id]
    );
    res.render('profile/transactions', { user: req.session.user, transactions: result.rows });
  } catch (err) {
    // loadError ছাড়া টেমপ্লেট "কোনো লেনদেন নেই" দেখাত — যেটা জানা নেই এমন
    // একটা দাবি। ব্যবহারকারী ভাবত তার লেজার খালি, আসলে কোয়েরিটাই ব্যর্থ।
    console.error('transactions page error:', err.message);
    res.render('profile/transactions', { user: req.session.user, transactions: [], loadError: true });
  }
});

router.get('/account-record', isAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.session.user.id]
    );
    res.render('profile/transactions', { user: req.session.user, transactions: result.rows });
  } catch (err) {
    console.error('account-record page error:', err.message);
    res.render('profile/transactions', { user: req.session.user, transactions: [], loadError: true });
  }
});

router.get('/cards', isAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM bank_cards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.user.id]
    );
    const cards = result.rows.filter(c => c.wallet_kind !== 'crypto');
    const cryptoCards = result.rows.filter(c => c.wallet_kind === 'crypto');
    res.render('profile/cards', { user: req.session.user, cards, cryptoCards });
  } catch (err) {
    // একই কারণ: loadError ছাড়া পেজটা "খালি ই-ওয়ালেট" আর গণনা ০ দেখাত।
    console.error('cards page error:', err.message);
    res.render('profile/cards', { user: req.session.user, cards: [], cryptoCards: [], loadError: true });
  }
});

router.post('/cards/add', isAuth, async (req, res) => {
  try {
    const { bank_name, account_number, holder_name } = req.body;
    const wallet_kind = req.body.wallet_kind === 'crypto' ? 'crypto' : 'ewallet';
    await pool.query(
      'INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name, wallet_kind) VALUES ($1,$2,$3,$4,$5)',
      [req.session.user.id, bank_name, account_number, holder_name, wallet_kind]
    );
    req.flash('success', req.t('profile_card_added_alt'));
  } catch (err) {
    req.flash('error', req.t('profile_card_add_failed'));
  }
  res.redirect('/profile/cards');
});

router.post('/security/withdraw-pin', isAuth, async (req, res) => {
  try {
    const { new_pin, confirm_pin } = req.body;
    if (!new_pin || !/^\d{6}$/.test(new_pin)) {
      req.flash('error', req.t('profile_pin_six_digits'));
      return res.redirect('/profile/security');
    }
    if (new_pin !== confirm_pin) {
      req.flash('error', req.t('profile_pins_do_not_match'));
      return res.redirect('/profile/security');
    }
    const hash = await bcrypt.hash(new_pin, 10);
    await pool.query('UPDATE users SET withdraw_pin_hash=$1 WHERE id=$2', [hash, req.session.user.id]);
    req.flash('success', req.t('profile_pin_set_ok'));
  } catch (err) {
    req.flash('error', req.t('profile_pin_set_failed'));
  }
  res.redirect('/profile/security');
});

// রোডম্যাপ-নাম alias — উপরের /security/withdraw-pin-এর মতোই লজিক, শুধু
// ফিল্ড নাম pin/confirmPin (উপরেরটা new_pin/confirm_pin)।
// ==================== Withdraw PIN তৈরি ====================
router.post('/withdraw-pin/create', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const status = await getPinStatus(userId);
    if (status.configured) {
      req.flash('error', req.t('pin_already_set'));
      return res.redirect('/profile/security');
    }

    const { pin, confirmPin } = req.body;
    if (!pin || !confirmPin || pin !== confirmPin) {
      req.flash('error', req.t('pin_mismatch'));
      return res.redirect('/profile/security');
    }
    if (isWeakPin(pin)) {
      req.flash('error', req.t('pin_too_weak_detail'));
      return res.redirect('/profile/security');
    }

    await createPin(userId, pin, req.ip);
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_CREATED', `ইউজার #${userId} নিজের Withdraw PIN তৈরি করেছে`, req.ip);
    req.flash('success', req.t('pin_created'));
    res.redirect('/profile/security');
  } catch (err) {
    console.error('withdraw-pin create error:', err.message);
    req.flash('error', req.t('pin_create_failed'));
    res.redirect('/profile/security');
  }
});

// ==================== Withdraw PIN পরিবর্তন (বর্তমান PIN জানা থাকলে) ====================
router.post('/withdraw-pin/change', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { currentPin, newPin, confirmNewPin } = req.body;

    const status = await getPinStatus(userId);
    if (!status.configured) {
      req.flash('error', req.t('pin_not_created_yet'));
      return res.redirect('/profile/security');
    }
    if (status.locked) {
      req.flash('error', req.t('pin_locked_minutes').replace('{value}', Math.ceil(status.remainingMs / 60000)));
      return res.redirect('/profile/security');
    }
    if (!newPin || !confirmNewPin || newPin !== confirmNewPin) {
      req.flash('error', req.t('pin_new_mismatch'));
      return res.redirect('/profile/security');
    }
    if (isWeakPin(newPin)) {
      req.flash('error', req.t('pin_too_weak'));
      return res.redirect('/profile/security');
    }

    const check = await verifyPin(userId, currentPin, req.ip);
    if (!check.success) {
      if (check.locked) {
        req.flash('error', req.t('pin_locked_15m'));
      } else {
        req.flash('error', req.t('pin_current_wrong'));
      }
      return res.redirect('/profile/security');
    }

    await updatePin(userId, newPin, req.ip, 'changed');
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_CHANGED', `ইউজার #${userId} নিজের Withdraw PIN পরিবর্তন করেছে`, req.ip);
    req.flash('success', req.t('pin_changed'));
    res.redirect('/profile/security');
  } catch (err) {
    console.error('withdraw-pin change error:', err.message);
    req.flash('error', req.t('pin_change_failed'));
    res.redirect('/profile/security');
  }
});

// ==================== Withdraw PIN রিসেট (PIN ভুলে গেলে — অ্যাকাউন্ট পাসওয়ার্ড দিয়ে যাচাই) ====================
router.post('/withdraw-pin/reset', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountPassword, newPin, confirmNewPin } = req.body;

    if (!newPin || !confirmNewPin || newPin !== confirmNewPin) {
      req.flash('error', req.t('pin_new_mismatch'));
      return res.redirect('/profile/security');
    }
    if (isWeakPin(newPin)) {
      req.flash('error', req.t('pin_too_weak'));
      return res.redirect('/profile/security');
    }

    const u = await pool.query('SELECT password FROM users WHERE id=$1', [userId]);
    if (!u.rows[0] || !(await bcrypt.compare(accountPassword || '', u.rows[0].password))) {
      req.flash('error', req.t('profile_account_password_wrong'));
      return res.redirect('/profile/security');
    }

    await updatePin(userId, newPin, req.ip, 'reset');
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_RESET', `ইউজার #${userId} নিজের Withdraw PIN রিসেট করেছে`, req.ip);
    req.flash('success', req.t('pin_reset_done'));
    res.redirect('/profile/security');
  } catch (err) {
    console.error('withdraw-pin reset error:', err.message);
    req.flash('error', req.t('pin_reset_failed'));
    res.redirect('/profile/security');
  }
});

router.post('/cards/delete/:id', isAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'DELETE FROM bank_cards WHERE id = $1 AND user_id = $2',
      [id, req.session.user.id]
    );
    req.flash('success', req.t('profile_card_deleted'));
  } catch (err) {
    req.flash('error', req.t('profile_card_delete_failed'));
  }
  res.redirect('back');
});

router.get('/app-download', isAuth, (req, res) => {
  res.render('profile/app-download', { user: req.session.user });
});

router.get('/feedback', isAuth, (req, res) => {
  res.render('profile/feedback', { user: req.session.user });
});

router.post('/feedback', isAuth, async (req, res) => {
  try {
    const { message } = req.body;
    await pool.query(
      'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, 0, $2, $3)',
      [req.session.user.id, 'feedback', message]
    );
    req.flash('success', req.t('feedback_sent'));
  } catch (err) {
    req.flash('error', req.t('feedback_send_failed'));
  }
  res.redirect('/profile/feedback');
});

router.get('/chat', isAuth, (req, res) => {
  res.render('profile/chat', { user: req.session.user });
});

// ==================== লয়্যালটি পয়েন্ট ====================
router.get('/loyalty', isAuth, async (req, res) => {
  try {
    const loyalty = await getLoyalty(req.session.user.id);
    const vip = await getVipStatus(req.session.user.id);
    res.render('profile/loyalty', { user: req.session.user, loyalty, vip });
  } catch (err) {
    console.error('loyalty page error:', err.message);
    res.render('profile/loyalty', { user: req.session.user, loyalty: null, vip: null });
  }
});

router.post('/loyalty/redeem', isAuth, async (req, res) => {
  try {
    const result = await redeemPoints(req.session.user.id, req.body.points);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('loyalty redeem error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/loyalty');
});

// ==================== উইন স্ট্রিক ====================
router.get('/streak', isAuth, async (req, res) => {
  try {
    const streak = await getStreak(req.session.user.id);
    res.render('profile/streak', { user: req.session.user, streak });
  } catch (err) {
    console.error('streak page error:', err.message);
    res.render('profile/streak', { user: req.session.user, streak: null });
  }
});

// ==================== ব্যাজ ও অরন ====================
router.get('/badges', isAuth, async (req, res) => {
  try {
    const badges = await getBadges(req.session.user.id);
    res.render('profile/badges', { user: req.session.user, badges });
  } catch (err) {
    console.error('badges page error:', err.message);
    res.render('profile/badges', { user: req.session.user, badges: [] });
  }
});

// ==================== ফ্রি বেট ====================
router.get('/freebet', isAuth, requireFeature('free_bet'), async (req, res) => {
  try {
    const freebets = await getAllFreeBets(req.session.user.id);
    res.render('profile/freebet', { user: req.session.user, freebets });
  } catch (err) {
    console.error('freebet page error:', err.message);
    res.render('profile/freebet', { user: req.session.user, freebets: [] });
  }
});

router.post('/freebet/claim/:id', isAuth, requireFeature('free_bet'), async (req, res) => {
  try {
    const result = await claimFreeBet(req.session.user.id, parseInt(req.params.id));
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('freebet claim error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/freebet');
});

// ==================== সাপ্তাহিক ও মাসিক রিওয়ার্ড ====================
router.get('/periodic', isAuth, async (req, res) => {
  try {
    const weekly = await getWeeklyStatus(req.session.user.id);
    const monthly = await getMonthlyStatus(req.session.user.id);
    res.render('profile/periodic', { user: req.session.user, weekly, monthly });
  } catch (err) {
    console.error('periodic page error:', err.message);
    res.render('profile/periodic', { user: req.session.user, weekly: null, monthly: null });
  }
});

router.post('/periodic/weekly', isAuth, async (req, res) => {
  try {
    const result = await claimWeekly(req.session.user.id);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('weekly claim error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/periodic');
});

router.post('/periodic/monthly', isAuth, async (req, res) => {
  try {
    const result = await claimMonthly(req.session.user.id);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('monthly claim error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/periodic');
});

// ==================== সোশ্যাল শেয়ার ====================
router.get('/share', isAuth, async (req, res) => {
  try {
    const share = await getShareStatus(req.session.user.id);
    const baseUrl = getBaseUrl(req);
    res.render('profile/share', { user: req.session.user, share, baseUrl });
  } catch (err) {
    console.error('share page error:', err.message);
    const baseUrl = getBaseUrl(req);
    res.render('profile/share', { user: req.session.user, share: null, baseUrl });
  }
});

router.post('/share/claim', isAuth, async (req, res) => {
  try {
    const result = await claimShare(req.session.user.id, req.lang);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('share claim error:', err.message);
    req.flash('error', req.t('common_server_error'));
  }
  res.redirect('/profile/share');
});

// ==================== রেফারেল কনটেস্ট ====================
router.get('/contest', isAuth, async (req, res) => {
  try {
    const contest = await getLeaderboard(req.session.user.id);
    const pastContests = await getPastContests(req.session.user.id);
    res.render('profile/contest', { user: req.session.user, contest, pastContests });
  } catch (err) {
    console.error('contest page error:', err.message);
    res.render('profile/contest', { user: req.session.user, contest: null, pastContests: [] });
  }
});

module.exports = router;
