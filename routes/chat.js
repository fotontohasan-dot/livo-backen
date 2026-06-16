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
    const ext = allowed.test(file.originalname.toLowerCase());
    if (ext) return cb(null, true);
    cb(new Error('শুধু image/video ফাইল আপলড করা যাবে'));
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

// File upload via Cloudinary
router.post('/upload', isAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ফাইল পাওয়া যায়নি' });

  try {
    const isVideo = req.file.mimetype.startsWith('video');
    const resourceType = isVideo ? 'video' : 'image';

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'livo/chat', resource_type: resourceType },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({ url: result.secure_url, fileType: isVideo ? 'video' : 'image' });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ error: 'আপলোড ব্যর্থ হয়েছে' });
  }
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
    res.status(500).json({ error: 'সারর ত্রুটি' });
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
