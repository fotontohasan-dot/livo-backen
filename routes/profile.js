const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

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
        COALESCE(t.name, t.title, 'টুর্নামেন্ট') as name,
        COALESCE(t.sport, 'General') as sport,
        COALESCE(tp.points, 0) as points,
        COALESCE(tp.joined_at, tp.created_at) as joined_at
      FROM tournament_participants tp
      JOIN tournaments t ON tp.tournament_id = t.id
      WHERE tp.user_id = $1
      ORDER BY tp.created_at DESC
    `, [req.session.user.id]);

    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN status='won' THEN 1 END) as won,
        COALESCE(SUM(CASE WHEN status='won' THEN points_earned ELSE 0 END), 0) as total_earned
      FROM predictions
      WHERE user_id = $1
    `, [req.session.user.id]);

    res.render('profile', {
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

router.post('/change-password', isAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
    if (!(await bcrypt.compare(current_password, user.rows[0].password))) {
      req.flash('error', 'বর্তমান পাসওয়ার্ড ভুল।');
      return res.redirect('/profile');
    }
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hashed, req.session.user.id]);
    req.flash('success', 'পাসওয়ার্ড পরিবর্তন হয়েছে!');
  } catch (err) {
    req.flash('error', 'পাসওয়ার্ড পরিবর্তন করতে সমস্যা হয়েছে।');
  }
  res.redirect('/profile');
});

router.get('/history', isAuth, async (req, res) => {
  try {
    const predictions = await pool.query(`
      SELECT p.*, m.title FROM predictions p
      JOIN matches m ON p.match_id = m.id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
    `, [req.session.user.id]);
    res.render('profile/history', { predictions: predictions.rows });
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
    res.render('profile/stats', { stats: stats.rows[0] });
  } catch (err) {
    req.flash('error', 'স্ট্যাটস লোড করতে সমস্যা হয়েছে।');
    res.redirect('/profile');
  }
});

router.get('/security', isAuth, (req, res) => res.render('profile/security'));
router.get('/missions', isAuth, (req, res) => res.render('profile/missions'));
router.get('/chat', isAuth, (req, res) => res.render('profile/chat'));

module.exports = router;
