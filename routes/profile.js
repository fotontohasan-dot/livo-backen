const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

router.get('/', isAuth, async (req, res) => {
  const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
  const predictions = await pool.query(`SELECT p.*, m.title, m.team_a, m.team_b, m.result FROM predictions p JOIN matches m ON p.match_id=m.id WHERE p.user_id=$1 ORDER BY p.created_at DESC LIMIT 10`, [req.session.user.id]);
  const tournaments = await pool.query(`SELECT t.name, t.sport, tp.points, tp.joined_at FROM tournament_participants tp JOIN tournaments t ON tp.tournament_id=t.id WHERE tp.user_id=$1 ORDER BY tp.joined_at DESC`, [req.session.user.id]);
  const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='won' THEN 1 END) as won, SUM(CASE WHEN status='won' THEN points_earned ELSE 0 END) as total_earned FROM predictions WHERE user_id=$1`, [req.session.user.id]);
  res.render('profile', { profileUser: user.rows[0], predictions: predictions.rows, tournaments: tournaments.rows, stats: stats.rows[0] });
});

router.post('/update', isAuth, async (req, res) => {
  const { username } = req.body;
  await pool.query(`UPDATE users SET username=$1 WHERE id=$2`, [username, req.session.user.id]);
  req.session.user.username = username;
  req.flash('success', 'Profile updated!');
  res.redirect('/profile');
});

router.post('/change-password', isAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.session.user.id]);
  if (!(await bcrypt.compare(current_password, user.rows[0].password))) {
    req.flash('error', 'Current password is wrong');
    return res.redirect('/profile');
  }
  const hashed = await bcrypt.hash(new_password, 10);
  await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hashed, req.session.user.id]);
  req.flash('success', 'Password changed!');
  res.redirect('/profile');
});

module.exports = router;
