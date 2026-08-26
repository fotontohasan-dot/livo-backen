// queues/processors/apiLog.js
const { pool } = require('../../db');

async function processApiLogJob(job) {
  const d = job.data;
  await pool.query(
    `INSERT INTO api_logs (method, path, status_code, response_time_ms, user_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [d.method, d.path, d.statusCode, d.responseTimeMs, d.userId || null, d.ip || null]
  );
}

module.exports = { processApiLogJob };
