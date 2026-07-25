const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

// নোটিফিকেশন হিস্টোরি — GET করলে আর সবগুলো অটো-রিড হয়ে যায় না (আগে এই বাগ ছিল),
// শুধু তালিকা দেখায়; রিড করানো এখন explicit mark-as-read এন্ডপয়েন্ট দিয়ে হয়।
router.get('/', isAuth, async (req, res) => {
  try {
    const notifs = await pool.query(
      `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.session.user.id]
    );
    res.render('notifications', { notifications: notifs.rows });
  } catch (err) {
    console.error('notifications list error:', err.message);
    res.render('notifications', { notifications: [] });
  }
});

// আনরিড কাউন্ট (নেভবারের বেল আইকনে ব্যবহার হয়)
router.get('/count', isAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false`,
      [req.session.user.id]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// একটা নির্দিষ্ট নোটিফিকেশন রিড হিসেবে মার্ক করা (মালিকানা যাচাই করে)
router.post('/:id/read', isAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'অবৈধ আইডি' });
    }
    const result = await pool.query(
      `UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2 RETURNING id`,
      [id, req.session.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'পাওয়া যায়নি' });
    res.json({ success: true });
  } catch (err) {
    console.error('mark-read error:', err.message);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি' });
  }
});

// সব নোটিফিকেশন একসাথে রিড হিসেবে মার্ক করা
router.post('/read-all', isAuth, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false`, [req.session.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('mark-all-read error:', err.message);
    res.status(500).json({ success: false, error: 'সার্ভার ত্রুটি' });
  }
});

module.exports = router;
