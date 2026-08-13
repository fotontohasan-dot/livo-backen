// middleware/metricsAuth.js
// /metrics এন্ডপয়েন্ট শুধুমাত্র Admin/Internal অ্যাক্সেসের জন্য। Prometheus স্ক্র্যাপার সাধারণত
// কুকি/সেশন পাঠাতে পারে না, তাই লগইন-করা অ্যাডমিন সেশন ছাড়াও একটা internal token সাপোর্ট করা হয়েছে
// (METRICS_TOKEN env var, Docker/internal network-এ scrape করার জন্য)। কোনোটাই না মিললে 401 — কখনো
// রিডাইরেক্ট করে না, যাতে monitoring টুল সরাসরি স্ট্যাটাস কোড বুঝতে পারে।

const crypto = require('crypto');
const { pool } = require('../db');

/** টোকেন তুলনা constant-time-এ — সাধারণ === তুলনায় প্রতি-বাইট টাইমিং পার্থক্য থেকে
 *  টোকেন ধীরে ধীরে অনুমান করে ফেলা তাত্ত্বিকভাবে সম্ভব। দৈর্ঘ্য ফাঁস হওয়া ঠেকাতে দুই পাশের
 *  SHA-256 ডাইজেস্ট তুলনা করা হয় (সবসময় সমান ৩২ বাইট)। */
function safeTokenEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function requireMetricsAccess(req, res, next) {
  try {
    // ১) Internal token — শুধুমাত্র METRICS_TOKEN সেট করা থাকলেই এই পথ সক্রিয় হয়
    const configuredToken = process.env.METRICS_TOKEN;
    if (configuredToken) {
      const provided = req.headers['x-metrics-token'] || (req.query && req.query.token);
      if (safeTokenEquals(provided, configuredToken)) {
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
