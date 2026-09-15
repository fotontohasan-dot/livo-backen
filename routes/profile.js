const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const { revokeAllOtherSessions, revokeDeviceSession } = require('../services/deviceTracking');
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
const { getSegments, canSpin, spin, getHistory: getWheelHistory } = require('../services/wheel');
const { getLoyalty, redeemPoints } = require('../services/loyalty');
const { getStreak } = require('../services/streak');
const { getBadges } = require('../services/badges');
const { getAllFreeBets, claimFreeBet } = require('../services/freebet');
const { getWeeklyStatus, claimWeekly, getMonthlyStatus, claimMonthly } = require('../services/periodicReward');
const { getShareStatus, claimShare } = require('../services/social');
const { getLeaderboard, getPastContests } = require('../services/contest');
const { listLoginHistory } = require('../services/deviceTracking');
const { getRewardStatus, claimRedPacket, claimGoldenEgg } = require('../services/redpacket');


router.get('/api/balance', isAuth, async (req, res) => {
  try {
    const u = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    res.json({ success: true, coins: Number(u.rows[0]?.coins) || 0 });
  } catch (err) {
    console.error('profile/api/balance error:', err.message);
    res.status(500).json({ error: 'ব্যালেন্স লোড করা যায়নি।' });
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
      return res.status(400).json({ success: false, error: 'অবৈধ ছবি নির্বাচন।' });
    }
    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [avatar, req.session.user.id]);
    req.session.user.avatar = avatar;
    res.json({ success: true, avatar });
  } catch (err) {
    console.error('profile/update-avatar error:', err.message);
    res.status(500).json({ success: false, error: 'প্রোফাইল ছবি আপডেট করা যায়নি।' });
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
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.render('profile/index', {
      user: user.rows[0],
      profileUser: user.rows[0],
      baseUrl
    });
  } catch (err) {
    console.error('Profile error:', err);
    req.flash('error', 'প্রোফাইল লোড করতে সমস্যা হয়েছে।');
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
      req.flash('error', 'ছবি আপলোড ব্যর্থ — শুধু JPG/PNG/WEBP, সর্বোচ্চ ৩MB');
      return res.redirect('/profile');
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    req.flash('error', 'কোনো ছবি নির্বাচন করা হয়নি');
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
    req.flash('success', 'প্রোফাইল ছবি পরিবর্তন হয়েছে');
    res.redirect('/profile');
  } catch (e) {
    console.error('avatar upload error:', e.message);
    req.flash('error', 'ছবি আপলোড ব্যর্থ হয়েছে, আবার চেষ্টা করুন');
    res.redirect('/profile');
  }
});

router.post('/update', isAuth, async (req, res) => {
  try {
    const { username } = req.body;
    await pool.query(`UPDATE users SET username=$1 WHERE id=$2`, [username, req.session.user.id]);
    req.session.user.username = username;
    req.flash('success', 'প্রোফাইল আপডেট হয়েছে!');
  } catch (err) {
    req.flash('error', 'আপডেট করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile');
});

router.post('/update-personal', isAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    await pool.query(`UPDATE users SET full_name=$1, phone=$2 WHERE id=$3`, [full_name, phone, req.session.user.id]);
    req.session.user.full_name = full_name;
    req.session.user.phone = phone;

    req.flash('success', '✅ তথ্য আপডেট হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ আপডেট করতে সমস্যা হয়েছে।');
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
    req.flash('success', '✅ কার্ড যোগ হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ কার্ড যোগ করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/security');
});

router.post('/delete-bank-card/:id', isAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM bank_cards WHERE id=$1 AND user_id=$2`, [req.params.id, req.session.user.id]);
    req.flash('success', '✅ কার্ড মুছে ফেলা হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ কার্ড মুছতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/security');
});

router.post('/change-password', isAuth, async (req, res) => {
  try {
    const { current_password, new_password, currentPassword, newPassword, confirmPassword } = req.body;
    const cp = current_password || currentPassword;
    const np = new_password || newPassword;

    if (confirmPassword && np !== confirmPassword) {
      req.flash('error', '❌ নতুন পাসওয়ার মিলছে না।');
      return res.redirect('/profile/security');
    }
    if (!np || np.length < 8) {
      req.flash('error', '❌ নতুন পাসওয়ার্ড কমপক্ষে ৮ ক্যারেক্টার হতে হবে।');
      return res.redirect('/profile/security');
    }

    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
    if (!(await bcrypt.compare(cp, user.rows[0].password))) {
      req.flash('error', '❌ বর্তমান পাসওয়ার্ড ভুল।');
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

    req.flash('success', '✅ পাসওয়ার্ড পরিবর্তন হয়েছে!');
    res.redirect('/profile/security');
  } catch (err) {
    req.flash('error', '❌ পাসওয়ার্ড পরিবর্তন করতে সমস্যা হয়েছে।');
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
    req.flash('error', 'ইতিহাস লোড করতে সমস্যা হয়েছে।');
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
    req.flash('error', 'স্ট্যাটস লোড করতে সমস্যা হয়েছে।');
    res.redirect('/profile');
  }
});

router.get('/security', isAuth, async (req, res) => {
  try {
    const cards = await pool.query('SELECT * FROM bank_cards WHERE user_id = $1 ORDER BY created_at DESC', [req.session.user.id]);
    res.render('profile/security', { user: req.session.user, bankCards: cards.rows });
  } catch (err) {
    res.render('profile/security', { user: req.session.user, bankCards: [] });
  }
});

// একটা ডিভাইস সেশন লগআউট — মালিকানা যাচাই revokeDeviceSession-এর ভেতরেই
// (WHERE id=$1 AND user_id=$2), তাই URL-এর :id অন্য কারো হলে চুপচাপ কিছুই
// হয় না, 404/403 leak করে না (কোন id গুলো বৈধ তা অনুমান করা ঠেকাতে)।
router.post('/devices/:id/logout', isAuth, async (req, res) => {
  try {
    await revokeDeviceSession(req.session.user.id, parseInt(req.params.id, 10), req.session.user.username);
    req.flash('success', '✅ ডিভাইস লগআউট করা হয়েছে।');
  } catch (err) {
    console.error('device logout error:', err.message);
    req.flash('error', '❌ লগআউট করা যায়নি।');
  }
  res.redirect('/profile/security');
});

// ==================== দায়িত্বশীল গেমিং ====================
router.get('/login-history', isAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  try {
    const rows = await listLoginHistory(req.session.user.id, limit + 1, offset);
    const hasMore = rows.length > limit;
    res.render('profile/login-history', {
      user: req.session.user,
      logins: rows.slice(0, limit),
      page,
      hasMore
    });
  } catch (err) {
    console.error('profile/login-history error:', err.message);
    res.render('profile/login-history', { user: req.session.user, logins: [], page: 1, hasMore: false, loadError: true });
  }
});

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
      req.flash('error', 'সঠিক সীমা দিন।');
      return res.redirect('/profile/responsible');
    }
    await pool.query(`UPDATE users SET daily_deposit_limit = $1 WHERE id = $2`, [limit, req.session.user.id]);
    req.flash('success', limit ? `দৈনিক ডিপোজট সীমা ${limit} টাকা সেট হয়েছে।` : 'ডিপোজিট সীমা সরানো হয়েছে।');
  } catch (err) {
    console.error('deposit-limit error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে।');
  }
  res.redirect('/profile/responsible');
});

router.post('/responsible/self-exclude', isAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days);
    if (isNaN(days) || days < 1) {
      req.flash('error', 'সঠিক দিন সংখ্যা দিন।');
      return res.redirect('/profile/responsible');
    }
    const until = new Date();
    until.setDate(until.getDate() + days);
    await pool.query(`UPDATE users SET self_exclude_until = $1 WHERE id = $2`, [until, req.session.user.id]);
    req.flash('success', `আপনার অ্যাকাউন্ট ${days} দিনের জন্য বন্ধ করা হযছে।`);
    return req.session.destroy(() => res.redirect('/login'));
  } catch (err) {
    console.error('self-exclude error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে।');
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

router.post('/wheel/spin', isAuth, async (req, res) => {
  try {
    const result = await spin(req.session.user.id);
    res.json(result);
  } catch (err) {
    console.error('wheel spin error:', err.message);
    res.json({ success: false, message: 'সার্ভার ত্রুটি।' });
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

router.post('/missions/claim/:id', isAuth, requireFeature('missions'), async (req, res) => {
  try {
    const result = await claimMission(req.session.user.id, parseInt(req.params.id));
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('mission claim error:', err.message);
    req.flash('error', 'সার্ভার ত্রুটি।');
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
    const result = await claimDailyReward(req.session.user.id);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('claim error:', err.message);
    req.flash('error', 'সার্ভার ত্রুটি।');
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

router.post('/daily-rewards/red-packet/claim', isAuth, requireFeature('daily_rewards'), async (req, res) => {
  try {
    const result = await claimRedPacket(req.session.user.id);
    if (result.ok) {
      const r = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
      if (r.rows[0]) req.session.user.coins = r.rows[0].coins;
    }
    res.json(result);
  } catch (err) {
    console.error('red-packet claim error:', err.message);
    res.json({ ok: false, message: 'সার্ভার ত্রুটি।' });
  }
});

router.post('/daily-rewards/golden-egg/claim', isAuth, requireFeature('daily_rewards'), async (req, res) => {
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
    res.json({ ok: false, message: 'সার্ভার ত্রুটি।' });
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
    req.flash('error', 'সার্ভার ত্রুটি।');
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
    res.status(500).json({ success: false, error: 'VIP তথ্য লোড করা যায়নি।' });
  }
});

// ==================== রেফারেল ====================
router.get('/referral', isAuth, requireFeature('referral'), async (req, res) => {
  try {
    const stats = await getReferralStats(req.session.user.id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.render('profile/referral', {
      user: req.session.user,
      referralCount: stats.totalReferrals,
      stats,
      baseUrl
    });
  } catch (err) {
    console.error('referral page error:', err.message);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
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
    res.render('profile/transactions', { user: req.session.user, transactions: [] });
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
    res.render('profile/transactions', { user: req.session.user, transactions: [] });
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
    res.render('profile/cards', { user: req.session.user, cards: [], cryptoCards: [] });
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
    req.flash('success', '✅ কার্ড যোগ করা হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ কার্ড যোগ করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/cards');
});

router.post('/security/withdraw-pin', isAuth, async (req, res) => {
  try {
    const { new_pin, confirm_pin } = req.body;
    if (!new_pin || !/^\d{6}$/.test(new_pin)) {
      req.flash('error', '৬ ডিজিটের পিন দিন');
      return res.redirect('/profile/security');
    }
    if (new_pin !== confirm_pin) {
      req.flash('error', 'পিন দুটি মিলছে না');
      return res.redirect('/profile/security');
    }
    const hash = await bcrypt.hash(new_pin, 10);
    await pool.query('UPDATE users SET withdraw_pin_hash=$1 WHERE id=$2', [hash, req.session.user.id]);
    req.flash('success', '✅ উইথড্র পিন সেট করা হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ পিন সেট করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/security');
});

router.post('/cards/delete/:id', isAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'DELETE FROM bank_cards WHERE id = $1 AND user_id = $2',
      [id, req.session.user.id]
    );
    req.flash('success', '✅ কার্ড মুছে ফেলা হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ কার্ড মুছতে সমস্যা হয়েছে।');
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
    req.flash('success', '✅ আপনার মতামত পাঠানো হয়েছে। ধন্যবাদ!');
  } catch (err) {
    req.flash('error', '❌ মতামত পাঠাতে সমস্যা হয়েছে।');
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
    req.flash('error', 'সার্ভার ত্রুটি।');
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
    req.flash('error', 'সার্ভার ত্রুটি।');
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
    req.flash('error', 'সার্ভার ত্রুটি।');
  }
  res.redirect('/profile/periodic');
});

router.post('/periodic/monthly', isAuth, async (req, res) => {
  try {
    const result = await claimMonthly(req.session.user.id);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('monthly claim error:', err.message);
    req.flash('error', 'সার্ভার ত্রুটি।');
  }
  res.redirect('/profile/periodic');
});

// ==================== সোশ্যাল শেয়ার ====================
router.get('/share', isAuth, async (req, res) => {
  try {
    const share = await getShareStatus(req.session.user.id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.render('profile/share', { user: req.session.user, share, baseUrl });
  } catch (err) {
    console.error('share page error:', err.message);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.render('profile/share', { user: req.session.user, share: null, baseUrl });
  }
});

router.post('/share/claim', isAuth, async (req, res) => {
  try {
    const result = await claimShare(req.session.user.id);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('share claim error:', err.message);
    req.flash('error', 'সার্ভার ত্রুটি।');
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
