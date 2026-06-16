const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');

const isAuth = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).send('Access denied');
};

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/chat');
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|mp4|webm|mov/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    if (ext) return cb(null, true);
    cb(new Error('শুধু image/video ফাইল আপলোড করা যাবে'));
  }
});

// User chat page
router.get('/', isAuth, (req, res) => {
  res.render('profile/chat', { user: req.session.user });
});

// Admin chat page
router.get('/admin', isAdmin, (req, res) => {
  res.render('admin/chat', { user: req.session.user });
});

// File upload route
router.post('/upload', isAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ফাইল পাওয়া যায়নি' });
  const url = '/uploads/chat/' + req.file.filename;
  res.json({ url });
});

// User chat history
router.get('/history', isAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

// Admin: all conversations
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
    console.error(err);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

// Admin: specific user history
router.get('/admin/history/:userId', isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

module.exports = router;
