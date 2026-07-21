// middleware/gateway.js
// কেন্দ্রীয় API Gateway — সব /api/* রিকোয়েস্টের জন্য একটাই জায়গায়
// rate-limit, logging, standardized response এবং error handling

const rateLimit = require('express-rate-limit');
const RedisRateLimitStore = require('../services/redisRateLimitStore');

// শুধু /api/ পাথের জন্য আলাদা rate limiter (login/register এর থেকে আলাদা)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // প্রতি মিনিটে সর্বোচ্চ ৬০ টা API কল প্রতি IP/user থেকে
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.user) ? `u_${req.session.user.id}` : req.ip,
  store: new RedisRateLimitStore('rl:api:'),
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'অনেকবার রিকোয়েস্ট করেছেন। একটু পর আবার চেষ্টা করুন।' });
  }
});

// Request logging (হালকা, শুধু /api/ কলের জন্য)
function apiLogger(req, res, next) {
  const start = Date.now();
  const userId = (req.session && req.session.user) ? req.session.user.id : 'guest';
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[API] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms) user=${userId}`);
  });
  next();
}

// res.apiSuccess / res.apiError হেল্পার — সব JSON রেসপন্স এক ফরম্যাটে
function responseHelpers(req, res, next) {
  res.apiSuccess = (data = {}, status = 200) => {
    res.status(status).json({ success: true, ...data });
  };
  res.apiError = (message = 'সার্ভার ত্রুটি।', status = 400) => {
    res.status(status).json({ success: false, error: message });
  };
  next();
}

// /api/ পাথ ম্যাচ না করলে (unknown API route) JSON 404
function apiNotFound(req, res, next) {
  if (req.path.includes('/api/')) {
    return res.status(404).json({ success: false, error: 'API রুট খুঁজে পাওয়া যায়নি।' });
  }
  next();
}

// একসাথে সব middleware চালানোর জন্য গেটওয়ে এন্ট্রিপয়েন্ট
function apiGateway(req, res, next) {
  if (!req.path.includes('/api/')) return next();
  return apiLimiter(req, res, () => apiLogger(req, res, next));
}

module.exports = { apiGateway, responseHelpers, apiNotFound };
