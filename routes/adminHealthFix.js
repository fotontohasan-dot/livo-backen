const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const rbac = require('../services/rbac');

// PHASE 4 fix: এই route গুলো infrastructure diagnostics (DB/Redis/queue/email/
// disk/memory) প্রকাশ করে। আগে শুধু isAdmin ছিল, ফলে সীমিত permission-এর
// admin-ও পুরো system state দেখতে পেত। super_admin অপরিবর্তিতভাবে access পায়।

// এই রুট app.js-এ admin.js-এর আগে মাউন্ট হয় — পুরনো duplicate/broken হ্যান্ডলার এড়ানো যায়
router.get('/system-diagnostics', isAdmin, rbac.requirePermission('system_diagnostics_view'), async (req, res) => {
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
    // err.message-এ DB/Redis কানেকশন স্ট্রিং, হোস্ট/পোর্ট ও ফাইল পাথ চলে আসত — সেটা
    // পেজে রেন্ডার না করে শুধু সার্ভার লগে রাখা হয়।
    console.error('System diagnostics error:', err && err.stack ? err.stack : err);
    res.render('admin/system-diagnostics', {
      loadError: true,
      result: null,
      diagnostics: null,
      error: req.t('admin_diagnostic_failed_log'),
      user: req.session.user
    });
  }
});

// ==================== Step 3: Integrations Status (শুধু অ্যাডমিন) ====================
// প্রতিটা ইন্টিগ্রেশনের configured (web/worker আলাদা), শেষ সফল/ব্যর্থ সময়, sanitize করা error ও breaker অবস্থা।
// কোনো গোপন মান বা তার অংশ কখনো পেজ/JSON-এ যায় না (services/integrationStatus.js)।
router.get('/integrations', isAdmin, rbac.requirePermission('system_diagnostics_view'), async (req, res) => {
  try {
    const report = await require('../services/integrationStatus').buildStatusReport();
    res.render('admin/integrations', { report, user: req.session.user });
  } catch (err) {
    console.error('Integrations page error:', err && err.stack ? err.stack : err);
    res.render('admin/integrations', { report: { integrations: [], processes: [] }, loadError: true, user: req.session.user });
  }
});

router.get('/api/integrations', isAdmin, rbac.requirePermission('system_diagnostics_view'), async (req, res) => {
  try {
    res.json({ success: true, report: await require('../services/integrationStatus').buildStatusReport() });
  } catch (err) {
    console.error('Integrations API error:', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, error: 'integrations_status_failed' });
  }
});

router.get('/api/system-diagnostics', isAdmin, rbac.requirePermission('system_diagnostics_view'), async (req, res) => {
  try {
    const healthCheck = require('../services/healthCheck');
    const result = await healthCheck.runAllChecks();
    res.json({ success: true, diagnostics: result, result });
  } catch (err) {
    console.error('System diagnostics API error:', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, error: req.t('admin_diagnostic_failed_dot') });
  }
});

module.exports = router;
