const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const router = express.Router();
const { pool } = require('../db');
const { requireFeature } = require('../middleware/featureGate');
const { getBaseUrl } = require('../utils/publicUrl');
const { listActiveSessions, revokeAllOtherSessions, revokeDeviceSession, listLoginHistory } = require('../services/deviceTracking');
const { isWeakPin, createPin, updatePin, verifyPin, getPinStatus } = require('../services/withdrawPin');
const { logAdminAction } = require('../services/fraudDetection');
const { createLimiter } = require('../middleware/rateLimitFactory');
const { isAuth } = require('../middleware/auth');
const cache = require('../services/cache');
const bcrypt = require('bcryptjs');
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


// PIN তৈরি/পরিবর্তন/রিসেট — প্রতি ইউজারে ১৫ মিনিটে সর্বোচ্চ ৬ বার (ব্রুট-ফোর্স ঠেকাতে)।
const accountSecurityLimiter = createLimiter('account_security', {
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: (req) => req.t('common_rate_limited_15m'),
  keyGenerator: (req) => (req.session && req.session.user) ? `u_${req.session.user.id}` : ipKeyGenerator(req.ip)
});

router.get('/', isAuth, async (req, res) => {
  try {
    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);

    res.render('profile/index', {
      user: user.rows[0],
      profileUser: user.rows[0]
    });
  } catch (err) {
    console.error('Profile error:', err);
    req.flash('error', req.t('profile_msg_01'));
    res.redirect('/');
  }
});

router.get('/api/balance', isAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: req.t('profile_msg_02') });
    req.session.user.coins = result.rows[0].coins;
    res.json({ success: true, coins: result.rows[0].coins });
  } catch (err) {
    console.error('balance api error:', err.message);
    res.status(500).json({ success: false, error: req.t('profile_msg_03') });
  }
});

router.post('/update', isAuth, async (req, res) => {
  try {
    const { username } = req.body;
    await pool.query(`UPDATE users SET username=$1 WHERE id=$2`, [username, req.session.user.id]);
    req.session.user.username = username;
    req.flash('success', req.t('profile_msg_04'));
  } catch (err) {
    req.flash('error', req.t('profile_msg_05'));
  }
  res.redirect('/profile');
});

router.post('/update-personal', isAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    await pool.query(`UPDATE users SET full_name=$1, phone=$2 WHERE id=$3`, [full_name, phone, req.session.user.id]);
    req.session.user.full_name = full_name;
    req.session.user.phone = phone;

    req.flash('success', req.t('profile_msg_06'));
  } catch (err) {
    req.flash('error', req.t('profile_msg_07'));
  }
  res.redirect('/profile/security/personal');
});

router.post('/add-bank-card', isAuth, async (req, res) => {
  try {
    const { bank_name, account_number, holder_name } = req.body;
    await pool.query(
      `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1, $2, $3, $4)`,
      [req.session.user.id, bank_name, account_number, holder_name]
    );
    req.flash('success', req.t('profile_msg_08'));
  } catch (err) {
    req.flash('error', req.t('profile_msg_09'));
  }
  res.redirect('/profile/security/bank');
});

router.post('/delete-bank-card/:id', isAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM bank_cards WHERE id=$1 AND user_id=$2`, [req.params.id, req.session.user.id]);
    req.flash('success', req.t('profile_msg_10'));
  } catch (err) {
    req.flash('error', req.t('profile_msg_11'));
  }
  res.redirect('/profile/security/bank');
});

router.post('/change-password', isAuth, async (req, res) => {
  try {
    const { current_password, new_password, currentPassword, newPassword, confirmPassword } = req.body;
    const cp = current_password || currentPassword;
    const np = new_password || newPassword;

    if (confirmPassword && np !== confirmPassword) {
      req.flash('error', req.t('profile_msg_12'));
      return res.redirect('/profile/security/login-password');
    }

    if (!np || np.length < 8) {
      req.flash('error', req.t('profile_password_min_length'));
      return res.redirect('/profile/security/login-password');
    }

    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
    if (!cp || !(await bcrypt.compare(cp, user.rows[0].password))) {
      req.flash('error', req.t('profile_msg_13'));
      return res.redirect('/profile/security/login-password');
    }
    const hashed = await bcrypt.hash(np, 12);
    await pool.query(`UPDATE users SET password=$1, password_changed_at=NOW() WHERE id=$2`, [hashed, req.session.user.id]);
    // পাসওয়ার্ড বদলের পর অন্য সব ডিভাইসের পুরনো সেশন বাতিল (সেশন হাইজ্যাক ঝুঁকি কমায়);
    // বর্তমান সেশন চালু থাকে। routes/auth.js-এর password-reset-এও একই আচরণ।
    try {
      await revokeAllOtherSessions(req.session.user.id, req.sessionID, 'PASSWORD_CHANGE');
    } catch (e) {
      console.error('revokeAllOtherSessions error:', e.message);
    }
    req.flash('success', req.t('profile_msg_14'));
    res.redirect('/profile/security/login-password');
  } catch (err) {
    req.flash('error', req.t('profile_msg_15'));
    res.redirect('/profile/security/login-password');
  }
});

// ট্রানজেকশন (ফান্ডস) পাসওয়ার্ড — এটা লগইন পাসওয়ার্ড থেকে সম্পূর্ণ আলাদা,
// আলাদা কলামে (users.transaction_password) সংরক্ষিত হয়। প্রথমবার সেট করার
// সময় "বর্তমান পাসওয়ার্ড" চাওয়া হয় না (তখনও কিছু সেট করাই নেই); আগে থেকে
// একটা থাকলে সেটা যাচাই করে তবেই বদলানো যায়। ফর্মে কয়টা ফিল্ড দেখানো হবে
// সেটাও এই একই শর্তে (user.transaction_password আছে কিনা) security.ejs-এ ঠিক হয়।
router.post('/set-transaction-password', isAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!newPassword || newPassword !== confirmPassword) {
      req.flash('error', req.t('profile_msg_16'));
      return res.redirect('/profile/security/transaction-password');
    }

    const userRes = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
    const existing = userRes.rows[0];

    if (existing.transaction_password) {
      // আগে থেকে সেট করা থাকলে বর্তমান ট্রানজেকশন পাসওয়ার্ড যাচাই বাধ্যতামূলক
      if (!currentPassword || !(await bcrypt.compare(currentPassword, existing.transaction_password))) {
        req.flash('error', req.t('profile_msg_17'));
        return res.redirect('/profile/security/transaction-password');
      }
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET transaction_password=$1 WHERE id=$2`, [hashed, req.session.user.id]);
    req.flash('success', existing.transaction_password ? req.t('profile_msg_18') : req.t('profile_msg_19'));
    res.redirect('/profile/security/transaction-password');
  } catch (err) {
    console.error('set-transaction-password error:', err.message);
    req.flash('error', req.t('profile_msg_20'));
    res.redirect('/profile/security/transaction-password');
  }
});

router.get('/history', isAuth, async (req, res) => {
  try {
    const { status, quick, from, to } = req.query;
    const conditions = ['b.user_id=$1'];
    const params = [req.session.user.id];

    if (['pending', 'won', 'lost'].includes(status)) {
      params.push(status);
      conditions.push(`b.status=$${params.length}`);
    }

    let dateFrom = from, dateTo = to;
    if (quick === 'today') { dateFrom = new Date().toISOString().slice(0, 10); dateTo = dateFrom; }
    else if (quick === 'yesterday') { const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10); dateFrom = y; dateTo = y; }
    else if (quick === '7days') { dateFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10); dateTo = new Date().toISOString().slice(0, 10); }

    if (dateFrom) { params.push(dateFrom); conditions.push(`b.created_at::date >= $${params.length}`); }
    if (dateTo) { params.push(dateTo); conditions.push(`b.created_at::date <= $${params.length}`); }

    const bets = await pool.query(`
      SELECT b.*, m.title, m.team_a, m.team_b
      FROM bets b LEFT JOIN matches m ON b.match_id = m.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY b.created_at DESC LIMIT 200
    `, params);

    res.render('profile/history', {
      user: req.session.user,
      bets: bets.rows,
      filter: { status: status || '', quick: quick || '', from: dateFrom || '', to: dateTo || '' }
    });
  } catch (err) {
    console.error('betting history error:', err.message);
    req.flash('error', req.t('profile_msg_21'));
    res.redirect('/profile');
  }
});

router.get('/stats', isAuth, async (req, res) => {
  try {
    const { quick, from, to } = req.query;
    const conditions = ['user_id=$1'];
    const params = [req.session.user.id];

    let dateFrom = from, dateTo = to;
    if (quick === 'today') { dateFrom = new Date().toISOString().slice(0, 10); dateTo = dateFrom; }
    else if (quick === 'yesterday') { const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10); dateFrom = y; dateTo = y; }
    else if (quick === '7days') { dateFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10); dateTo = new Date().toISOString().slice(0, 10); }

    if (dateFrom) { params.push(dateFrom); conditions.push(`created_at::date >= $${params.length}`); }
    if (dateTo) { params.push(dateTo); conditions.push(`created_at::date <= $${params.length}`); }

    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status='won' THEN 1 END) AS won,
        COUNT(CASE WHEN status='lost' THEN 1 END) AS lost,
        COUNT(CASE WHEN status='pending' THEN 1 END) AS pending,
        COALESCE(SUM(stake),0) AS total_staked,
        COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS total_won_amount
      FROM bets WHERE ${conditions.join(' AND ')}
    `, params);

    const row = result.rows[0];
    const settledStake = await pool.query(`
      SELECT COALESCE(SUM(stake),0) AS s FROM bets WHERE ${conditions.join(' AND ')} AND status IN ('won','lost')
    `, params);

    const stats = {
      total: parseInt(row.total),
      won: parseInt(row.won),
      lost: parseInt(row.lost),
      pending: parseInt(row.pending),
      total_staked: Number(row.total_staked),
      total_won_amount: Number(row.total_won_amount),
      net_profit: Number(row.total_won_amount) - Number(settledStake.rows[0].s)
    };

    res.render('profile/stats', {
      user: req.session.user,
      stats,
      filter: { quick: quick || '', from: dateFrom || '', to: dateTo || '' }
    });
  } catch (err) {
    console.error('stats error:', err.message);
    req.flash('error', req.t('profile_msg_22'));
    res.redirect('/profile');
  }
});

const SECURITY_TABS = ['personal', 'bank', 'security', 'devices'];
// পুরনো/ভিন্ন URL (লগইন-পাসওয়ার্ড, ট্রানজেকশন-পাসওয়ার্ড) 'security' ট্যাবেই খোলে।
const SECURITY_TAB_ALIASES = { 'login-password': 'security', 'transaction-password': 'security' };
router.get('/security{/:tab}', isAuth, async (req, res) => {
  const requestedTab = SECURITY_TAB_ALIASES[req.params.tab] || req.params.tab;
  const activeTab = SECURITY_TABS.includes(requestedTab) ? requestedTab : 'personal';
  try {
    const cards = await pool.query('SELECT id, user_id, bank_name, account_number, holder_name, wallet_kind, created_at FROM bank_cards WHERE user_id = $1 ORDER BY created_at DESC', [req.session.user.id]);
    const hasCryptoWallet = cards.rows.some(c => c.wallet_kind === 'crypto');
    const hasEwallet = cards.rows.some(c => c.wallet_kind !== 'crypto');
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

    const personalInfoComplete = !!(req.session.user.full_name && req.session.user.phone);
    const lastLogin = recentLogins[0] || null;

    // ==================== নিরাপত্তা শতাংশ — ৫টি আইটেম, প্রতিটি ২০% ====================
    const safetyChecks = [personalInfoComplete, hasCryptoWallet, hasEwallet, !!passwordChangedAt, !!(pinStatus && pinStatus.configured)];
    const safetyScore = safetyChecks.filter(Boolean).length * 20;
    const safetyLevel = safetyScore >= 80 ? 'high' : (safetyScore >= 40 ? 'medium' : 'low');

    res.render('profile/security', {
      user: req.session.user, bankCards: cards.rows, hasCryptoWallet, hasEwallet, pinStatus, activeSessions, recentLogins,
      emailStatus, passwordChangedAt, recentActivity, loadError: false,
      personalInfoComplete, lastLogin, safetyScore, safetyLevel, activeTab
    });
  } catch (err) {
    // খালি bankCards দেখলে ইউজার ভাবতে পারে তার সংরক্ষিত ওয়ালেট মুছে
    // গেছে — এটাই withdraw-এর গন্তব্য, তাই "খালি" আর "জানা যায়নি" আলাদা।
    console.error('security page error:', err.message);
    res.render('profile/security', {
      user: req.session.user, bankCards: [], hasCryptoWallet: false, hasEwallet: false, pinStatus: { configured: false, locked: false }, activeSessions: [], recentLogins: [],
      emailStatus: { verified: true, hasEmail: false, lastSentAt: null }, passwordChangedAt: null, recentActivity: [], loadError: true,
      personalInfoComplete: false, lastLogin: null, safetyScore: 0, safetyLevel: 'low', activeTab
    });
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
      req.flash('error', req.t('profile_msg_27'));
      return res.redirect('/profile/responsible');
    }
    await pool.query(`UPDATE users SET daily_deposit_limit = $1 WHERE id = $2`, [limit, req.session.user.id]);
    req.flash('success', limit ? req.t('profile_msg_daily_limit_set').replace('{value}', limit) : req.t('profile_msg_daily_limit_removed'));
  } catch (err) {
    console.error('deposit-limit error:', err.message);
    req.flash('error', req.t('profile_msg_28'));
  }
  res.redirect('/profile/responsible');
});

router.post('/responsible/self-exclude', isAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days);
    if (isNaN(days) || days < 1) {
      req.flash('error', req.t('profile_msg_29'));
      return res.redirect('/profile/responsible');
    }
    const until = new Date();
    until.setDate(until.getDate() + days);
    await pool.query(`UPDATE users SET self_exclude_until = $1 WHERE id = $2`, [until, req.session.user.id]);
    req.flash('success', req.t('profile_msg_self_exclude_set').replace('{value}', days));
    return req.session.destroy(() => res.redirect('/login'));
  } catch (err) {
    console.error('self-exclude error:', err.message);
    req.flash('error', req.t('profile_msg_28'));
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

// প্রতি ইউজার/IP-তে মিনিটে সর্বোচ্চ ১০ বার claim/spin রিকোয়েস্ট — বট/স্প্যাম ঠেকাতে
const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.user ? String(req.session.user.id) : ipKeyGenerator(req.ip)),
  handler: (req, res) => res.status(429).json({ ok: false, success: false, message: req.t('profile_msg_30') })
});

router.post('/wheel/spin', isAuth, requireFeature('lucky_wheel'), claimLimiter, async (req, res) => {
  try {
    const result = await spin(req.session.user.id, req.lang);
    // পুরস্কার/জয়ের বার্তা এখানে পাঠানো হয় না — অ্যানিমেশন শেষের আগে ফাঁস হবে।
    // পুরস্কার শুধু GET /wheel/result দেয়।
    if (result && result.success) {
      return res.json({ success: true, index: result.index });
    }
    res.json({ success: false, message: (result && result.message) || req.t('profile_msg_31') });
  } catch (err) {
    console.error('wheel spin error:', err.message);
    res.json({ success: false, message: req.t('profile_msg_31') });
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
    const result = await claimMission(req.session.user.id, parseInt(req.params.id), req.lang);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('mission claim error:', err.message);
    req.flash('error', req.t('profile_msg_31'));
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
    req.flash('error', req.t('profile_msg_31'));
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
    res.json({ ok: false, message: req.t('profile_msg_31') });
  }
});

router.post('/daily-rewards/golden-egg/claim', isAuth, requireFeature('daily_rewards'), claimLimiter, async (req, res) => {
  try {
    let idx = parseInt(req.body.pickedIndex, 10);
    if (isNaN(idx) || idx < 0 || idx > 7) idx = 0;
    const result = await claimGoldenEgg(req.session.user.id, idx, req.lang);
    if (result.ok) {
      const r = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
      if (r.rows[0]) req.session.user.coins = r.rows[0].coins;
    }
    res.json(result);
  } catch (err) {
    console.error('golden-egg claim error:', err.message);
    res.json({ ok: false, message: req.t('profile_msg_31') });
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
    req.flash('error', req.t('profile_msg_31'));
  }
  res.redirect('/profile/cashback');
});

// ==================== VIP ====================
router.get('/vip', isAuth, requireFeature('vip'), async (req, res) => {
  try {
    const vip = await getVipStatus(req.session.user.id);
    res.render('profile/vip', { user: req.session.user, vip });
  } catch (err) {
    console.error('vip page error:', err.message);
    res.render('profile/vip', { user: req.session.user, vip: null });
  }
});

// VIP প্রোগ্রেস — লাইভ AJAX আপডেটের জন্য (০ থেকে ১০০০ স্কেল)
router.get('/api/vip-progress', isAuth, requireFeature('vip'), async (req, res) => {
  try {
    const vip = await getVipStatus(req.session.user.id);
    res.json({
      success: true,
      progress: vip.progress,           // 0 - 1000
      totalTurnover: vip.totalTurnover,
      toNext: vip.toNext,
      level: vip.level,
      currentName: vip.current ? vip.current.name : null,
      nextName: vip.next ? vip.next.name : null,
      isMax: !vip.next
    });
  } catch (err) {
    console.error('vip progress api error:', err.message);
    res.status(500).json({ success: false, error: req.t('profile_msg_03') });
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
    console.error('transactions load error:', err.message);
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
    console.error('transactions load error:', err.message);
    res.render('profile/transactions', { user: req.session.user, transactions: [], loadError: true });
  }
});

router.get('/cards', isAuth, async (req, res) => {
  // cards.ejs টেমপ্লেট `cards` (ই-ওয়ালেট) আর `cryptoCards` দুটো আলাদা
  // ভ্যারিয়েবল আশা করে। আগে এখানে শুধু `cards` পাঠানো হতো —
  // `cryptoCards` কখনোই পাস হতো না, তাই টেমপ্লেটের
  // `cryptoCards.length` লাইনে EJS ReferenceError ছুঁড়ত এবং প্রতিবার
  // এই পেজে গেলেই (বা নতুন নাম্বার অ্যাড করতে গেলে) generic ৫০০ এরর
  // পেজ দেখাত। wallet_kind কলাম না থাকলেও (মাইগ্রেশন না চলে থাকলে)
  // crash না করতে ক্যাচ করা হয়েছে, payment.js-এর /withdraw-এর মতো।
  try {
    const result = await pool.query(
      'SELECT * FROM bank_cards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.user.id]
    );
    let ewalletCards = result.rows;
    let cryptoCards = [];
    try {
      ewalletCards = result.rows.filter(c => c.wallet_kind !== 'crypto');
      cryptoCards = result.rows.filter(c => c.wallet_kind === 'crypto');
    } catch (e) { /* wallet_kind column may not exist yet if migration hasn't run */ }
    res.render('profile/cards', { user: req.session.user, cards: ewalletCards, cryptoCards });
  } catch (err) {
    console.error('cards GET error:', err.message);
    res.render('profile/cards', { user: req.session.user, cards: [], cryptoCards: [], loadError: true });
  }
});

router.post('/cards/add', isAuth, async (req, res) => {
  try {
    const { bank_name, account_number, holder_name } = req.body;
    await pool.query(
      'INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1,$2,$3,$4)',
      [req.session.user.id, bank_name, account_number, holder_name]
    );
    req.flash('success', req.t('profile_msg_32'));
  } catch (err) {
    req.flash('error', req.t('profile_msg_09'));
  }
  res.redirect('/profile/cards');
});

router.post('/cards/delete/:id', isAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'DELETE FROM bank_cards WHERE id = $1 AND user_id = $2',
      [id, req.session.user.id]
    );
    req.flash('success', req.t('profile_msg_10'));
  } catch (err) {
    req.flash('error', req.t('profile_msg_11'));
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
    req.flash('success', req.t('profile_msg_33'));
  } catch (err) {
    req.flash('error', req.t('profile_msg_34'));
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
    req.flash('error', req.t('profile_msg_31'));
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
    req.flash('error', req.t('profile_msg_31'));
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
    req.flash('error', req.t('profile_msg_31'));
  }
  res.redirect('/profile/periodic');
});

router.post('/periodic/monthly', isAuth, async (req, res) => {
  try {
    const result = await claimMonthly(req.session.user.id);
    req.flash(result.success ? 'success' : 'error', result.message);
  } catch (err) {
    console.error('monthly claim error:', err.message);
    req.flash('error', req.t('profile_msg_31'));
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
    req.flash('error', req.t('profile_msg_31'));
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

// ==================== পুনরুদ্ধার: ফ্রন্টএন্ড যে রুটগুলো এখনো কল করে (আগে 404 দিত) ====================

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

router.post('/devices/:id/logout', isAuth, async (req, res) => {
  try {
    await revokeDeviceSession(req.session.user.id, parseInt(req.params.id, 10), req.session.user.username);
    req.flash('success', req.t('profile_device_logged_out'));
  } catch (err) {
    console.error('device logout error:', err.message);
    req.flash('error', req.t('profile_device_logout_failed'));
  }
  res.redirect('/profile/security/devices');
});

router.post('/devices/logout-all-others', isAuth, async (req, res) => {
  try {
    const count = await revokeAllOtherSessions(req.session.user.id, req.sessionID, req.session.user.username);
    req.flash('success', count > 0 ? req.t('profile_devices_logged_out_count').replace('{value}', count) : req.t('profile_no_other_devices'));
  } catch (err) {
    console.error('logout-all-others error:', err.message);
    req.flash('error', req.t('common_retry_error'));
  }
  res.redirect('/profile/security/devices');
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

router.get('/support', isAuth, (req, res) => {
  res.render('profile/support', { user: req.session.user });
});

router.post('/withdraw-pin/create', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const status = await getPinStatus(userId);
    if (status.configured) {
      req.flash('error', req.t('pin_already_set'));
      return res.redirect('/profile/security/security');
    }

    const { pin, confirmPin } = req.body;
    if (!pin || !confirmPin || pin !== confirmPin) {
      req.flash('error', req.t('pin_mismatch'));
      return res.redirect('/profile/security/security');
    }
    if (isWeakPin(pin)) {
      req.flash('error', req.t('pin_too_weak_detail'));
      return res.redirect('/profile/security/security');
    }

    await createPin(userId, pin, req.ip);
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_CREATED', `ইউজার #${userId} নিজের Withdraw PIN তৈরি করেছে`, req.ip);
    req.flash('success', req.t('pin_created'));
    res.redirect('/profile/security/security');
  } catch (err) {
    console.error('withdraw-pin create error:', err.message);
    req.flash('error', req.t('pin_create_failed'));
    res.redirect('/profile/security/security');
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
      return res.redirect('/profile/security/security');
    }
    if (status.locked) {
      req.flash('error', req.t('pin_locked_minutes').replace('{value}', Math.ceil(status.remainingMs / 60000)));
      return res.redirect('/profile/security/security');
    }
    if (!newPin || !confirmNewPin || newPin !== confirmNewPin) {
      req.flash('error', req.t('pin_new_mismatch'));
      return res.redirect('/profile/security/security');
    }
    if (isWeakPin(newPin)) {
      req.flash('error', req.t('pin_too_weak'));
      return res.redirect('/profile/security/security');
    }

    const check = await verifyPin(userId, currentPin, req.ip);
    if (!check.success) {
      if (check.locked) {
        req.flash('error', req.t('pin_locked_15m'));
      } else {
        req.flash('error', req.t('pin_current_wrong'));
      }
      return res.redirect('/profile/security/security');
    }

    await updatePin(userId, newPin, req.ip, 'changed');
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_CHANGED', `ইউজার #${userId} নিজের Withdraw PIN পরিবর্তন করেছে`, req.ip);
    req.flash('success', req.t('pin_changed'));
    res.redirect('/profile/security/security');
  } catch (err) {
    console.error('withdraw-pin change error:', err.message);
    req.flash('error', req.t('pin_change_failed'));
    res.redirect('/profile/security/security');
  }
});

// ==================== Withdraw PIN রিসেট (PIN ভুলে গেলে — অ্যাকাউন্ট পাসওয়ার্ড দিয়ে যাচাই) ====================
router.post('/withdraw-pin/reset', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountPassword, newPin, confirmNewPin } = req.body;

    if (!newPin || !confirmNewPin || newPin !== confirmNewPin) {
      req.flash('error', req.t('pin_new_mismatch'));
      return res.redirect('/profile/security/security');
    }
    if (isWeakPin(newPin)) {
      req.flash('error', req.t('pin_too_weak'));
      return res.redirect('/profile/security/security');
    }

    const u = await pool.query('SELECT password FROM users WHERE id=$1', [userId]);
    if (!u.rows[0] || !(await bcrypt.compare(accountPassword || '', u.rows[0].password))) {
      req.flash('error', req.t('profile_account_password_wrong'));
      return res.redirect('/profile/security/security');
    }

    await updatePin(userId, newPin, req.ip, 'reset');
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_RESET', `ইউজার #${userId} নিজের Withdraw PIN রিসেট করেছে`, req.ip);
    req.flash('success', req.t('pin_reset_done'));
    res.redirect('/profile/security/security');
  } catch (err) {
    console.error('withdraw-pin reset error:', err.message);
    req.flash('error', req.t('pin_reset_failed'));
    res.redirect('/profile/security/security');
  }
});

module.exports = router;
