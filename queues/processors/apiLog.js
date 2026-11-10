// queues/processors/apiLog.js
// middleware/apiLogger.js-এর পাঠানো লগ api_usage_logs টেবিলে লেখে (ব্যাচ/worker পাথে, রিকোয়েস্ট পাথে নয়)।
const { pool } = require('../../db');

async function processApiLogJob(job) {
  const d = job.data;
  await pool.query(
    `INSERT INTO api_usage_logs
     (api_key_id, user_id, ip, endpoint, method, status_code, response_time_ms, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      d.apiKeyId || null,
      d.userId || null,
      d.ip || null,
      String(d.endpoint || '').slice(0, 500),
      d.method || 'GET',
      d.statusCode || 200,
      d.responseTimeMs || 0,
      d.userAgent || null
    ]
  );
}

module.exports = { processApiLogJob };
