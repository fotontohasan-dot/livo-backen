// middleware/featureGate.js
// ---------------------------------------------------------------------------
// ফিচার ফ্ল্যাগের সার্ভার-সাইড প্রয়োগ।
//
// এর আগে services/featureFlags.js শুধু অ্যাডমিন CRUD পেজেই ব্যবহৃত হতো — কোনো
// ইউজার-ফেসিং রুট/API কখনো isEnabled() কল করত না। অর্থাৎ ফিচার "বন্ধ" করলে
// বাস্তবে কিছুই বন্ধ হতো না। এই মিডলওয়্যারটাই সেই ফাঁকটা বন্ধ করে।
//
// প্রয়োগের স্তর:
//   ১. UI visibility  — attachFeatureLocals() → res.locals.features (ভিউ লুকায়)
//   ২. Route access   — requireFeature() রুটে বসানো (সরাসরি URL কাজ করে না)
//   ৩. API access     — একই মিডলওয়্যার, JSON রিকোয়েস্টে JSON 403 দেয়
//
// ইচ্ছাকৃত সিদ্ধান্ত — অ্যাডমিন সেশনও ছাড় পায় না:
//   ফিচার বন্ধ মানে সবার জন্যই বন্ধ। অ্যাডমিন প্যানেলের (/admin/*) কোনো রুটে
//   এই গেট বসানো নেই, তাই অ্যাডমিন বন্ধ ফিচারটা ম্যানেজ করতে পারেন — কিন্তু
//   ইউজার-ফেসিং পেজে তার সেশনও অন্য সবার মতোই ব্লক হয়। এতে অ্যাডমিন নিজে
//   পরীক্ষা করে দেখতে পারেন ফিচারটা সত্যিই বন্ধ হয়েছে কিনা।
//
// সেশন কেন বাইপাস হয় না: গেটটা প্রতি-রিকোয়েস্টে চলে, সেশন তৈরির সময় নয়।
// আগে থেকে লগইন করা ইউজারের পরের রিকোয়েস্টেই ব্লক হয়ে যায়।
// ---------------------------------------------------------------------------

const featureFlags = require('../services/featureFlags');
const registry = require('../services/featureRegistry');
const { tr } = require('../utils/i18n');

/** JSON উত্তর প্রত্যাশিত কিনা — API রুট, XHR, অথবা Accept: application/json। */
function wantsJson(req) {
  if (req.path.includes('/api/')) return true;
  if (req.xhr) return true;
  const accept = req.get('accept') || '';
  if (accept.includes('application/json') && !accept.includes('text/html')) return true;
  // ব্রাউজার ফর্ম POST নয় এমন JSON বডি পাঠানো রিকোয়েস্ট
  const ctype = req.get('content-type') || '';
  if (ctype.includes('application/json')) return true;
  return false;
}

/**
 * requireFeature('lucky_wheel') — ফিচার বন্ধ থাকলে রিকোয়েস্ট এখানেই থামে।
 *
 * বন্ধ থাকলে 403 দেওয়া হয় (404 নয়): ফিচারটার অস্তিত্ব গোপন করার কিছু নেই,
 * ইউজার নেভিগেশনে সেটা আগে দেখেছেন। বার্তাটা ইউজারের ভাষায় যায় এবং কোনো
 * অভ্যন্তরীণ বিবরণ (ফ্ল্যাগ key, DB অবস্থা) ফাঁস করে না।
 */
function requireFeature(key) {
  if (!registry.isKnownKey(key)) {
    // ডেভেলপার ভুল — টাইপো করা key দিয়ে গেট বসালে সেটা নীরবে সবসময় "চালু"
    // হয়ে যেত। বুট-টাইমেই ধরা পড়া ভালো।
    throw new Error(`requireFeature: unknown feature key "${key}" (services/featureRegistry.js দেখুন)`);
  }

  return async function featureGate(req, res, next) {
    let enabled;
    try {
      enabled = await featureFlags.isEnabled(key);
    } catch (err) {
      // ফ্ল্যাগ পড়া ব্যর্থ হলে fail-safe: রেজিস্ট্রির ডিফল্ট। isEnabled()
      // নিজেই এটা সামলায়, এই catch শুধু অতিরিক্ত সুরক্ষা।
      console.error('featureGate read error (' + key + '):', err.message);
      enabled = registry.defaultFor(key);
    }

    if (enabled) return next();

    const message = tr(req, 'feature_currently_disabled');

    if (wantsJson(req)) {
      return res.status(403).json({ ok: false, success: false, error: message, message });
    }

    // ফর্ম POST — ফ্ল্যাশ দিয়ে যেখান থেকে এসেছে সেখানে ফেরত পাঠানো হয়,
    // যাতে ইউজার একটা ডেড-এন্ড এরর পেজে আটকে না যান।
    if (req.method !== 'GET' && req.flash) {
      req.flash('error', message);
      return res.redirect('/');
    }

    return res.status(403).render('error', {
      user: (req.session && req.session.user) || null,
      message
    });
  };
}

/**
 * সব ভিউতে res.locals.features = { key: bool } বসায়, যাতে নেভিগেশন/বাটন
 * লুকানো যায়। এটা নিছক প্রসাধনী — আসল সুরক্ষা requireFeature()।
 *
 * ব্যর্থ হলে fail-safe ডিফল্ট ম্যাপ বসিয়ে next() — ফ্ল্যাগ লোড না হওয়া
 * কখনো পুরো সাইট ভেঙে ফেলার কারণ হবে না।
 */
function attachFeatureLocals(req, res, next) {
  featureFlags.getEnabledMap()
    .then(map => { res.locals.features = map; next(); })
    .catch(err => {
      console.error('attachFeatureLocals error:', err.message);
      const fallback = {};
      for (const f of registry.FEATURES) fallback[f.key] = f.defaultEnabled !== false;
      res.locals.features = fallback;
      next();
    });
}

module.exports = { requireFeature, attachFeatureLocals, wantsJson };
