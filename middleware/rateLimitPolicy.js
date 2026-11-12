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

const { normalizeIdentifier, normalizeEmail } = require('../utils/identity');
const crypto = require('crypto');

function ipKey(req) { return `ip:${ipKeyGenerator(req.ip)}`; }

/**
 * প্রি-অথ লগইন কী: বডির identifier (ইমেইল/ইউজারনেম/ফোন) normalize করে হ্যাশ করা `acct:<h>`।
 * identifier না থাকলে (ফাঁকা/অন্য ধরনের POST) আগের মতো কড়া IP-কী — ফলে অ্যাকাউন্ট-ভিত্তিক সীমা ঢিলা হয় না।
 * হ্যাশ করা হয় যাতে Redis কী-তে ইউজারের ফোন/ইমেইল প্লেইন থাকে না।
 */
function hashKey(prefix, value) {
  return `${prefix}:` + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}
function loginAccountKey(req) {
  const raw = req.body && (req.body.identifier || req.body.username || req.body.phone || req.body.email);
  const id = typeof raw === 'string' ? normalizeIdentifier(raw) : '';
  return id ? hashKey('acct', id) : ipKey(req);
}
function resetAccountKey(req) {
  const b = req.body || {};
  if (req.params && req.params.token) return hashKey('tok', req.params.token);
  const e = typeof b.email === 'string' ? normalizeEmail(b.email) : '';
  return e ? hashKey('acct', e) : ipKey(req);
}

/**
 * A2: লগইন ব্যর্থ-চেষ্টার কী = অ্যাকাউন্ট + IP একসাথে (`acct:<h>|ip:<addr>`)।
 * ফলে ভিকটিমের ফোন/ইমেইল নিয়ে একটা IP থেকে স্প্যাম করলে শুধু *ঐ IP + ঐ অ্যাকাউন্ট* জোড়ার বাজেট ফুরায় —
 * আসল মালিক নিজের IP/ডিভাইস থেকে আটকায় না। identifier না থাকলে আগের কড়া IP-কী (ঢিলা হয় না)।
 */
function loginAccountIpKey(req) {
  const acct = loginAccountKey(req);
  return acct.startsWith('acct:') ? `${acct}|${ipKey(req)}` : acct;
}

/** সফল লগইন (পাসওয়ার্ড/ক্রেডেনশিয়াল যাচাই পাস) চিহ্নিত করে — লিমিটার এটা দেখে ব্যর্থ-বাজেট থেকে কাউন্ট ফেরত দেয়। */
function markLoginSuccess(res) { if (res && res.locals) res.locals.loginSucceeded = true; }
function loginRequestWasSuccessful(req, res) { return !!(res && res.locals && res.locals.loginSucceeded === true); }

/** reset: অ্যাকাউন্ট + IP কী; ইমেইল/টোকেন না থাকলে IP-কী। অস্তিত্ব-নিরপেক্ষ (শুধু ইনপুট থেকে গণনা)। */
function resetAccountIpKey(req) {
  const acct = resetAccountKey(req);
  return acct.startsWith('acct:') ? `${acct}|${ipKey(req)}` : acct;
}

// প্রতি-IP ছাদ (শেয়ার্ড মোবাইল IP-তে অনেক ইউজার); একক অ্যাকাউন্টের সীমা (১০/৫) আলাদা limiter-এ অপরিবর্তিত
const IP_CEILINGS = { login: 100, reset: 50 };

module.exports = { LIMITS, userOrIpKey, generalMax, sessionUserId, loginAccountKey, resetAccountKey, ipKey, IP_CEILINGS,
  loginAccountIpKey, resetAccountIpKey, markLoginSuccess, loginRequestWasSuccessful };
