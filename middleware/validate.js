// অ্যাডমিন তালিকার page প্যারামিটার। নিচের দিকে ১-এ ক্ল্যাম্প করা আগেও হতো, কিন্তু
// উপরের দিকে কোনো সীমা ছিল না — ?page=99999999 দিলে OFFSET বিশাল হয়ে যেত এবং
// PostgreSQL ওই সব সারি স্ক্যান করে ফেলে দিত (অপ্রয়োজনীয় কাজ, ধীর রেসপন্স)।
// স্বাভাবিক পেজিনেশন অপরিবর্তিত; শুধু অস্বাভাবিক বড় মান নিরাপদে ক্ল্যাম্প হয়।
const MAX_PAGE = 10000;
function clampPage(value, max = MAX_PAGE) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

/**
 * middleware/validate.js
 * ---------------------------------------------------------------------------
 * হালকা, ডিপেন্ডেন্সি-ফ্রি ইনপুট ভ্যালিডেশন/স্যানিটাইজেশন হেল্পার।
 * নতুন লাইব্রেরি (যেমন express-validator) যোগ না করে বিদ্যমান কোডের ধরন
 * (ম্যানুয়াল চেক + req.flash) অনুসরণ করেই বানানো, যাতে audit surface না বাড়ে।
 *
 * ব্যবহার — route-level middleware হিসেবে:
 *   router.post('/users/:id/coins/add', requireIntParam('id'), requireAmount('amount', {max: 10_000_000}), async (req, res) => {...})
 *
 * অথবা ফাংশন হিসেবে সরাসরি:
 *   const amount = parseAmount(req.body.amount, {max: 1000});
 * ---------------------------------------------------------------------------
 */

// দ্রষ্টব্য: redirectTo==='back' হলে আগে সরাসরি req.get('Referer') ব্যবহার করা হতো।
// Referer সম্পূর্ণ ক্লায়েন্ট-নিয়ন্ত্রিত, তাই বাইরের কোনো পেজ থেকে ত্রুটিপূর্ণ id/amount-সহ
// লিংকে ক্লিক করালে অ্যাডমিনকে ওই বাইরের সাইটেই ফেরত পাঠানো যেত — যাচাই করে দেখা গেছে
// Location হেডারে আক্রমণকারীর URL-ই বসত (open redirect)। utils/redirectBack.js-এর
// backUrl() একই সমস্যার নিরাপদ সমাধান আগে থেকেই রাখে: same-host যাচাই করে, আর
// protocol-relative বা non-http স্কিম প্রত্যাখ্যান করে।
const { backUrl } = require('../utils/redirectBack');


// ==================== প্রাইমারি হেল্পার ফাংশন ====================

// URL param (যেমন :id) একটা পজিটিভ ইন্টিজার কিনা যাচাই করে; নাহলে null
function parsePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// টাকা/কয়েনের পরিমাণ যাচাই — পজিটিভ, ফিনিট, এবং একটা যুক্তিসঙ্গত সর্বোচ্চ সীমার মধ্যে
// (Postgres INTEGER কলামের সীমা ~2.1 বিলিয়ন, তাই ডিফল্ট ম্যাক্স তার অনেক নিচে রাখা হয়েছে
// যাতে ভুলে/দুর্ঘটনাক্রমে বা কম্প্রোমাইজড সেশন থেকে অস্বাভাবিক বড় সংখ্যা বসানো না যায়)
function parseAmount(value, { max = 10_000_000, min = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// প্লেইন টেক্সট ইনপুট স্যানিটাইজ — HTML ট্যাগ/স্ক্রিপ্ট স্ট্রিপ করে, ট্রিম করে,
// এবং দৈর্ঘ্য একটা সীমার মধ্যে বেঁধে দেয় (stored XSS ও DB bloat ঠেকাতে)
function sanitizeText(value, { maxLen = 2000 } = {}) {
  if (typeof value !== 'string') return '';
  let out = value
    .replace(/<[^>]*>/g, '')      // HTML/স্ক্রিপ্ট ট্যাগ স্ট্রিপ
    .replace(/javascript:/gi, '') // javascript: URI স্কিম স্ট্রিপ
    .trim();
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

// URL হিসেবে সন্দেহজনক না — http(s):// দিয়ে শুরু কিনা যাচাই (external link ফিল্ডের জন্য)
function isSafeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ==================== Express মিডলওয়্যার wrapper ====================

// req.params[name] পজিটিভ ইন্টিজার না হলে ফ্ল্যাশ এরর দিয়ে ফিরিয়ে দেয়
function requireIntParam(name, redirectTo = 'back') {
  return (req, res, next) => {
    const n = parsePositiveInt(req.params[name]);
    if (n === null) {
      req.flash('error', 'অবৈধ আইডি।');
      return res.redirect(redirectTo === 'back' ? backUrl(req, '/admin') : redirectTo);
    }
    req.params[name] = n; // normalize
    next();
  };
}

// req.body[name] একটা বৈধ amount না হলে ফ্ল্যাশ এরর দিয়ে ফিরিয়ে দেয়
function requireAmount(name, opts = {}, redirectTo = 'back') {
  return (req, res, next) => {
    const n = parseAmount(req.body[name], opts);
    if (n === null) {
      req.flash('error', 'সঠিক পরিমাণ দিন (সীমার মধ্যে)।');
      return res.redirect(redirectTo === 'back' ? backUrl(req, '/admin') : redirectTo);
    }
    req.body[name] = n; // normalize
    next();
  };
}

module.exports = {
  parsePositiveInt,
  parseAmount,
  sanitizeText,
  isSafeUrl,
  clampPage,
  MAX_PAGE,
  requireIntParam,
  requireAmount,
};
