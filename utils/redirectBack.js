// utils/redirectBack.js
// ---------------------------------------------------------------------------
// Express-এর `res.redirect('back')` / `res.location('back')` deprecated (Express 5-এ
// সম্পূর্ণ সরিয়ে ফেলা হয়েছে)। অফিসিয়াল রিপ্লেসমেন্ট হলো `req.get('Referrer') || '/'`,
// কিন্তু Referrer হেডার সম্পূর্ণভাবে ক্লায়েন্ট-নিয়ন্ত্রিত — সেটাকে সরাসরি redirect-এ বসিয়ে
// দিলে open redirect তৈরি হয় (আক্রমণকারী ভিক্টিমকে নিজের সাইটে পাঠিয়ে ফিশিং করতে পারে)।
//
// তাই এখানে Referrer শুধু তখনই ব্যবহার হয় যখন সেটা নিশ্চিতভাবে এই সাইটেরই একটা পাথ:
//   • প্রোটোকল-রিলেটিভ (`//evil.com`) বা absolute URL হলে host মিলিয়ে দেখা হয়,
//   • না মিললে (বা Referrer না থাকলে) নিরাপদ ফলব্যাক পাথে পাঠানো হয়।
// রিটার্ন সবসময় একটা সাইট-রিলেটিভ পাথ, কখনো বাইরের absolute URL নয়।
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Request} req
 * @param {string} fallback — Referrer অনুপস্থিত/অবিশ্বস্ত হলে যেখানে পাঠানো হবে
 * @returns {string} নিরাপদ সাইট-রিলেটিভ পাথ
 */
function backUrl(req, fallback = '/') {
  const referrer = req.get('Referrer') || req.get('Referer') || '';
  if (!referrer) return fallback;

  // `//evil.com/x` — প্রোটোকল-রিলেটিভ, ব্রাউজার এটাকে বাইরের সাইট হিসেবেই ধরে
  if (referrer.startsWith('//')) return fallback;

  // সাইট-রিলেটিভ পাথ হলে সরাসরি নিরাপদ
  if (referrer.startsWith('/')) return referrer;

  try {
    const parsed = new URL(referrer);
    const host = req.get('host');
    if (host && parsed.host === host) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (e) {
    // পার্স করা না গেলে বিশ্বাস করার কিছু নেই
  }
  return fallback;
}

/** res.redirect('back')-এর সরাসরি রিপ্লেসমেন্ট। */
function redirectBack(req, res, fallback = '/') {
  res.redirect(backUrl(req, fallback));
}

module.exports = { backUrl, redirectBack };
