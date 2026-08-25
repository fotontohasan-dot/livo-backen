// services/rng.js
// ---------------------------------------------------------------------------
// টাকার ফলাফল নির্ধারণ করে এমন সব জায়গার জন্য ক্রিপ্টোগ্রাফিকভাবে নিরাপদ র‍্যান্ডমনেস।
//
// কেন দরকার: V8-এর Math.random() হলো xorshift128+ — দ্রুত, কিন্তু CSPRNG নয়। অল্প
// কয়েকটা আউটপুট দেখে তার ইন্টারনাল স্টেট পুনরুদ্ধার করা যায় এবং পরের সব আউটপুট
// পূর্বানুমান করা যায়। ক্র্যাশ গেমে crash point ইউজারকে হুবহু দেখানো হয়
// ("গেম ক্র্যাশ করেছে {value}x-এ"), অর্থাৎ আক্রমণকারীর হাতে একটা পরিষ্কার
// observation oracle আছে — শুধু বসে বসে ফলাফল রেকর্ড করলেই ভবিষ্যতের রাউন্ড
// প্রেডিক্ট করা সম্ভব হতো। routes/auth.js:592 ইতিমধ্যেই OTP-র জন্য crypto.randomInt
// ব্যবহার করে; এই মডিউল সেই একই মান বাকি আর্থিক পথগুলোতে নিয়ে আসে।
// ---------------------------------------------------------------------------

const crypto = require('crypto');

// ৪৮ বিট — Number.MAX_SAFE_INTEGER-এর অনেক নিচে, তাই পূর্ণসংখ্যা গণিত সবসময় নির্ভুল,
// আর একটা uniform double বানানোর জন্য যথেষ্ট রেজলিউশন (double-এর ম্যান্টিসা ৫৩ বিট)।
const RESOLUTION = 2 ** 48;

/** [0, 1) রেঞ্জে একটা uniform double, CSPRNG থেকে। Math.random()-এর সরাসরি বিকল্প। */
function secureRandom() {
  // randomBytes(6) = ৪৮ বিট। readUIntBE সর্বোচ্চ ৬ বাইট সাপোর্ট করে।
  return crypto.randomBytes(6).readUIntBE(0, 6) / RESOLUTION;
}

/** [min, max] (দুই প্রান্তসহ) রেঞ্জে একটা uniform পূর্ণসংখ্যা। */
function secureInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
    throw new Error('secureInt: invalid range');
  }
  if (hi === lo) return lo;
  // crypto.randomInt-এর upper bound exclusive, তাই +1
  return crypto.randomInt(lo, hi + 1);
}

/** একটা অ্যারে থেকে uniform-ভাবে একটা এলিমেন্ট বাছে। */
function securePick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('securePick: empty array');
  return arr[secureInt(0, arr.length - 1)];
}

/**
 * ওজনভিত্তিক (weighted) নির্বাচন। items = [{ weight, ... }]।
 * ভাসমান দশমিক ওজন সাপোর্ট করার জন্য মোট ওজনের সাপেক্ষে একটা secure uniform নেওয়া হয়।
 */
function secureWeightedPick(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('secureWeightedPick: empty');
  const total = items.reduce((s, x) => s + Number(x.weight || 0), 0);
  if (!(total > 0)) throw new Error('secureWeightedPick: total weight must be > 0');
  let r = secureRandom() * total;
  for (const item of items) {
    r -= Number(item.weight || 0);
    if (r < 0) return item;
  }
  return items[items.length - 1]; // ভাসমান-বিন্দু প্রান্তিক ক্ষেত্রে
}

module.exports = { secureRandom, secureInt, securePick, secureWeightedPick };
