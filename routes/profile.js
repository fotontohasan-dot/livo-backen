const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { getTodayReward, claimDailyReward } = require('../services/dailyReward');
const { getReferralStats } = require('../services/referral');
const { getCashbackStatus, claimCashback } = require('../services/cashback');
const { getVipStatus } = require('../services/vip');
const { getMissions, claimMission } = require('../services/missions');
const { getSegments, canSpin, spin } = require('../services/wheel');
const { getLoyalty, redeemPoints } = require('../services/loyalty');
const { getStreak } = require('../services/streak');
const { getBadges } = require('../services/badges');
const { getAllFreeBets, claimFreeBet } = require('../services/freebet');
const { getWeeklyStatus, claimWeekly, getMonthlyStatus, claimMonthly } = require('../services/periodicReward');
const { getShareStatus, claimShare } = require('../services/social');
const { getLeaderboard } = require('../services/contest');
const { getRewardStatus, claimRedPacket, claimGoldenEgg } = require('../services/redpacket');


router.get('/', isAuth, async (req, res) => {
  try {
    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
    const predictions = await pool.query(`
      SELECT p.*, m.title, m.team_a, m.team_b, m.result
      FROM predictions p
      JOIN matches m ON p.match_id = m.id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC LIMIT 10
    `, [req.session.user.id]);

    const tournaments = await pool.query(`
      SELECT
        COALESCE(t.name, 'টুর্নমেন্ট') as name,
        COALESCE(t.sport, 'General') as sport,
        COALESCE(tp.points, 0) as points,
        tp.joined_at as joined_at
      FROM tournament_participants tp
      JOIN tournaments t ON tp.tournament_id = t.id
      WHERE tp.user_id = $1
      ORDER BY tp.joined_at DESC
    `, [req.session.user.id]);

    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN status='won' THEN 1 END) as won,
        COALESCE(SUM(CASE WHEN status='won' THEN points_earned ELSE 0 END), 0) as total_earned
      FROM predictions
      WHERE user_id = $1
    `, [req.session.user.id]);

    res.render('profile/index', {
      user: user.rows[0],
      profileUser: user.rows[0],
      predictions: predictions.rows,
      tournaments: tournaments.rows,
      stats: stats.rows[0]
    });
  } catch (err) {
    console.error('Profile error:', err);
    req.flash('error', 'প্রোফাইল লোড করতে সমস্যা হয়েছে।');
    res.redirect('/');
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

    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
    if (!(await bcrypt.compare(cp, user.rows[0].password))) {
      req.flash('error', '❌ বর্তমান পাসওয়ার্ড ভুল।');
      return res.redirect('/profile/security');
    }
    const hashed = await bcrypt.hash(np, 10);
    await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hashed, req.session.user.id]);
    req.flash('success', '✅ পাসওয়ার্ড পরিবর্তন হয়েছে!');
    res.redirect('/profile/security');
  } catch (err) {
    req.flash('error', '❌ পাসওয়ার্ড পরিবর্তন করতে সমস্যা হয়েছে।');
    res.redirect('/profile/security');
  }
});

router.get('/history', isAuth, async (req, res) => {
  try {
    const predictions = await pool.query(`
      SELECT p.*, m.title FROM predictions p
      JOIN matches m ON p.match_id = m.id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
    `, [req.session.user.id]);
    res.render('profile/history', { predictions: predictions.rows, user: req.session.user });
  } catch (err) {
    req.flash('error', 'ইতিহাস লোড করতে সমস্যা হয়েছে।');
    res.redirect('/profile');
  }
});

router.get('/stats', isAuth, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN status='won' THEN 1 END) as won,
        COALESCE(SUM(CASE WHEN status='won' THEN points_earned ELSE 0 END), 0) as total_earned
      FROM predictions WHERE user_id=$1
    `, [req.session.user.id]);
    res.render('profile/stats', { stats: stats.rows[0], user: req.session.user });
  } catch (err) {
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
    res.render('profile/wheel', { user: req.session.user, segments, status });
  } catch (err) {
    console.error('wheel page error:', err.message);
    res.render('profile/wheel', { user: req.session.user, segments: [], status: { canSpin: false } });
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
router.get('/missions', isAuth, async (req, res) => {
  try {
    const missions = await getMissions(req.session.user.id);
    res.render('profile/missions', { user: req.session.user, missions });
  } catch (err) {
    console.error('missions page error:', err.message);
    res.render('profile/missions', { user: req.session.user, missions: [] });
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

router.post('/daily-rewards/red-packet/claim', isAuth, async (req, res) => {
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

router.post('/daily-rewards/golden-egg/claim', isAuth, async (req, res) => {
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
    res.render('profile/cards', { user: req.session.user, cards: result.rows });
  } catch (err) {
    res.render('profile/cards', { user: req.session.user, cards: [] });
  }
});

router.post('/cards/add', isAuth, async (req, res) => {
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
    res.render('profile/loyalty', { user: req.session.user, loyalty });
  } catch (err) {
    console.error('loyalty page error:', err.message);
    res.render('profile/loyalty', { user: req.session.user, loyalty: null });
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
    res.render('profile/contest', { user: req.session.user, contest });
  } catch (err) {
    console.error('contest page error:', err.message);
    res.render('profile/contest', { user: req.session.user, contest: null });
  }
});

module.exports = router;
