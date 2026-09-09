// services/casinoProviders/normalizedGame.js
// ---------------------------------------------------------------------------
// সব প্রোভাইডারের গেম এক আকারে আনার schema।
//
// কেন দরকার: প্রতিটা অ্যাগ্রিগেটরের গেম-লিস্ট API আলাদা আকারে উত্তর দেয়
// (কেউ `game_code`, কেউ `id`, কেউ `gameId`; কেউ RTP পার্সেন্টে দেয়, কেউ
// ভগ্নাংশে)। sync worker বা লবি যদি সরাসরি প্রোভাইডারের আকার নিয়ে কাজ করত,
// তাহলে নতুন প্রোভাইডার এলেই কোর কোড বদলাতে হতো। অ্যাডাপ্টার এখানে এসে
// নিজের আকারকে এই একটাই আকারে অনুবাদ করে দেয় — তারপর কোর কোড আর জানেই না
// কোন প্রোভাইডার থেকে গেমটা এলো।
//
// normalize() ইচ্ছাকৃতভাবে ক্ষমাশীল: একটা গেমের ঐচ্ছিক ফিল্ড অনুপস্থিত থাকলে
// পুরো sync ব্যর্থ হওয়ার চেয়ে সেই ফিল্ড খালি রাখা ভালো। কিন্তু
// providerGameId বা name না থাকলে গেমটা বাদ যায় — ওগুলো ছাড়া লবিতে দেখানোর
// বা লঞ্চ করার কোনো উপায়ই নেই।
// ---------------------------------------------------------------------------

/** ঐচ্ছিক স্ট্রিং — খালি/undefined হলে null, নাহলে trim করা। */
function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function bool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'y'].includes(String(v).toLowerCase());
}

/**
 * RTP স্বাভাবিক করা। প্রোভাইডাররা ০.৯৬ বা ৯৬ — দুই রূপেই পাঠায়।
 * ১-এর কম মান ভগ্নাংশ ধরে ১০০ দিয়ে গুণ করা হয়।
 */
function rtp(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  // games.rtp কলাম NUMERIC(5,2) — ৯৯৯.৯৯ পর্যন্ত। অস্বাভাবিক মান বাদ।
  if (pct > 100) return null;
  return Math.round(pct * 100) / 100;
}

/**
 * একটা কাঁচা গেম অবজেক্টকে normalizedGame আকারে আনে।
 * @returns {object|null} অবৈধ হলে null — caller সেটা বাদ দেবে।
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const providerGameId = str(raw.providerGameId);
  const name = str(raw.name);
  if (!providerGameId || !name) return null;

  return {
    providerGameId,
    name,
    category: str(raw.category) || 'other',
    subCategory: str(raw.subCategory),
    thumbnailUrl: str(raw.thumbnailUrl),
    rtp: rtp(raw.rtp),
    hasDemo: bool(raw.hasDemo, false),
    isMobile: bool(raw.isMobile, true),
    isActive: bool(raw.isActive, true),
    raw: raw.raw !== undefined ? raw.raw : null
  };
}

/** অ্যারে normalize — অবৈধ এন্ট্রি নীরবে বাদ, বাকিগুলো টেকে। */
function normalizeAll(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const g = normalize(item);
    if (g) out.push(g);
  }
  return out;
}

module.exports = { normalize, normalizeAll };
