const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Middleware to check if user is logged in
const isAuth = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    next();
  } else {
    res.status(403).send('অ্যাক্সেস অনুমোদিত নয়');
  }
};

// Render user chat page
router.get('/', isAuth, (req, res) => {
  res.render('profile/chat');
});

// Render admin chat page
router.get('/admin', isAdmin, (req, res) => {
  res.render('admin/chat');
});

// Get chat history for a specific user
router.get('/history', isAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching chat history:', err);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

// Get all users who have chatted (for admin)
router.get('/admin/conversations', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.username
      FROM users u
      JOIN chat_messages m ON u.id = m.sender_id OR u.id = m.receiver_id
      WHERE u.role != 'admin'
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

// Get chat history for a specific user (for admin)
router.get('/admin/history/:userId', isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching chat history for admin:', err);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

module.exports = router;
