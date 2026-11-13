// middleware/loginLimiters.js
// ==================== লগইন লিমিটার (A2): শুধু ব্যর্থ চেষ্টা গোনে, অ্যাকাউন্ট+IP কী ====================
// সমস্যা (আগে): ১) প্রতিটা POST গোনা হতো — সফল লগইনও বাজেট খরচ করত; ২) কী ছিল শুধু অ্যাকাউন্ট —
// যে কেউ ভিকটিমের ফোন নম্বর দিয়ে ১০ বার ভুল পাসওয়ার্ড পাঠিয়ে আসল মালিককে ১৫ মিনিট আটকে দিতে পারত।
//
// এখন:
//   loginLimiter            অ্যাকাউন্ট+IP, ব্যর্থ ১০/১৫মি (হার্ড ৪২৯) — app.js-এ (সোর্স-প্যাটার্ন টেস্ট সেখানেই খোঁজে)
//   loginIpCeilingLimiter   প্রতি-IP, ব্যর্থ ১০০/১৫মি (হার্ড ৪২৯) — app.js-এ
//   loginAccountSoftLimiter অ্যাকাউন্ট (সব IP), ব্যর্থ ৮/১৫মি → নরম: CAPTCHA + ১ সেকেন্ড দেরি, কখনো ব্লক নয়
//   loginAccountCeilingLimiter অ্যাকাউন্ট (সব IP), ব্যর্থ ৫০/১৫মি → নরম: CAPTCHA + ৫ সেকেন্ড দেরি, কখনো ব্লক নয়
// অ্যাকাউন্ট-ব্যাপী (সব IP) সীমায় হার্ড লক ইচ্ছাকৃতভাবে নেই: তাহলে বটনেট ভিকটিমকে লক-আউট করতে পারত।
// নরম সীমা দুটো identifier-এর হ্যাশে গোনা — অ্যাকাউন্ট আছে কি না তার ওপর নির্ভর করে না (enumeration নেই)।
// সীমার সংখ্যা সোর্সে আক্ষরিক থাকে, যাতে tests/security/rateLimitAuditMatrix.test.js পাহারা দিতে পারে।

const rateLimit = require('express-rate-limit');
const RedisRateLimitStore = require('../services/redisRateLimitStore');
const { loginAccountKey, loginRequestWasSuccessful } = require('./rateLimitPolicy');

const notGet = (req) => req.method === 'GET' || req.method === 'HEAD';
// নরম প্রতিক্রিয়া: ব্লক না করে পতাকা বসায়; লগইন রুট CAPTCHA চায় ও দেরি করে (routes/auth.js)
const soft = (delayMs) => (req, res, next) => { req.loginSoftThrottle = true; req.loginSoftDelayMs = Math.max(req.loginSoftDelayMs || 0, delayMs); next(); };

const loginAccountSoftLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8, keyGenerator: loginAccountKey, handler: soft(1000), skip: notGet,
  skipSuccessfulRequests: true, requestWasSuccessful: loginRequestWasSuccessful,
  standardHeaders: false, legacyHeaders: false, store: new RedisRateLimitStore('rl:login:acctsoft:')
});

const loginAccountCeilingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 50, keyGenerator: loginAccountKey, handler: soft(5000), skip: notGet,
  skipSuccessfulRequests: true, requestWasSuccessful: loginRequestWasSuccessful,
  standardHeaders: false, legacyHeaders: false, store: new RedisRateLimitStore('rl:login:acctceil:')
});

/** নরম থ্রটলে দেরি (ms) — লগইন রুটগুলো এটা await করে। পতাকা না থাকলে ০। */
function softLoginDelayMs(req) { return req.loginSoftThrottle ? (req.loginSoftDelayMs || 1000) : 0; }

module.exports = {
  loginAccountSoftLimiter, loginAccountCeilingLimiter,
  // শুধু নরম (কখনো ব্লক করে না) — app.js হার্ড limiter-গুলোর আগে বসায়
  loginSoftChain: [loginAccountCeilingLimiter, loginAccountSoftLimiter],
  softLoginDelayMs
};
