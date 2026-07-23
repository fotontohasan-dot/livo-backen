// middleware/metricsAuth.js
// /metrics এন্ডপয়েন্ট শুধুমাত্র Admin/Internal অ্যাক্সেসের জন্য। Prometheus স্ক্র্যাপার সাধারণত
// কুকি/সেশন পাঠাতে পারে না, তাই লগইন-করা অ্যাডমিন সেশন ছাড়াও একটা internal token সাপোর্ট করা হয়েছে
// (METRICS_TOKEN env var, Docker/internal network-এ scrape করার জন্য)। কোনোটাই না মিললে 401 — কখনো
// রিডাইরেক্ট করে না, যাতে monitoring টুল সরাসরি স্ট্যাটাস কোড বুঝতে পারে।

const { pool } = require('../db');

async function requireMetricsAccess(req, res, next) {
  try {
    // ১) Internal token — শুধুমাত্র METRICS_TOKEN সেট করা থাকলেই এই পথ সক্রিয় হয়
    const configuredToken = process.env.METRICS_TOKEN;
    if (configuredToken) {
      const provided = req.headers['x-metrics-token'] || (req.query && req.query.token);
      if (provided && provided === configuredToken) {
        return next();
      }
    }

    // ২) লগইন করা অ্যাডমিন সেশন (ব্রাউজার থেকে সরাসরি /metrics দেখার জন্য)
    if (req.session && req.session.user) {
      const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.user.id]);
      if (result.rows[0] && result.rows[0].role === 'admin') {
        return next();
      }
    }

    res.status(401).type('text/plain').send('Unauthorized — admin session অথবা বৈধ X-Metrics-Token প্রয়োজন।');
  } catch (err) {
    console.error('[metricsAuth] error:', err.message);
    res.status(500).type('text/plain').send('Metrics access check failed.');
  }
}

module.exports = { requireMetricsAccess };
