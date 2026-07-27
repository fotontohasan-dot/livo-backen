const { pool } = require('../db');
const queue = require('../services/queue');

/**
 * Logs every API request to api_usage_logs table.
 * Captures: API Key, User, IP, Endpoint, Method, Status, Response Time, Timestamp
 * Goes through the background job queue (type: 'api_log') so logging never adds latency;
 * if enqueue fails (e.g. DB hiccup) it falls back to a direct, non-blocking write so no log is lost.
 */
function apiUsageLogger(req, res, next) {
  const start = Date.now();

  // Capture original end to log after response
  const originalEnd = res.end;
  res.end = function (...args) {
    const responseTime = Date.now() - start;
    const statusCode = res.statusCode || 200;

    // Non-blocking log
    setImmediate(async () => {
      const apiKeyId = req.apiKey ? req.apiKey.id : null;
      const userId = (req.session && req.session.user) ? req.session.user.id : (req.user ? req.user.id : null);
      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
      const endpoint = (req.originalUrl || req.url || '').slice(0, 500);
      const method = req.method || 'GET';
      const userAgent = req.headers['user-agent'] || null;

      const jobId = await queue.enqueue('api_log', {
        apiKeyId, userId, ip, endpoint, method,
        statusCode, responseTimeMs: responseTime, userAgent
      });
      if (jobId) return; // কিউতে জমা হয়ে গেছে

      // ফলব্যাক — কিউ এনকিউ ব্যর্থ হলে সরাসরি লিখে ফেলা হচ্ছে যাতে API লগ কখনো হারিয়ে না যায়
      try {
        await pool.query(
          `INSERT INTO api_usage_logs 
           (api_key_id, user_id, ip, endpoint, method, status_code, response_time_ms, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [apiKeyId, userId, ip, endpoint, method, statusCode, responseTime, userAgent]
        );
      } catch (err) {
        console.error('API usage log error (queue + direct write both failed):', err.message);
      }
    });

    return originalEnd.apply(this, args);
  };

  next();
}

module.exports = { apiUsageLogger };
