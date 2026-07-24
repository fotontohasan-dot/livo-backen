// routes/health.js
// ---------------------------------------------------------------------------
// আপটাইম মনিটর (Render, UptimeRobot ইত্যাদি) এবং orchestrator-দের জন্য
// পাবলিক health check endpoint। কোনো অথেনটিকেশন লাগে না (uptime monitor
// সাধারণত session/cookie পাঠাতে পারে না), তাই সংবেদনশীল কোনো তথ্য এখানে
// প্রকাশ করা হয় না — শুধু OK/FAIL স্ট্যাটাস।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const healthCheck = require('../services/healthCheck');
const { pool } = require('../db');

// /health — পুরো সিস্টেমের সংক্ষিপ্ত স্বাস্থ্য প্রতিবেদন (লোড ব্যালেন্সার/আপটাইম মনিটরের জন্য)
router.get('/health', async (req, res) => {
  try {
    const result = await healthCheck.runAllChecks();
    const httpStatus = result.overall === 'error' ? 503 : 200;

    res.status(httpStatus).json({
      status: result.overall,
      timestamp: result.timestamp,
      uptime: result.checks.uptime.message,
      checks: Object.fromEntries(
        Object.entries(result.checks).map(([key, val]) => [key, { status: val.status, message: val.message }])
      )
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Health check নিজেই ব্যর্থ হয়েছে', error: err.message });
  }
});

// /ready — readiness probe: শুধু DB সংযোগ আছে কিনা দ্রুত যাচাই করে (orchestrator ট্রাফিক পাঠানোর আগে)
router.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ ready: true });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

module.exports = router;
