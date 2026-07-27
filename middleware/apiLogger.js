const { pool } = require('../db');

/**
 * Logs every API request to api_usage_logs table.
 * Captures: API Key, User, IP, Endpoint, Method, Status, Response Time, Timestamp
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
      try {
        const apiKeyId = req.apiKey ? req.apiKey.id : null;
        const userId = (req.session && req.session.user) ? req.session.user.id : (req.user ? req.user.id : null);
        const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
        const endpoint = req.originalUrl || req.url || '';
        const method = req.method || 'GET';
        const userAgent = req.headers['user-agent'] || null;

        await pool.query(
          `INSERT INTO api_usage_logs 
           (api_key_id, user_id, ip, endpoint, method, status_code, response_time_ms, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [apiKeyId, userId, ip, endpoint.slice(0, 500), method, statusCode, responseTime, userAgent]
        );
      } catch (err) {
        console.error('API usage log error:', err.message);
      }
    });

    return originalEnd.apply(this, args);
  };

  next();
}

module.exports = { apiUsageLogger };
