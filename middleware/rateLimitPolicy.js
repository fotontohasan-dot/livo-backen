// middleware/rateLimitPolicy.js
// ==================== রেট-লিমিট নীতি: কী (key) ও গ্রুপ-ভিত্তিক সীমা এক জায়গায় ====================
// সমস্যা: শুধু IP দিয়ে গুনলে মোবাইল CGNAT-এ (বাংলাদেশে একটা IP-তে শত শত ইউজার) একজনের ট্র্যাফিক
// বাকিদের আটকে দেয়। নীতি:
//   • লগইন করা রিকোয়েস্ট  → ইউজার ID দিয়ে গোনা (`u:<id>`) — একই IP-র দুই ইউজার একে অপরকে আটকায় না
//   • অ্যানোনিমাস রিকোয়েস্ট → IP দিয়ে গোনা (`ip:<ipv6-safe>`)
//   • প্রতিটা রুট-গ্রুপের আলাদা সীমা (নিচের LIMITS)
// সংবেদনশীল গ্রুপ (লগইন, OTP/রিসেট, ডিপোজিট/উইথড্র/পেমেন্ট) আগের চেয়ে ঢিলা করা হয়নি।

const { ipKeyGenerator } = require('express-rate-limit');

const WINDOW_15_MIN = 15 * 60 * 1000;

const LIMITS = {
  // সাধারণ পেজ/API রিড: CGNAT টিকিয়ে রাখতে অ্যানোনিমাস IP-সীমা বড়; লগইন করা ইউজারের নিজস্ব সীমা
  general: { windowMs: WINDOW_15_MIN, userMax: 600, anonIpMax: 3000 }, // আগে: ৩০০ / IP
};
// নোট: login (১০), OTP/রিসেট (৫), financial (২০), payment (১৫) গ্রুপের সীমা অপরিবর্তিত — সেগুলো আগের মতোই
// app.js / routes/auth.js / routes/payment.js-এ আক্ষরিক সংখ্যায় থাকে, যাতে tests/security/rateLimitAuditMatrix.test.js
// সেগুলোর ছাদ পাহারা দিতে পারে। financial ও payment-এ শুধু কী বদলেছে: প্রতি IP-র বদলে প্রতি ইউজার।

function sessionUserId(req) {
  const u = req && req.session && req.session.user;
  return u && u.id !== undefined && u.id !== null ? u.id : null;
}

/** লগইন করা থাকলে `u:<id>`, নইলে IPv6-নিরাপদ `ip:<addr>`। */
function userOrIpKey(req) {
  const id = sessionUserId(req);
  return id !== null ? `u:${id}` : `ip:${ipKeyGenerator(req.ip)}`;
}

/** express-rate-limit-এর `limit`/`max` ফাংশন: লগইন করা হলে userMax, নইলে anonIpMax। */
function generalMax(req) {
  return sessionUserId(req) !== null ? LIMITS.general.userMax : LIMITS.general.anonIpMax;
}

module.exports = { LIMITS, userOrIpKey, generalMax, sessionUserId };
