// services/wallet/signature.js
// ---------------------------------------------------------------------------
// প্রোভাইডার কলব্যাকের HMAC-SHA256 স্বাক্ষর তৈরি ও যাচাই।
//
// কেন আলাদা ফাইল: স্বাক্ষরের নিয়ম প্রতিটা প্রোভাইডারের ডকুমেন্টে সামান্য
// আলাদা (কোন হেডার, কী কনক্যাট করা হয়, hex না base64)। কোর যাচাই-লজিক এক
// জায়গায় রেখে অ্যাডাপ্টার শুধু নিজের ফরম্যাট বলে দেয় — তাই নতুন প্রোভাইডার
// এলে এই ফাইল বদলাতে হয় না।
//
// নিরাপত্তা নিয়ম (তিনটাই বাধ্যতামূলক):
//   ১. তুলনা crypto.timingSafeEqual দিয়ে — সরল === টাইমিং সাইড-চ্যানেল খোলে।
//   ২. timestamp একটা ছোট উইন্ডোর (ডিফল্ট ৩০ সেকেন্ড) ভেতরে থাকতে হবে —
//      নাহলে একবার ধরা পড়া বৈধ রিকোয়েস্ট অনির্দিষ্টকাল replay করা যেত।
//   ৩. স্বাক্ষর হিসাব হয় *কাঁচা* বডির উপর (req.rawBody), JSON.stringify করা
//      পুনর্গঠিত বডির উপর নয় — key-order বা whitespace বদলালেই মিলত না।
//
// কোনো সিক্রেট এই ফাইলে নেই; সব process.env থেকে আসে।
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const DEFAULT_WINDOW_SECONDS = 30;

/** প্রোভাইডারের env সিক্রেট — PROVIDER_<NAME>_SECRET। */
function secretFor(provider) {
  const key = `PROVIDER_${String(provider || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SECRET`;
  return process.env[key] || null;
}

/**
 * HMAC-SHA256 স্বাক্ষর তৈরি।
 * @param {string} payload স্বাক্ষরযোগ্য স্ট্রিং (সাধারণত timestamp + rawBody)
 * @param {string} secret  শেয়ার্ড সিক্রেট
 * @param {'hex'|'base64'} encoding
 */
function sign(payload, secret, encoding = 'hex') {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest(encoding);
}

/**
 * টাইমিং-সেফ স্ট্রিং তুলনা। দৈর্ঘ্য আলাদা হলে timingSafeEqual থ্রো করে,
 * তাই আগেই দৈর্ঘ্য মিলিয়ে নেওয়া হয় (middleware/csrf.js-এর একই প্যাটার্ন)।
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function windowSeconds() {
  const n = parseInt(process.env.WALLET_SIGNATURE_WINDOW_SECONDS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_SECONDS;
}

/**
 * timestamp গ্রহণযোগ্য উইন্ডোর ভেতরে কি না।
 * সেকেন্ড ও মিলিসেকেন্ড দুই ফরম্যাটই গ্রহণ করা হয় — প্রোভাইডারভেদে আলাদা।
 * ভবিষ্যতের দিকেও একই উইন্ডো প্রযোজ্য (ক্লক স্কিউ সামলাতে)।
 */
function isFreshTimestamp(timestamp, nowMs = Date.now()) {
  if (timestamp === undefined || timestamp === null || timestamp === '') return false;
  const raw = Number(timestamp);
  if (!Number.isFinite(raw)) return false;
  // ১০ অঙ্কের মান সেকেন্ড, ১৩ অঙ্কের মান মিলিসেকেন্ড
  const ms = Math.abs(raw) < 1e11 ? raw * 1000 : raw;
  return Math.abs(nowMs - ms) <= windowSeconds() * 1000;
}

/**
 * সম্পূর্ণ যাচাই: স্বাক্ষর মেলে এবং timestamp তাজা।
 * @returns {{ ok: boolean, reason?: string }}
 */
function verify({ provider, timestamp, signature, rawBody, encoding = 'hex', secret }) {
  const key = secret || secretFor(provider);
  if (!key) return { ok: false, reason: 'no_secret_configured' };
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!isFreshTimestamp(timestamp)) return { ok: false, reason: 'stale_timestamp' };

  const expected = sign(`${timestamp}${rawBody || ''}`, key, encoding);
  if (!safeCompare(expected, String(signature))) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

module.exports = { sign, verify, safeCompare, isFreshTimestamp, secretFor, windowSeconds };
