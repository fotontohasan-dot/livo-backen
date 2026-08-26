// queues/processors/activityLog.js
const { pool } = require('../../db');

async function processActivityLogJob(job) {
  const d = job.data;
  await pool.query(
    `INSERT INTO activity_logs (user_id, username, action_type, details, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [d.userId || null, d.username || null, d.actionType, d.details || null, d.ip || null, d.userAgent || null]
  );
}

module.exports = { processActivityLogJob };
