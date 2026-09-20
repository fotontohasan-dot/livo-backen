const express = require('express');
const router = express.Router();
const { getActiveForUser } = require('../services/announcements');

// GET /api/ticker/active -> bk666-স্টাইল স্ক্রলিং টিকার বার (bell + scroll text)
// বিদ্যমান announcements সিস্টেম (type='scrolling') পুনর্ব্যবহার করা হয়েছে —
// getActiveForUser() টার্গেটিং (all/role/user), starts_at/expires_at সবকিছু
// আগে থেকেই হ্যান্ডেল করে, তাই এখানে ডুপ্লিকেট কোয়েরি লেখা হয়নি।
router.get('/active', async (req, res) => {
  try {
    const rows = await getActiveForUser(req.session.user || null, 'scrolling');
    const lang = req.lang || 'bn';
    const notices = rows.map(a => ({
      id: a.id,
      message: lang === 'en' && a.message_en ? a.message_en : a.message_bn
    }));
    res.json({ notices });
  } catch (err) {
    console.error('ticker active error:', err.message);
    res.json({ notices: [] });
  }
});

module.exports = router;
