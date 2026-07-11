const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const isAuth = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).send('Access denied');
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|mp4|webm|mov/;
    if (allowed.test(file.originalname.toLowerCase())) return cb(null, true);
    cb(new Error('শুধু image/video আপলোড করা যাবে'));
  }
});

router.get('/', isAuth, (req, res) => {
  res.render('profile/chat', { user: req.session.user });
});

router.get('/admin', isAdmin, (req, res) => {
  res.render('admin/chat', { user: req.session.user });
});

router.post('/upload', isAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ফাইল পাওয়া যায়নি' });
  try {
    const isVideo = req.file.mimetype.startsWith('video');
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'livo/chat', resource_type: isVideo ? 'video' : 'image' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    res.json({ url: result.secure_url, fileType: isVideo ? 'video' : 'image' });
  } catch (err) {
    console.error('Cloudinary error:', err);
    res.status(500).json({ error: 'আপলোড ব্যর্থ হয়েছে' });
  }
});

router.get('/history', isAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    // ইউজার নিজের চ্যাট ওপেন করলে অ্যাডমিনের পাঠানো মেসেজগুলো "সিন" হিসেবে মার্ক হবে
    await pool.query(
      `UPDATE chat_messages SET is_read = true WHERE receiver_id = $1 AND is_admin = true AND is_read = false`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

router.get('/admin/conversations', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username,
        lm.message AS last_message,
        lm.created_at AS last_message_time,
        lm.is_admin AS last_message_is_admin,
        COALESCE(unread.cnt, 0) AS unread_count
      FROM users u
      JOIN LATERAL (
        SELECT message, created_at, is_admin
        FROM chat_messages
        WHERE sender_id = u.id OR receiver_id = u.id
        ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt FROM chat_messages
        WHERE sender_id = u.id AND is_admin = false AND is_read = false
      ) unread ON true
      WHERE u.role != 'admin'
      ORDER BY lm.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

router.get('/admin/stats', isAdmin, async (req, res) => {
  try {
    const totalConversations = await pool.query(`
      SELECT COUNT(DISTINCT CASE WHEN is_admin THEN receiver_id ELSE sender_id END) AS cnt
      FROM chat_messages
    `);
    const activeChats = await pool.query(`
      SELECT COUNT(DISTINCT CASE WHEN is_admin THEN receiver_id ELSE sender_id END) AS cnt
      FROM chat_messages WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    const pendingReplies = await pool.query(`
      SELECT COUNT(DISTINCT sender_id) AS cnt FROM chat_messages WHERE is_admin = false AND is_read = false
    `);
    const resolvedToday = await pool.query(`
      SELECT COUNT(DISTINCT sub.uid) AS cnt FROM (
        SELECT CASE WHEN is_admin THEN receiver_id ELSE sender_id END AS uid,
          (ARRAY_AGG(is_admin ORDER BY created_at DESC))[1] AS last_is_admin,
          MAX(created_at) AS last_at
        FROM chat_messages
        GROUP BY uid
      ) sub
      WHERE sub.last_is_admin = true AND sub.last_at::date = CURRENT_DATE
    `);
    res.json({
      totalConversations: parseInt(totalConversations.rows[0].cnt),
      activeChats: parseInt(activeChats.rows[0].cnt),
      pendingReplies: parseInt(pendingReplies.rows[0].cnt),
      resolvedToday: parseInt(resolvedToday.rows[0].cnt)
    });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

router.get('/admin/history/:userId', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1 ORDER BY created_at ASC',
      [req.params.userId]
    );
    await pool.query(
      `UPDATE chat_messages SET is_read = true WHERE sender_id = $1 AND is_admin = false AND is_read = false`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

module.exports = router;
