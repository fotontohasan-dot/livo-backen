// utils/publicUrl.js
// অ্যাপের নিজের পাবলিক ঠিকানা — ক্লায়েন্টের পাঠানো Host হেডার থেকে নয়।
//
// আগে reset/verification লিংক এভাবে বানানো হতো:
//
//     `${req.protocol}://${req.get('host')}/reset-password/${token}`
//
// `Host` হেডার সম্পূর্ণভাবে ক্লায়েন্ট-নিয়ন্ত্রিত। অ্যাটাকার ভিক্টিমের ইমেইলে
// পাসওয়ার্ড রিসেট ট্রিগার করে `Host: attacker.example` পাঠালে ভিক্টিম পেত
// `https://attacker.example/reset-password/<আসল টোকেন>` — লিংকে ক্লিক করলেই
// বৈধ রিসেট টোকেন অ্যাটাকারের সার্ভারে চলে যেত। একই সমস্যা ইমেইল ভেরিফিকেশন,
// রেফারেল ও পেমেন্ট কলব্যাক URL-এও ছিল।
//
// এখন ঠিকানা আসে কনফিগারেশন থেকে (`PUBLIC_APP_URL`, না থাকলে `BASE_URL`)।
// প্রোডাকশনে কনফিগার না থাকলে অ্যাপ বুট হওয়ার সময়ই থেমে যায় — অনুমান করে
// ভুল লিংক পাঠানোর চেয়ে স্পষ্ট ব্যর্থতা ভালো।

const CONFIGURED = (process.env.PUBLIC_APP_URL || process.env.BASE_URL || '').trim();

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/** শেষের `/` ছেঁটে ফেলা, যাতে জোড়া লাগানোর সময় `//` না হয়। */
function normalize(url) {
  return url.replace(/\/+$/, '');
}

function validate(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`PUBLIC_APP_URL বৈধ URL নয়: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`PUBLIC_APP_URL-এ http বা https লাগবে: ${url}`);
  }
  if (isProduction() && parsed.protocol !== 'https:') {
    throw new Error('প্রোডাকশনে PUBLIC_APP_URL অবশ্যই https হতে হবে।');
  }
  return normalize(parsed.origin + parsed.pathname);
}

/**
 * অ্যাপের পাবলিক বেস URL। `req` শুধু ডেভেলপমেন্ট fallback-এর জন্য —
 * প্রোডাকশনে কখনো req থেকে হোস্ট নেওয়া হয় না।
 */
function getBaseUrl(req) {
  if (CONFIGURED) return validate(CONFIGURED);

  if (isProduction()) {
    throw new Error(
      'PUBLIC_APP_URL সেট করা নেই। ইমেইলের লিংক Host হেডার থেকে বানানো হয় না ' +
      '(Host header poisoning ঝুঁকি), তাই প্রোডাকশনে এটি বাধ্যতামূলক।'
    );
  }

  // ডেভেলপমেন্ট/টেস্ট: কনফিগ না থাকলে req থেকে অনুমান করা চলে, কারণ সেখানে
  // ইমেইল বাস্তবে যায় না এবং localhost-এ কনফিগ বাধ্যতামূলক করলে কাজ আটকায়।
  if (req && typeof req.get === 'function') {
    return normalize(`${req.protocol}://${req.get('host')}`);
  }
  return 'http://localhost:3000';
}

/** বেস URL-এর সাথে পাথ জোড়া। পাথ `/` দিয়ে শুরু হোক বা না হোক, দুটোই চলে। */
function buildUrl(req, pathname) {
  const base = getBaseUrl(req);
  const suffix = String(pathname || '');
  return suffix.startsWith('/') ? base + suffix : `${base}/${suffix}`;
}

/**
 * বুট-টাইম যাচাই। app.js স্টার্টআপে ডাকে, যাতে ভুল কনফিগ প্রথম রিসেট
 * ইমেইলের সময় নয় — ডিপ্লয়ের সময়ই ধরা পড়ে।
 */
function assertConfigured() {
  if (!isProduction()) return { ok: true, skipped: true };
  const url = getBaseUrl(null);
  return { ok: true, url };
}

module.exports = { getBaseUrl, buildUrl, assertConfigured };
