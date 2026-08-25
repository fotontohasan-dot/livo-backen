// utils/identity.js
// ইমেইল/ইউজারনেম/ফোন সংরক্ষণ ও খোঁজা — দুটোই একই নিয়মে।
//
// আগে ভ্যালিডেশনে `.trim()` করা হতো কিন্তু INSERT-এ কাঁচা মানটাই যেত, আর সব
// lookup ছিল হুবহু (case-sensitive) মিলে। ফলে:
//   - " Foo@x.com " ভ্যালিডেশন পাস করে স্পেসসহ জমা হতো, পরে লগইনে আর মিলত না;
//   - Foo@x.com আর foo@x.com দুটো আলাদা অ্যাকাউন্ট হয়ে যেত, অথচ একই ইনবক্স;
//   - Google Sign-In (findOrCreateGoogleUser) Google-এর পাঠানো lowercase ইমেইল
//     দিয়ে খুঁজত, তাই মিশ্র-কেসে রেজিস্টার করা অ্যাকাউন্টের সাথে লিঙ্ক না হয়ে
//     একই মানুষের জন্য দ্বিতীয় অ্যাকাউন্ট তৈরি করত;
//   - পাসওয়ার্ড রিসেট `WHERE email = $1`-এর প্রথম রো ধরত — একাধিক ভ্যারিয়েন্ট
//     থাকলে কোনটায় মেইল যাবে তা অনিশ্চিত।
//
// ইমেইলের ডোমেইন অংশ সংজ্ঞা অনুযায়ীই case-insensitive; local অংশ কাগজে-কলমে
// case-sensitive হতে পারলেও বাস্তবে কোনো বড় প্রোভাইডার তা আলাদা করে না, আর
// "একই ইনবক্স = একই অ্যাকাউন্ট" ধরে নেওয়াটাই এখানে নিরাপদ দিক।

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  return username || null;
}

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  // ফোনে শুধু অঙ্ক রাখা হয় না — ফরম্যাট ভ্যালিডেশন (^01\d{9}$) কলার দিকেই থাকে।
  const phone = value.trim();
  return phone || null;
}

// লগইন ফর্মের একক ইনপুট — ইমেইল বা ফোন দুটোই হতে পারে।
function normalizeIdentifier(value) {
  if (typeof value !== 'string') return null;
  const identifier = value.trim();
  if (!identifier) return null;
  return identifier.includes('@') ? identifier.toLowerCase() : identifier;
}

module.exports = { normalizeEmail, normalizeUsername, normalizePhone, normalizeIdentifier };
