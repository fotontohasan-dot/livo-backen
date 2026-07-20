const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const cache = require('../services/cache');

router.get('/', async (req, res) => {
  try {
    const users = await cache.getOrSet('leaderboard:top50', 45, async () => {
      const result = await pool.query(`
        SELECT
          id, username, avatar, total_points, coins,
          (SELECT COUNT(*) FROM predictions WHERE user_id=users.id AND status='won') as wins,
          (SELECT COUNT(*) FROM predictions WHERE user_id=users.id) as total_bets
        FROM users
        WHERE role='user' AND is_banned=false
        ORDER BY total_points DESC
        LIMIT 50
      `);
      return result.rows;
    });
    res.render('leaderboard', { users });
  } catch (err) {
    console.error('Leaderboard error:', err);
    req.flash('error', 'লিডারবোর্ড লোড করতে সমস্যা হয়েছে।');
    res.render('leaderboard', { users: [] });
  }
});

module.exports = router;
