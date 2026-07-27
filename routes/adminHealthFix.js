const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');

// এই রুট app.js-এ admin.js-এর আগে মাউন্ট হয় — পুরনো duplicate/broken হ্যান্ডলার এড়ানো যায়
router.get('/system-diagnostics', isAdmin, async (req, res) => {
  try {
    const healthCheck = require('../services/healthCheck');
    const result = await healthCheck.runAllChecks();
    res.render('admin/system-diagnostics', {
      result,
      diagnostics: result,
      error: null,
      user: req.session.user
    });
  } catch (err) {
    console.error('System diagnostics error:', err.message);
    res.render('admin/system-diagnostics', {
      result: null,
      diagnostics: null,
      error: err.message || 'ডায়াগনস্টিক চালাতে সমস্যা হয়েছে',
      user: req.session.user
    });
  }
});

router.get('/api/system-diagnostics', isAdmin, async (req, res) => {
  try {
    const healthCheck = require('../services/healthCheck');
    const result = await healthCheck.runAllChecks();
    res.json({ success: true, diagnostics: result, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
