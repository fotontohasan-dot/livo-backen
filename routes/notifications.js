const express = require('express');
const router = express.Router();
const { requireFeature } = require('../middleware/featureGate');

// পুরো রাউটারে ফিচার গেট — নির্দিষ্ট রুট নয়, রাউটার-লেভেলে বসানো হয়েছে
// যাতে ভবিষ্যতে যোগ হওয়া সাব-রুটও আপনাআপনি সুরক্ষিত থাকে, আর সরাসরি
// URL দিয়ে কোনো পথ বাদ পড়ে না যায়।
router.use(requireFeature('notifications'));

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

// ===== মেম্বার সেন্টার আইকন ব্যাজ =====
// পেজ লোডের সময় প্রাথমিক ব্যাজ সংখ্যা আনতে ব্যবহৃত হয় (রিওয়ার্ড সেন্টার/মিশন/ইনটারনাল
// মেসেজ + প্রোফাইল আইকনের মাস্টার টোটাল)। এরপর WebSocket-এর 'badges:update' ইভেন্ট
// রিয়েল-টাইমে এই সংখ্যাগুলো আপডেট রাখে।
router.get('/badges', isAuth, async (req, res) => {
  try {
    const { getBadgeCounts } = require('../services/notify');
    const counts = await getBadgeCounts(req.session.user.id);
    res.json(counts);
  } catch (err) {
    res.json({ reward: 0, mission: 0, message: 0, total: 0 });
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
