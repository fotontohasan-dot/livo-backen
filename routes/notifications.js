const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const cache = require('../services/cache');

router.get('/', isAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read=true WHERE user_id=$1`, [req.session.user.id]);
    // invalidate count cache on read
    cache.del(`notif:count:${req.session.user.id}`).catch(() => {});
    const notifs = await pool.query(
      `SELECT id, user_id, title, message, type, is_read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [req.session.user.id]
    );
    res.render('notifications', { notifications: notifs.rows });
  } catch (err) {
    res.render('notifications', { notifications: [] });
  }
});

router.get('/count', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const count = await cache.getOrSet(`notif:count:${uid}`, 15, async () => {
      const r = await pool.query(
        `SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false`, [uid]
      );
      return parseInt(r.rows[0].count);
    });
    res.json({ count });
  } catch (err) {
    res.json({ count: 0 });
  }
});

module.exports = router;
