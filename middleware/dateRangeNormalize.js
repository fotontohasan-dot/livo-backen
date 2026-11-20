// middleware/dateRangeNormalize.js
// অ্যাডমিন রিপোর্ট/লগের from/to কড়া 'YYYY-MM-DD' চায়। 2026-3-5 বা 2026/3/5 লিখলে আগে রুটের
// ভেতরে RangeError হয়ে এরর পেজ আসত। এখন:
//   • সংশোধনযোগ্য হলে স্বয়ংক্রিয়ভাবে 'YYYY-MM-DD'-এ ঠিক করা হয়;
//   • একেবারে অচেনা/অবাস্তব তারিখ হলে ওই ফিল্টার বাদ দিয়ে বন্ধুত্বপূর্ণ বার্তা flash হয় (এরর পেজ নয়)।
const { normalizeDay } = require('../utils/businessTime');

const FIELDS = ['from', 'to'];

function dateRangeNormalize(req, res, next) {
  try {
    if (req.method !== 'GET') return next();
    const q = req.query;
    if (!q || !FIELDS.some((f) => q[f] !== undefined)) return next();

    const fixed = { ...q };
    const bad = [];
    for (const f of FIELDS) {
      if (q[f] === undefined) continue;
      const raw = Array.isArray(q[f]) ? q[f][0] : q[f];
      if (typeof raw !== 'string' || raw.trim() === '') { delete fixed[f]; continue; }
      const day = normalizeDay(raw);
      if (day) fixed[f] = day; else { delete fixed[f]; bad.push(f); }
    }
    // Express 5-এ req.query getter — তাই নিজস্ব মান বসানো হচ্ছে
    Object.defineProperty(req, 'query', { value: fixed, writable: true, configurable: true, enumerable: true });

    if (bad.length && typeof req.flash === 'function') {
      const t = typeof req.t === 'function' ? req.t : (k) => k;
      req.flash('error', t('admin_date_filter_invalid'));
    }
  } catch (e) {
    console.error('dateRangeNormalize error:', e.message);
  }
  next();
}

module.exports = { dateRangeNormalize };
