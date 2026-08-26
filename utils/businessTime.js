// utils/businessTime.js
// ব্যবসায়িক দিনের একমাত্র সংজ্ঞা।
//
// কোডবেসে "আজ" তিনভাবে হিসাব হতো:
//   • `new Date().toISOString().slice(0,10)` — UTC দিন
//   • `SQL CURRENT_DATE` — ডাটাবেস সার্ভারের টাইমজোন (Render-এ UTC)
//   • `new Date(now + 6*3600*1000)` — হাতে করা UTC+6 অফসেট (redpacket)
//
// ফলে একই ইউজারের কাছে "আজ" ফিচারভেদে আলাদা সময়ে পাল্টাত। রাত ১২টা থেকে
// ভোর ৬টার মধ্যে ডেইলি রিওয়ার্ড একবার রিসেট হতো, মিশন আরেক সময়ে, ডিপোজিট
// লিমিট তৃতীয় সময়ে — ইউজার একই রাতে দুবার ডেইলি বোনাস দাবি করতে পারত।
//
// হাতে করা `+6 ঘণ্টা` অফসেটের আরেকটা সমস্যা: এটা টাইমজোন নয়, শুধু যোগ।
// বাংলাদেশ ভবিষ্যতে ডে-লাইট সেভিং চালু করলে (২০০৯-এ একবার করেছিল) হিসাব
// নিঃশব্দে ভুল হয়ে যেত। `Intl` ব্যবহার করলে সেই ঝুঁকি নেই।

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'Asia/Dhaka';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** ব্যবসায়িক টাইমজোনে দিনের তারিখ, 'YYYY-MM-DD'। */
function businessDay(date = new Date()) {
  return dayFormatter.format(date);
}

/** আজকের ব্যবসায়িক দিন। */
function today() {
  return businessDay();
}

/** 'YYYY-MM-DD' + দিন যোগ/বিয়োগ, একই ফরম্যাটে। */
function addDays(dayStr, days) {
  const d = new Date(`${dayStr}T12:00:00Z`); // দুপুর — অফসেট যাই হোক দিন বদলাবে না
  d.setUTCDate(d.getUTCDate() + days);
  return businessDay(d);
}

/** ব্যবসায়িক দিনের শুরু, UTC Date হিসেবে — SQL রেঞ্জ কোয়েরির জন্য। */
function startOfDay(dayStr = today()) {
  const [y, m, d] = dayStr.split('-').map(Number);
  // টাইমজোন অফসেট বের করে UTC মুহূর্তে রূপান্তর
  const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetMinutes = tzOffsetMinutes(guess);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60 * 1000);
}

/** ব্যবসায়িক দিনের শেষ (পরের দিনের শুরু), UTC Date। */
function endOfDay(dayStr = today()) {
  return startOfDay(addDays(dayStr, 1));
}

/** নির্দিষ্ট মুহূর্তে ব্যবসায়িক টাইমজোনের UTC অফসেট (মিনিটে)। */
function tzOffsetMinutes(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(at).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * SQL-এ ব্যবহারের জন্য টাইমজোন নাম। `DATE(created_at AT TIME ZONE $tz)`
 * লেখার সময় হার্ডকোড না করে এখান থেকে নিলে সব জায়গায় একই সংজ্ঞা থাকে।
 */
function sqlTimezone() {
  return BUSINESS_TZ;
}

module.exports = { today, businessDay, addDays, startOfDay, endOfDay, sqlTimezone, tzOffsetMinutes, BUSINESS_TZ };
