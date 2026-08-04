const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
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
const { getRewardStatus, claimRedPacket, claimGoldenEgg } = require('../services/redpacket');
const { checkContent } = require('../utils/contentFilter');
const { isWeakPin, createPin, updatePin, verifyPin, getPinStatus } = require('../services/withdrawPin');
const { listActiveSessions, listLoginHistory, revokeDeviceSession, revokeAllOtherSessions, getUserDeviceOverview, lookupLocation } = require('../services/deviceTracking');
const { logAdminAction } = require('../services/fraudDetection');
const cache = require('../services/cache');
const { createLimiter } = require('../middleware/rateLimitFactory');

// পাসওয়ার্ড, উইথড্র-পিন, ব্যাংক কার্ড — অ্যাকাউন্ট-টেকওভার সংশ্লিষ্ট সংবেদনশীল অ্যাকশন,
// প্রতি ইউজারে ১৫ মিনিটে সর্বোচ্চ ৬ বার (আগে শুধু generalLimiter-এর ৩০০/১৫মিনিট দিয়ে
// ঢিলেঢালাভাবে কভার হতো)।
const accountSecurityLimiter = createLimiter('account_security', {
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: 'অনেকবার চেষ্টা করেছেন। ১৫ মিনিট পর আবার চেষ্টা করুন।',
  keyGenerator: (req) => (req.session && req.session.user) ? `u_${req.session.user.id}` : req.ip
});

// ==== ইনপুট ভ্যালিডেশন হেল্পার (username, name, phone, bank card ফিল্ড) ====
// লক্ষ্য: কোনো ফিল্ডেই <, >, স্ক্রিপ্ট, বা লিংক বসিয়ে ঢুকতে না পারা — কারণ এই মানগুলো
// পরে অ্যাডমিন প্যানেলে দেখানো হয়, তাই ইনপুট নেওয়ার সময়ই আটকানো সবচেয়ে নিরাপদ।
const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
// নাম: বাংলা/ইংরেজি অক্ষর, স্পেস, ডট, অ্যাপোস্ট্রফি, হাইফেন — HTML স্পেশাল ক্যারেক্টার (< > " ' এর মধ্যে শুধু নেম-সাধারণ apostrophe বাদে) বাদে
const NAME_RE = /^[\p{L}\p{M}\s.'-]{2,60}$/u;
const PHONE_RE = /^[0-9+\-\s]{6,20}$/;
const BANK_FIELD_RE = /^[A-Za-z0-9\s._\-]{2,40}$/;

function isValidUsername(v) { return typeof v === 'string' && USERNAME_RE.test(v.trim()); }
function isValidName(v) { return typeof v === 'string' && NAME_RE.test(v.trim()) && !checkContent(v).flagged; }
function isValidPhone(v) { return typeof v === 'string' && PHONE_RE.test(v.trim()); }
function isValidBankField(v) { return typeof v === 'string' && BANK_FIELD_RE.test(v.trim()); }



router.get('/', isAuth, async (req, res) => {
  try {
    const user = await pool.query(`SELECT id, username, email, phone, coins, demo_balance, role, avatar, kyc_status, total_points, total_turnover, vip_level, email_verified, totp_enabled, is_banned, referred_by_id, referral_code, last_login, last_ip, created_at, password FROM users WHERE id=$1`, [req.session.user.id]);

    // প্রোফাইলের কয়েন ব্যালেন্স সবসময় সরাসরি DB থেকে (উপরে) নেওয়া হচ্ছে — এটা কখনো ক্যাশ করা হয় না।
    // নিচের প্রেডিকশন/টুর্নামেন্ট/স্ট্যাটস তুলনামূলক কম-সংবেদনশীল ও ভারী জয়েন কোয়েরি, তাই ১৫ সেকেন্ড ক্যাশ করা হয়েছে।
    let predictions = [], tournaments = [], stats = { total: 0, won: 0, total_earned: 0 };
    try {
      const result = await cache.getOrSet(`profile:activity:${req.session.user.id}`, 15, async () => {
        const predictionsRes = await pool.query(`
          SELECT b.id, b.stake AS amount, b.odd, b.status, b.created_at,
                 m.title, m.team_a, m.team_b, m.score_a, m.score_b, b.selection
          FROM bets b
          JOIN matches m ON b.match_id = m.id
          WHERE b.user_id = $1
          ORDER BY b.created_at DESC LIMIT 10
        `, [req.session.user.id]);

        const tournamentsRes = await pool.query(`
          SELECT
            COALESCE(t.name, 'টুর্নমেন্ট') as name,
            COALESCE(t.sport, 'General') as sport,
            COALESCE(tp.points, 0) as points,
            tp.joined_at as joined_at
          FROM tournament_participants tp
          JOIN tournaments t ON tp.tournament_id = t.id
          WHERE tp.user_id = $1
          ORDER BY tp.joined_at DESC
        `, [req.session.user.id]).catch(() => ({ rows: [] }));

        const statsRes = await pool.query(`
          SELECT
            COUNT(*) as total,
            COUNT(CASE WHEN status='won' THEN 1 END) as won,
            COALESCE(SUM(CASE WHEN status='won' THEN stake*(odd-1) ELSE 0 END), 0) as total_earned
          FROM bets
          WHERE user_id = $1
        `, [req.session.user.id]);

        return { predictions: predictionsRes.rows, tournaments: tournamentsRes.rows, stats: statsRes.rows[0] };
      });
      predictions = result.predictions || [];
      tournaments = result.tournaments || [];
      stats = result.stats || stats;
    } catch (e) { console.error('profile activity block error:', e.message); }

    // Member Center গ্রিডের ব্যাজ কাউন্ট — কোনো একটাতে সমস্যা হলেও পুরো প্রোফাইল পেজ যেন লোড হতে ব্যর্থ না হয়, তাই আলাদা try/catch
    let missionBadge = 0;
    try {
      const missions = await getMissions(req.session.user.id);
      missionBadge = [...missions.daily, ...missions.weekly, ...missions.special]
        .filter(m => m.done && !m.claimed).length;
    } catch (e) {
      console.error('mission badge count error:', e.message);
    }

    let rewardBadge = 0;
    try {
      const reward = await getTodayReward(req.session.user.id);
      rewardBadge = (reward && !reward.claimed && reward.currentTier) ? 1 : 0;
    } catch (e) {
      console.error('reward badge count error:', e.message);
    }

    // VIP প্রোগ্রেস কার্ড
    let vipStatus = null;
    try { vipStatus = await getVipStatus(req.session.user.id); } catch (e) { console.error('vip status error:', e.message); }

    // সিকিউরিটি স্ট্যাটাস কার্ড — বিদ্যমান কলাম/সার্ভিস থেকেই তৈরি, নতুন কোনো স্টোরেজ লাগেনি
    let security = { emailVerified: false, phoneAdded: false, kycStatus: 'none', pinConfigured: false, twoFactor: false, trustedDevices: 0, score: 0 };
    try {
      const u = user.rows[0];
      let pinConfigured = false;
      try { pinConfigured = !!(await getPinStatus(req.session.user.id)).configured; } catch (e) {}
      let trustedDevices = 0;
      let deviceOverview = { recentLogins: [], activeSessions: [] };
      try { deviceOverview = await getUserDeviceOverview(req.session.user.id, 5); trustedDevices = deviceOverview.activeSessions.length; } catch (e) {}

      security.emailVerified = !!u.email_verified;
      security.phoneAdded = !!u.phone;
      security.kycStatus = u.kyc_status || 'none';
      security.pinConfigured = pinConfigured;
      security.twoFactor = !!u.totp_enabled;
      security.trustedDevices = trustedDevices;

      const checks = [security.emailVerified, security.phoneAdded, security.kycStatus === 'approved', security.pinConfigured, security.twoFactor, trustedDevices > 0];
      security.score = Math.round((checks.filter(Boolean).length / checks.length) * 100);
    } catch (e) { console.error('security status error:', e.message); }

    // সিকিউরিটি তথ্য কার্ড — শেষ লগইন, বর্তমান/আগের ডিভাইস, লগইন IP, অ্যাকাউন্ট স্ট্যাটাস
    let securityInfo = { lastLoginTime: null, currentDevice: null, lastDevice: null, loginIp: null, accountStatus: 'active' };
    try {
      const u = user.rows[0];
      const overview = await getUserDeviceOverview(req.session.user.id, 3);
      const sessions = overview.activeSessions || [];
      const logins = overview.recentLogins || [];
      const current = sessions.find(s => s.is_current) || sessions[0] || null;
      const last = logins[0] || null;
      securityInfo = {
        lastLoginTime: u.last_login || (last ? last.created_at : null),
        currentDevice: current ? [current.os, current.browser].filter(Boolean).join(' · ') || current.device_name : null,
        lastDevice: last ? [last.os, last.browser].filter(Boolean).join(' · ') : null,
        loginIp: u.last_ip || (last ? last.ip : null),
        loginLocation: lookupLocation(u.last_ip || (last ? last.ip : null)),
        accountStatus: u.is_banned ? 'banned' : 'active'
      };
    } catch (e) { console.error('security info error:', e.message); }

    // নোটিফিকেশন সেন্টার প্রিভিউ — বিদ্যমান notifications টেবিল, "read" মার্ক করে না (শুধু প্রিভিউ)
    let notifPreview = { latest: [], unreadCount: 0 };
    try {
      notifPreview = await cache.getOrSet(`profile:notif_preview:${req.session.user.id}`, 20, async () => {
        const latestRes = await pool.query(
          `SELECT id, title, message, type, is_read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 4`,
          [req.session.user.id]
        );
        const countRes = await pool.query(
          `SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false`,
          [req.session.user.id]
        );
        return { latest: latestRes.rows, unreadCount: Number(countRes.rows[0].count) };
      });
    } catch (e) { console.error('notif preview error:', e.message); }

    // অ্যাচিভমেন্ট/ব্যাজ প্রিভিউ — বিদ্যমান getBadges() রিইউজ
    let badgesPreview = { earned: [], earnedCount: 0, totalCount: 0 };
    try {
      const all = await getBadges(req.session.user.id);
      const earned = all.filter(b => b.earned).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt)).slice(0, 6);
      badgesPreview = { earned, earnedCount: all.filter(b => b.earned).length, totalCount: all.length };
    } catch (e) { console.error('badges preview error:', e.message); }

    // প্রোফাইল কমপ্লিশন শতাংশ — অ্যাভাটার + ভেরিফিকেশন চেকলিস্ট
    let profileCompletion = 0;
    try {
      const u = user.rows[0];
      const items = [!!u.avatar, !!u.email_verified, !!u.phone, u.kyc_status === 'approved', security.pinConfigured, security.twoFactor];
      profileCompletion = Math.round((items.filter(Boolean).length / items.length) * 100);
    } catch (e) { console.error('profile completion error:', e.message); }

    // গত ৩০ দিনের স্ট্যাটিস্টিক্স (ডিপোজিট/উইথড্র/বাজি) — ১৫ মিনিট ক্যাশ, হালকা কোয়েরি
    let stats30 = { deposit: 0, withdraw: 0, profitLoss: 0, totalBets: 0, totalBonus: 0, chart: [] };
    try {
      stats30 = await cache.getOrSet(`profile:stats30:${req.session.user.id}`, 900, async () => {
        const payRes = await pool.query(
          `SELECT COALESCE(SUM(CASE WHEN type='deposit' AND status='approved' THEN amount ELSE 0 END),0) AS deposit,
                  COALESCE(SUM(CASE WHEN type='withdraw' AND status='approved' THEN amount ELSE 0 END),0) AS withdraw
           FROM payment_requests WHERE user_id=$1 AND created_at >= NOW() - INTERVAL '30 days'`,
          [req.session.user.id]
        );
        const betRes = await pool.query(
          `SELECT COUNT(*) AS total_bets,
                  COALESCE(SUM(CASE WHEN status='won' THEN stake*(odd-1) ELSE 0 END),0) -
                  COALESCE(SUM(CASE WHEN status='lost' THEN stake ELSE 0 END),0) AS profit_loss
           FROM bets WHERE user_id=$1 AND created_at >= NOW() - INTERVAL '30 days'`,
          [req.session.user.id]
        );
        const bonusRes = await pool.query(
          `SELECT COALESCE(SUM(amount),0) AS total_bonus FROM coin_transactions
           WHERE user_id=$1 AND amount > 0 AND created_at >= NOW() - INTERVAL '30 days'
             AND type IN ('badge','mission','loyalty_redeem','weekly_cashback','monthly_reward','social_share','daily_bonus','cashback','free_bet','lucky_wheel','vip_upgrade','win_streak')`,
          [req.session.user.id]
        );
        const dayRes = await pool.query(
          `SELECT to_char(created_at, 'MM-DD') AS d, COUNT(*) AS c
           FROM bets WHERE user_id=$1 AND created_at >= NOW() - INTERVAL '7 days'
           GROUP BY d ORDER BY d ASC`,
          [req.session.user.id]
        );
        return {
          deposit: Number(payRes.rows[0].deposit),
          withdraw: Number(payRes.rows[0].withdraw),
          profitLoss: Number(betRes.rows[0].profit_loss),
          totalBets: Number(betRes.rows[0].total_bets),
          totalBonus: Number(bonusRes.rows[0].total_bonus),
          chart: dayRes.rows.map(r => ({ d: r.d, c: Number(r.c) }))
        };
      });
    } catch (e) { console.error('stats30 error:', e.message); }

    // সাম্প্রতিক অ্যাক্টিভিটি (শেষ ৫টা) — লগইন + ডিপোজিট/উইথড্র + রিওয়ার্ড ক্লেইম + VIP আপগ্রেড থেকে একত্রিত
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
           ORDER BY created_at DESC LIMIT 5`,
          [req.session.user.id]
        );
        return r.rows;
      });
    } catch (e) { console.error('recent activity error:', e.message); }

    // রেফারেল সামারি কার্ড — বিদ্যমান getReferralStats রিইউজ করা হয়েছে, ৬০ সেকেন্ড ক্যাশ
    let referralSummary = { totalInvites: 0, activeInvites: 0, totalCommission: 0, todayCommission: 0 };
    try {
      referralSummary = await cache.getOrSet(`profile:referral_summary:${req.session.user.id}`, 60, async () => {
        const stats = await getReferralStats(req.session.user.id);
        const activeInvites = (stats.team || []).filter(t => t.first_deposit_done).length;
        const todayRes = await pool.query(
          `SELECT COALESCE(SUM(amount),0) AS total FROM referral_commissions WHERE earner_id=$1 AND created_at::date = CURRENT_DATE`,
          [req.session.user.id]
        );
        return {
          totalInvites: stats.totalReferrals,
          activeInvites,
          totalCommission: stats.totalEarnings,
          todayCommission: Number(todayRes.rows[0].total)
        };
      });
    } catch (e) { console.error('referral summary error:', e.message); }

    res.render('profile/index', {
      user: user.rows[0],
      profileUser: user.rows[0],
      predictions: predictions,
      tournaments: tournaments,
      stats: stats,
      missionBadge,
      rewardBadge,
      vipStatus,
      security,
      securityInfo,
      stats30,
      recentActivity,
      referralSummary,
      notifPreview,
      badgesPreview,
      profileCompletion
    });
  } catch (err) {
    console.error('Profile error:', err);
    req.flash('error', 'প্রোফাইল লোড করতে সমস্যা হয়েছে।');
    res.redirect('/');
  }
});

router.get('/api/balance', isAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'ইউজার পাওয়া যায়নি' });
    req.session.user.coins = result.rows[0].coins;
    res.json({ success: true, coins: result.rows[0].coins });
  } catch (err) {
    console.error('balance api error:', err.message);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি' });
  }
});

router.post('/update', isAuth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!isValidUsername(username)) {
      req.flash('error', 'ইউজারনেমে শুধু লেটার, সংখ্যা, আন্ডারস্কোর, ডট ব্যবহার করা যাবে (৩-২০ ক্যারেক্টার)।');
      return res.redirect('/profile');
    }
    await pool.query(`UPDATE users SET username=$1 WHERE id=$2`, [username.trim(), req.session.user.id]);
    req.session.user.username = username.trim();
    req.flash('success', 'প্রোফাইল আপডেট হয়েছে!');
  } catch (err) {
    req.flash('error', 'আপডেট করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile');
});

const ALLOWED_AVATAR_IDS = [12, 33, 5, 47, 8, 25, 15, 44, 68, 32, 60, 51, 20, 49, 65, 57];

router.post('/update-avatar', isAuth, async (req, res) => {
  try {
    const { avatar } = req.body || {};
    const match = typeof avatar === 'string' && avatar.match(/^https:\/\/i\.pravatar\.cc\/300\?img=(\d+)$/);
    const imgId = match ? parseInt(match[1], 10) : null;

    if (!imgId || !ALLOWED_AVATAR_IDS.includes(imgId)) {
      return res.status(400).json({ success: false, error: 'অবৈধ ছবি নির্বাচন' });
    }

    await pool.query(`UPDATE users SET avatar=$1 WHERE id=$2`, [avatar, req.session.user.id]);
    req.session.user.avatar = avatar;

    res.json({ success: true, avatar });
  } catch (err) {
    console.error('update-avatar error:', err.message);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি' });
  }
});

router.post('/update-personal', isAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    if (full_name && !isValidName(full_name)) {
      req.flash('error', 'নামে অস্বাভাবিক ক্যারেক্টার বা লিংক থাকা যাবে না।');
      return res.redirect('/profile/security');
    }
    if (phone && !isValidPhone(phone)) {
      req.flash('error', 'ফোন নম্বর সঠিক ফরম্যাটে দিন।');
      return res.redirect('/profile/security');
    }
    await pool.query(`UPDATE users SET full_name=$1, phone=$2 WHERE id=$3`, [full_name, phone, req.session.user.id]);
    req.session.user.full_name = full_name;
    req.session.user.phone = phone;

    req.flash('success', '✅ তথ্য আপডেট হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ আপডেট করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/security');
});

router.post('/add-bank-card', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const { bank_name, account_number, holder_name } = req.body;
    if (!isValidBankField(bank_name) || !isValidBankField(account_number) || !isValidName(holder_name)) {
      req.flash('error', '❌ কার্ডের তথ্যে অস্বাভাবিক ক্যারেক্টার বা লিংক থাকা যাবে না।');
      return res.redirect('/profile/security');
    }
    await pool.query(
      `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1, $2, $3, $4)`,
      [req.session.user.id, bank_name.trim(), account_number.trim(), holder_name.trim()]
    );
    req.flash('success', '✅ কার্ড যোগ হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ কার্ড যোগ করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/security');
});

router.post('/delete-bank-card/:id', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    await pool.query(`DELETE FROM bank_cards WHERE id=$1 AND user_id=$2`, [req.params.id, req.session.user.id]);
    req.flash('success', '✅ কার্ড মুছে ফেলা হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ কার্ড মুছতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/security');
});

router.post('/change-password', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const { current_password, new_password, currentPassword, newPassword, confirmPassword } = req.body;
    const cp = current_password || currentPassword;
    const np = new_password || newPassword;

    if (confirmPassword && np !== confirmPassword) {
      req.flash('error', '❌ নতুন পাসওয়ার মিলছে না।');
      return res.redirect('/profile/security');
    }

    const user = await pool.query(`SELECT id, username, email, phone, coins, demo_balance, role, avatar, kyc_status, total_points, referred_by_id, referral_code, last_login, last_ip, created_at, password FROM users WHERE id=$1`, [req.session.user.id]);
    if (!(await bcrypt.compare(cp, user.rows[0].password))) {
      req.flash('error', '❌ বর্তমান পাসওয়ার্ড ভুল।');
      return res.redirect('/profile/security');
    }
    const hashed = await bcrypt.hash(np, 10);
    await pool.query(`UPDATE users SET password=$1, password_changed_at=NOW() WHERE id=$2`, [hashed, req.session.user.id]);
    await logAdminAction(req.session.user.id, req.session.user.username, 'PASSWORD_CHANGED', `ইউজার #${req.session.user.id} নিজের পাসওয়ার্ড পরিবর্তন করেছে`, req.ip);
    req.flash('success', '✅ পাসওয়ার্ড পরিবর্তন হয়েছে!');
    res.redirect('/profile/security');
  } catch (err) {
    req.flash('error', '❌ পাসওয়ার্ড পরিবর্তন করতে সমস্যা হয়েছে।');
    res.redirect('/profile/security');
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
    req.flash('error', 'ইতিহাস লোড করতে সমস্যা হয়েছে।');
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
    req.flash('error', 'স্ট্যাটস লোড করতে সমস্যা হয়েছে।');
    res.redirect('/profile');
  }
});

router.get('/security', isAuth, async (req, res) => {
  try {
    const cards = await pool.query('SELECT id, user_id, bank_name, account_number, account_name, is_default, created_at FROM bank_cards WHERE user_id = $1 ORDER BY created_at DESC', [req.session.user.id]);
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

    res.render('profile/security', {
      user: req.session.user, bankCards: cards.rows, pinStatus, activeSessions, recentLogins,
      emailStatus, passwordChangedAt
    });
  } catch (err) {
    res.render('profile/security', {
      user: req.session.user, bankCards: [], pinStatus: { configured: false, locked: false }, activeSessions: [], recentLogins: [],
      emailStatus: { verified: true, hasEmail: false, lastSentAt: null }, passwordChangedAt: null
    });
  }
});

// ==================== ডিভাইস লগআউট (নির্দিষ্ট / সব অন্য ডিভাইস) ====================
router.post('/devices/:id/logout', isAuth, async (req, res) => {
  try {
    const ok = await revokeDeviceSession(req.session.user.id, req.params.id, req.session.user.username);
    req.flash(ok ? 'success' : 'error', ok ? '✅ ডিভাইস থেকে লগআউট করা হয়েছে।' : '❌ ডিভাইসটি খুঁজে পাওয়া যায়নি।');
  } catch (err) {
    console.error('device logout error:', err.message);
    req.flash('error', '❌ সমস্যা হয়েছে, আবার চেষ্টা করুন।');
  }
  res.redirect('/profile/security');
});

router.post('/devices/logout-all-others', isAuth, async (req, res) => {
  try {
    const count = await revokeAllOtherSessions(req.session.user.id, req.sessionID, req.session.user.username);
    req.flash('success', count > 0 ? `✅ ${count}টি অন্য ডিভাইস থেকে লগআউট করা হয়েছে।` : 'অন্য কোনো সক্রিয় ডিভাইস নেই।');
  } catch (err) {
    console.error('logout-all-others error:', err.message);
    req.flash('error', '❌ সমস্যা হয়েছে, আবার চেষ্টা করুন।');
  }
  res.redirect('/profile/security');
});

// ==================== সম্পূর্ণ লগইন হিস্ট্রি ====================
router.get('/login-history', isAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const logins = await listLoginHistory(req.session.user.id, limit, (page - 1) * limit);
    res.render('profile/login-history', { user: req.session.user, logins, page, hasMore: logins.length === limit });
  } catch (err) {
    console.error('login-history load error:', err.message);
    res.render('profile/login-history', { user: req.session.user, logins: [], page: 1, hasMore: false });
  }
});

// ==================== Withdraw PIN তৈরি ====================
router.post('/withdraw-pin/create', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const status = await getPinStatus(userId);
    if (status.configured) {
      req.flash('error', '❌ আপনার আগে থেকেই Withdraw PIN সেট করা আছে। পরিবর্তন করতে "Change PIN" ব্যবহার করুন।');
      return res.redirect('/profile/security');
    }

    const { pin, confirmPin } = req.body;
    if (!pin || !confirmPin || pin !== confirmPin) {
      req.flash('error', '❌ PIN দুটি মিলছে না।');
      return res.redirect('/profile/security');
    }
    if (isWeakPin(pin)) {
      req.flash('error', '❌ দুর্বল বা অনুমানযোগ্য PIN গ্রহণযোগ্য নয়। একই সংখ্যা বা ক্রমিক প্যাটার্ন এড়িয়ে চলুন।');
      return res.redirect('/profile/security');
    }

    await createPin(userId, pin, req.ip);
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_CREATED', `ইউজার #${userId} নিজের Withdraw PIN তৈরি করেছে`, req.ip);
    req.flash('success', '✅ Withdraw PIN সফলভাবে তৈরি হয়েছে!');
    res.redirect('/profile/security');
  } catch (err) {
    console.error('withdraw-pin create error:', err.message);
    req.flash('error', '❌ Withdraw PIN তৈরি করতে সমস্যা হয়েছে।');
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
      req.flash('error', '❌ প্রথমে একটি Withdraw PIN তৈরি করুন।');
      return res.redirect('/profile/security');
    }
    if (status.locked) {
      req.flash('error', `🔒 অনেকবার ভুল চেষ্টার কারণে সাময়িকভাবে লক করা হয়েছে। ${Math.ceil(status.remainingMs / 60000)} মিনিট পর আবার চেষ্টা করুন।`);
      return res.redirect('/profile/security');
    }
    if (!newPin || !confirmNewPin || newPin !== confirmNewPin) {
      req.flash('error', '❌ নতুন PIN দুটি মিলছে না।');
      return res.redirect('/profile/security');
    }
    if (isWeakPin(newPin)) {
      req.flash('error', '❌ দুর্বল বা অনুমানযোগ্য PIN গ্রহণযোগ্য নয়।');
      return res.redirect('/profile/security');
    }

    const check = await verifyPin(userId, currentPin, req.ip);
    if (!check.success) {
      if (check.locked) {
        req.flash('error', '🔒 অনেকবার ভুল চেষ্টার কারণে Withdraw PIN সাময়িকভাবে লক করা হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।');
      } else {
        req.flash('error', '❌ বর্তমান PIN ভুল।');
      }
      return res.redirect('/profile/security');
    }

    await updatePin(userId, newPin, req.ip, 'changed');
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_CHANGED', `ইউজার #${userId} নিজের Withdraw PIN পরিবর্তন করেছে`, req.ip);
    req.flash('success', '✅ Withdraw PIN পরিবর্তন হয়েছে!');
    res.redirect('/profile/security');
  } catch (err) {
    console.error('withdraw-pin change error:', err.message);
    req.flash('error', '❌ PIN পরিবর্তন করতে সমস্যা হয়েছে।');
    res.redirect('/profile/security');
  }
});

// ==================== Withdraw PIN রিসেট (PIN ভুলে গেলে — অ্যাকাউন্ট পাসওয়ার্ড দিয়ে যাচাই) ====================
router.post('/withdraw-pin/reset', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { accountPassword, newPin, confirmNewPin } = req.body;

    if (!newPin || !confirmNewPin || newPin !== confirmNewPin) {
      req.flash('error', '❌ নতুন PIN দুটি মিলছে না।');
      return res.redirect('/profile/security');
    }
    if (isWeakPin(newPin)) {
      req.flash('error', '❌ দুর্বল বা অনুমানযোগ্য PIN গ্রহণযোগ্য নয়।');
      return res.redirect('/profile/security');
    }

    const u = await pool.query('SELECT password FROM users WHERE id=$1', [userId]);
    if (!u.rows[0] || !(await bcrypt.compare(accountPassword || '', u.rows[0].password))) {
      req.flash('error', '❌ অ্যাকাউন্ট পাসওয়ার্ড ভুল।');
      return res.redirect('/profile/security');
    }

    await updatePin(userId, newPin, req.ip, 'reset');
    await logAdminAction(userId, req.session.user.username, 'WITHDRAW_PIN_RESET', `ইউজার #${userId} নিজের Withdraw PIN রিসেট করেছে`, req.ip);
    req.flash('success', '✅ Withdraw PIN রিসেট হয়েছে!');
    res.redirect('/profile/security');
  } catch (err) {
    console.error('withdraw-pin reset error:', err.message);
    req.flash('error', '❌ PIN রিসেট করতে সমস্যা হয়েছে।');
    res.redirect('/profile/security');
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
router.get('/wheel', isAuth, async (req, res) => {
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
const claimLimiter = createLimiter('claim', {
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.session && req.session.user ? String(req.session.user.id) : req.ip),
  handler: (req, res) => {
    res.status(429).json({ ok: false, success: false, message: 'অনেকবার চেষ্টা করেছেন, একটু পরে আবার চেষ্টা করুন।' });
  }
});

router.post('/wheel/spin', isAuth, claimLimiter, async (req, res) => {
  try {
    const result = await spin(req.session.user.id);
    res.json(result);
  } catch (err) {
    console.error('wheel spin error:', err.message);
    res.json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// ==================== ডেইলি মিশন ====================
router.get('/missions', isAuth, async (req, res) => {
  try {
    const missions = await getMissions(req.session.user.id);
    res.render('profile/missions', { user: req.session.user, missions });
  } catch (err) {
    console.error('missions page error:', err.message);
    res.render('profile/missions', { user: req.session.user, missions: { daily: [], weekly: [], special: [] } });
  }
});

router.post('/missions/claim/:id', isAuth, async (req, res) => {
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
router.get('/rewards', isAuth, async (req, res) => {
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
router.get('/daily-rewards/status', isAuth, async (req, res) => {
  try {
    const status = await getRewardStatus(req.session.user.id);
    res.json({ ok: true, status });
  } catch (err) {
    console.error('daily-rewards status error:', err.message);
    res.json({ ok: false });
  }
});

router.post('/daily-rewards/red-packet/claim', isAuth, claimLimiter, async (req, res) => {
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

router.post('/daily-rewards/golden-egg/claim', isAuth, claimLimiter, async (req, res) => {
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
router.get('/cashback', isAuth, async (req, res) => {
  try {
    const cashback = await getCashbackStatus(req.session.user.id);
    res.render('profile/cashback', { user: req.session.user, cashback });
  } catch (err) {
    console.error('cashback page error:', err.message);
    res.render('profile/cashback', { user: req.session.user, cashback: null });
  }
});

router.post('/cashback/claim', isAuth, async (req, res) => {
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
router.get('/vip', isAuth, async (req, res) => {
  try {
    const vip = await getVipStatus(req.session.user.id);
    res.render('profile/vip', { user: req.session.user, vip });
  } catch (err) {
    console.error('vip page error:', err.message);
    res.render('profile/vip', { user: req.session.user, vip: null });
  }
});

// VIP প্রোগ্রেস — লাইভ AJAX আপডেটের জন্য (০ থেকে ১০০০ স্কেল)
router.get('/api/vip-progress', isAuth, async (req, res) => {
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
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি' });
  }
});

// ==================== রেফারেল ====================
router.get('/referral', isAuth, async (req, res) => {
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
      'SELECT id, user_id, amount, type, description, created_at FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
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
      'SELECT id, user_id, amount, type, description, created_at FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
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
      'SELECT id, user_id, bank_name, account_number, account_name, is_default, created_at FROM bank_cards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.user.id]
    );
    res.render('profile/cards', { user: req.session.user, cards: result.rows });
  } catch (err) {
    res.render('profile/cards', { user: req.session.user, cards: [] });
  }
});

router.post('/cards/add', isAuth, accountSecurityLimiter, async (req, res) => {
  try {
    const { bank_name, account_number, holder_name } = req.body;
    await pool.query(
      'INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1,$2,$3,$4)',
      [req.session.user.id, bank_name, account_number, holder_name]
    );
    req.flash('success', '✅ কার্ড যোগ করা হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ কার্ড যোগ করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/cards');
});

router.post('/cards/delete/:id', isAuth, accountSecurityLimiter, async (req, res) => {
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

// ==================== সাপোর্ট সেন্টার — একটাই এন্ট্রি পয়েন্ট, বিদ্যমান /chat, /notifications, /profile/feedback রিইউজ করে ====================
router.get('/support', isAuth, (req, res) => {
  res.render('profile/support', { user: req.session.user });
});

router.get('/feedback', isAuth, (req, res) => {
  res.render('profile/feedback', { user: req.session.user });
});

router.post('/feedback', isAuth, async (req, res) => {
  try {
    const { message } = req.body;

    // ==== কনটেন্ট ফিল্টার — গালাগালি/অশ্লীল/১৮+ কনটেন্ট ব্লক ====
    const check = checkContent(message);
    if (check.flagged) {
      req.flash('error', '❌ আপনার লেখায় অনুপযুক্ত/অশ্লীল কনটেন্ট শনাক্ত হয়েছে। অনুগ্রহ করে সংশোধন করে আবার চেষ্টা করুন।');
      return res.redirect('/profile/feedback');
    }

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
router.get('/freebet', isAuth, async (req, res) => {
  try {
    const freebets = await getAllFreeBets(req.session.user.id);
    res.render('profile/freebet', { user: req.session.user, freebets });
  } catch (err) {
    console.error('freebet page error:', err.message);
    res.render('profile/freebet', { user: req.session.user, freebets: [] });
  }
});

router.post('/freebet/claim/:id', isAuth, async (req, res) => {
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
