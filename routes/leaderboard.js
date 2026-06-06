const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT
        id, username, avatar, total_points, coins,
        (SELECT COUNT(*) FROM predictions WHERE user_id=users.id AND status='won') as wins,
        (SELECT COUNT(*) FROM predictions WHERE user_id=users.id) as total_bets
      FROM users
      WHERE role='user' AND is_banned=false
      ORDER BY total_points DESC
      LIMIT 50
    `);
    res.render('leaderboard', { users: users.rows });
  } catch (err) {
    console.error('Leaderboard error:', err);
    req.flash('error', 'লিডারবোর্ড লোড করতে সমস্যা হয়েছে।');
    res.render('leaderboard', { users: [] });
  }
});

module.exports = router;
