const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const cache = require('../services/cache');

router.get('/', async (req, res) => {
  try {
    const users = await cache.getOrSet('leaderboard:top50', 60, async () => {
      const result = await pool.query(`
        SELECT
          u.id, u.username, u.avatar, u.total_points, u.coins,
          COUNT(b.id) FILTER (WHERE b.status='won') AS wins,
          COUNT(b.id) AS total_bets
        FROM users u
        LEFT JOIN bets b ON b.user_id = u.id
        WHERE u.role='user' AND (u.is_banned IS NULL OR u.is_banned=false)
        GROUP BY u.id, u.username, u.avatar, u.total_points, u.coins
        ORDER BY u.total_points DESC
        LIMIT 50
      `);
      return result.rows;
    });
    res.render('leaderboard', { users });
  } catch (err) {
    console.error('Leaderboard error:', err);
    req.flash('error', req.t('leaderboard_load_failed'));
    res.render('leaderboard', { users: [] });
  }
});

module.exports = router;
