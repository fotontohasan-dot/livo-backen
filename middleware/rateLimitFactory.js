// middleware/rateLimitFactory.js
// ==================== রেট-লিমিটার তৈরির কেন্দ্রীয় ফ্যাক্টরি ====================
// এই রিপোজিটরিতে অনেক জায়গায় আলাদা আলাদা rateLimit() কল আছে (app.js, routes/auth.js,
// routes/payment.js, routes/profile.js, routes/admin.js, middleware/gateway.js)। প্রতিটাকে
// আলাদাভাবে Redis store + suspicious-logging যোগ করতে গেলে কোড ডুপ্লিকেট হতো — তাই এই
// একটা createLimiter() ফাংশন দিয়েই সবগুলো তৈরি হয়, দুটো জিনিস স্বয়ংক্রিয়ভাবে পায়:
//   ১) Redis-backed store (একাধিক ইনস্ট্যান্স জুড়ে শেয়ার্ড কাউন্টার)
//   ২) 429 হিট হলে audit_logs (category: 'security') এ non-blocking লগ
//
// প্রতিটা কলের behavior (max, windowMs, message, custom handler) আগের মতোই থাকে —
// শুধু নিচের দুটো ক্রস-কাটিং কনসার্ন এক জায়গা থেকে যোগ হয়।

const rateLimit = require('express-rate-limit');
const { createRedisStore } = require('./redisRateLimitStore');

function getUserId(req) {
  return (req.session && req.session.user) ? req.session.user.id : null;
}

/**
 * @param {string} name - এই limiter-এর ইউনিক নাম (Redis key prefix + লগে limiterName হিসেবে যায়)
 * @param {object} options - express-rate-limit-এর সাধারণ অপশন (windowMs, max, message, keyGenerator, handler ইত্যাদি)
 */
function createLimiter(name, options = {}) {
  const { handler: customHandler, message, ...rest } = options;

  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    store: createRedisStore(name),
    ...rest,
    handler: (req, res, next, opts) => {
      // non-blocking — লগিং ব্যর্থ হলেও রেসপন্স আটকাবে না
      try {
        require('../services/auditLog').logRateLimitExceeded({
          ip: req.ip,
          userId: getUserId(req),
          path: req.originalUrl || req.path,
          method: req.method,
          limiterName: name,
          userAgent: req.get('user-agent') || null
        });
      } catch (e) { /* non-fatal */ }

      if (typeof customHandler === 'function') return customHandler(req, res, next, opts);

      const msg = message || 'অনেকবার চেষ্টা করেছেন। কিছুক্ষণ পর আবার চেষ্টা করুন।';
      const accept = req.get('accept') || '';
      if (req.xhr || accept.includes('application/json') || (req.get('content-type') || '').includes('application/json')) {
        return res.status(429).json({ success: false, error: msg });
      }
      return res.status(429).send(msg);
    }
  });
}

module.exports = { createLimiter };
