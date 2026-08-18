const express = require('express');
const router = express.Router();
const path = require('path');
const { pool } = require('../db');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { notifyUserSeen, notifyAdminsSeen } = require('../services/socket');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const isAuth = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

// নোট: আগে এখানে শুধু req.session.user.role চেক হতো — ডিমোট করা অ্যাডমিনের পুরনো
// (স্টেল) সেশন দিয়েও অ্যাক্সেস করা যেত। এখন প্রতিটা রিকোয়েস্টে DB থেকে বর্তমান role
// যাচাই করা হয় (middleware/auth.js-এর isAdmin-এর একই প্যাটার্ন), এই রাউটারের সব
// admin এন্ডপয়েন্ট AJAX/JSON হওয়ায় আগের মতোই JSON 403 রেসপন্স রাখা হয়েছে।
const isAdmin = async (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(403).send('Access denied');
  }
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.user.id]);
    const currentRole = result.rows[0] && result.rows[0].role;
    if (currentRole !== 'admin') {
      req.session.destroy(() => {});
      return res.status(403).send('Access denied');
    }
    req.session.user.role = currentRole;
    return next();
  } catch (err) {
    console.error('chat isAdmin role check error:', err.message);
    return res.status(403).send('Access denied');
  }
};

// ==================== ফাইল আপলোড: শুধু নির্দিষ্ট image/video ফরম্যাট ====================
// তিন স্তরে যাচাই করা হয় — extension, browser-reported MIME type, এবং magic byte
// (ফাইলের প্রকৃত বাইনারি কনটেন্ট)। তিনটাই মিলতে হবে, নাহলে reject।
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm'];
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'];

// ফাইলের প্রথম কয়েক বাইট (magic number/signature) দেখে প্রকৃত ফাইল টাইপ শনাক্ত করে —
// শুধু extension বা Content-Type header বদলে দিলে এটা ফাঁকি দেওয়া যায় না।
function detectMagicBytes(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) return 'image/png';

  // WEBP: 'RIFF' <4 byte size> 'WEBP'
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp';

  // WebM/Matroska EBML হেডার: 1A 45 DF A3
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return 'video/webm';

  // MP4/MOV (ISO base media container): অফসেট 4-7 এ 'ftyp' বক্স
  if (
    buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70
  ) {
    const brand = buffer.subarray(8, 12).toString('ascii');
    return brand.toLowerCase().startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }

  return null;
}

// extension আর magic-byte দিয়ে শনাক্ত হওয়া প্রকৃত টাইপ একই পরিবারের কিনা যাচাই —
// mp4/mov একই container ফরম্যাট শেয়ার করে বলে ftyp brand সবসময় নির্ভরযোগ্যভাবে আলাদা করা যায় না,
// তাই এই দুটোকে একে অপরের জন্য গ্রহণযোগ্য ধরা হয়েছে (তবে ছবি/ভিডিও আলাদা পরিবারের মধ্যে কখনো মেলে না)।
function extensionMatchesDetectedType(ext, detectedMime) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
  const videoExts = ['.mp4', '.mov', '.webm'];
  if (imageExts.includes(ext)) {
    if (ext === '.jpg' || ext === '.jpeg') return detectedMime === 'image/jpeg';
    if (ext === '.png') return detectedMime === 'image/png';
    if (ext === '.webp') return detectedMime === 'image/webp';
  }
  if (videoExts.includes(ext)) {
    if (ext === '.webm') return detectedMime === 'video/webm';
    if (ext === '.mp4' || ext === '.mov') return detectedMime === 'video/mp4' || detectedMime === 'video/quicktime';
  }
  return false;
}

// একটা কথোপকথনে সর্বোচ্চ কতগুলো মেসেজ ফেরত যাবে (সবচেয়ে সাম্প্রতিকগুলো)
const MAX_HISTORY_MESSAGES = 500;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('শুধু jpg, jpeg, png, webp, mp4, mov, webm ফাইল আপলোড করা যাবে'));
    }
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('অসমর্থিত ফাইল টাইপ'));
    }
    cb(null, true);
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
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const detectedMime = detectMagicBytes(req.file.buffer);

    // ফাইলের প্রকৃত বাইনারি কনটেন্ট (magic byte) allowlist-এর কোনো ফরম্যাটের সাথেই না মিললে,
    // অথবা extension যা দাবি করছে তার সাথে প্রকৃত কনটেন্ট না মিললে — reject।
    // এভাবে কেউ malicious ফাইলের নাম/এক্সটেনশন/Content-Type বদলে ফাঁকি দিতে পারবে না।
    if (!detectedMime || !extensionMatchesDetectedType(ext, detectedMime)) {
      return res.status(400).json({ error: 'ফাইলের প্রকৃত কনটেন্ট অনুমোদিত ফরম্যাটের (jpg, jpeg, png, webp, mp4, mov, webm) সাথে মেলেনি' });
    }

    const isVideo = detectedMime.startsWith('video');
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
    // সার্ভার-সাইড বাউন্ড: আগে পুরো কথোপকথন LIMIT ছাড়াই ফেরত যেত, তাই দীর্ঘদিনের
    // চ্যাটে রেসপন্স অনির্দিষ্টভাবে বড় হতে পারত। সবচেয়ে সাম্প্রতিক MAX_HISTORY_MESSAGES
    // টা নেওয়া হয়, তারপর আগের মতোই পুরনো→নতুন ক্রমে সাজিয়ে দেওয়া হয় — রেসপন্সের
    // আকার (প্লেইন অ্যারে) ও ক্রম অপরিবর্তিত, তাই ফ্রন্টএন্ড কনট্র্যাক্ট ভাঙে না।
    const result = await pool.query(
      `SELECT * FROM (
         SELECT * FROM chat_messages
          WHERE sender_id = $1 OR receiver_id = $1
          ORDER BY created_at DESC
          LIMIT $2
       ) t ORDER BY created_at ASC`,
      [userId, MAX_HISTORY_MESSAGES]
    );
    const upd = await pool.query(
      `UPDATE chat_messages SET is_read = true WHERE receiver_id = $1 AND is_admin = true AND is_read = false`,
      [userId]
    );
    if (upd.rowCount > 0) notifyAdminsSeen(userId);
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
        lm.file_url AS last_file_url,
        lm.is_admin AS last_is_admin,
        COALESCE(uc.unread, 0) AS unread_count
      FROM users u
      JOIN LATERAL (
        SELECT message, created_at, file_url, is_admin
        FROM chat_messages
        WHERE sender_id = u.id OR receiver_id = u.id
        ORDER BY created_at DESC
        LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unread
        FROM chat_messages
        WHERE sender_id = u.id AND is_admin = false AND is_read = false
      ) uc ON true
      WHERE u.role != 'admin'
      ORDER BY lm.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('admin/conversations error:', err.message);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

router.get('/admin/history/:userId', isAdmin, async (req, res) => {
  try {
    // উপরের /history-এর মতোই বাউন্ড
    const result = await pool.query(
      `SELECT * FROM (
         SELECT * FROM chat_messages
          WHERE sender_id = $1 OR receiver_id = $1
          ORDER BY created_at DESC
          LIMIT $2
       ) t ORDER BY created_at ASC`,
      [req.params.userId, MAX_HISTORY_MESSAGES]
    );
    const upd = await pool.query(
      `UPDATE chat_messages SET is_read = true WHERE sender_id = $1 AND is_admin = false AND is_read = false`,
      [req.params.userId]
    );
    if (upd.rowCount > 0) notifyUserSeen(req.params.userId);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

// multer fileFilter/সাইজ-লিমিট থেকে আসা error যেন JSON 400 হিসেবে ফেরত যায়
// (global HTML error page-এর বদলে, যেহেতু ফ্রন্টএন্ড JSON আশা করে)
router.use((err, req, res, next) => {
  if (req.path === '/upload') {
    return res.status(400).json({ error: err.message || 'আপলোড ব্যর্থ হয়েছে' });
  }
  next(err);
});

module.exports = router;
