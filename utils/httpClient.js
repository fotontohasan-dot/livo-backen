// utils/httpClient.js
// ==================== টাইমআউটসহ fetch ====================
//
// Node-এর গ্লোবাল fetch()-এ কোনো ডিফল্ট টাইমআউট নেই। তাই কোনো তৃতীয় পক্ষ
// (Cloudinary, Telegram, SMS গেটওয়ে, sports API, AI API) ঝুলে গেলে আমাদের
// কলটাও অনির্দিষ্টকাল ঝুলে থাকত — একটা ধীর upstream পুরো রিকোয়েস্ট আটকে
// রাখত, আর scheduler/queue থেকে ডাকা হলে কাজ জমতে থাকত।
//
// roadmap Phase 9 ("API timeout") ও Phase 17 (observability/queue health)
// দুটোরই ভিত্তি এটা।
//
// আচরণ: টাইমআউট হলে AbortError ছোঁড়ে। কলারদের বিদ্যমান try/catch সেটা
// ধরে এবং নিরাপদ ফলব্যাক ফেরত দেয় — অর্থাৎ এটা যোগ করায় নতুন কোনো
// unhandled rejection তৈরি হয় না।

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 10000;

/**
 * @param {string|URL} url
 * @param {object} options - স্বাভাবিক fetch options
 * @param {number} timeoutMs - ডিফল্ট HTTP_TIMEOUT_MS বা ১০ সেকেন্ড
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    // clearTimeout না করলে সফল কলেও একটা টাইমার ঝুলে থাকত এবং
    // process বন্ধ হতে দেরি করত।
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
