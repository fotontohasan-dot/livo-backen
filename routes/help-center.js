// routes/help-center.js
// ---------------------------------------------------------------------------
// "ব্যাটিং হেল্প সেন্টার" পেজ। ক্যাটাগরি থেকে ইউজার সরাসরি লাইভ এজেন্ট চ্যাটে (/chat) যান।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

// হেল্প সেন্টার পেজ রেন্ডার করবে
router.get('/', (req, res) => {
  res.render('help-center', {
    title: req.t('help_center_title'),
    user: (req.session && req.session.user) || null
  });
});

module.exports = router;
