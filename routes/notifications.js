const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/', isAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read=true WHERE user_id=$1`, [req.session.user.id]);
    const notifs = await pool.query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.session.user.id]);
    res.render('notifications', { notifications: notifs.rows });
  } catch (err) {
    res.render('notifications', { notifications: [] });
  }
});

router.get('/count', isAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false`, [req.session.user.id]);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.json({ count: 0 });
  }
});

module.exports = router;
