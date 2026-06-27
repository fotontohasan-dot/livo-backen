const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { getTodayReward, claimDailyReward } = require('../services/dailyReward');
const { getReferralStats } = require('../services/referral');
const { getCashbackStatus, claimCashback } = require('../services/cashback');
const { getVipStatus } = require('../services/vip');

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
        COALESCE(t.name, 'টুর্নামেন্ট') as name,
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
    req.flash('success', '✅ তথ্য আপডেট হয়েছে!');
  } catch (err) {
    req.flash('error', '❌ আপডেট করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile/security');
});

router.post('/change-password', isAuth, async (req, res) => {
  try {
    const { current_password, new_password, currentPassword, newPassword, confirmPassword } = req.body;
    const cp = current_password || currentPassword;
    const np = new_password || newPassword;

    if (confirmPassword && np !== confirmPassword) {
      req.flash('error', '❌ নতুন পাসওয়ার্ড মিলছে না।');
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

router.get('/missions', isAuth, (req, res) => {
  res.render('profile/missions', { user: req.session.user });
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

// ==================== ক্যাশব্যাক ====================
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
    const result = await claimCashback(req.session.user.id);
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

module.exports = router;
