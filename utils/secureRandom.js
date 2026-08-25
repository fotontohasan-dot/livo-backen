// utils/secureRandom.js
// আসল-টাকার আউটকাম (গেম রেজাল্ট, পুরস্কার, ক্র্যাশ পয়েন্ট) কখনো Math.random()
// দিয়ে ঠিক করা যাবে না। V8-এর Math.random() হলো xorshift128+ — CSPRNG নয়।
// অল্প কিছু আউটপুট দেখেই এর ভেতরের state বের করে ফেলা যায়, তারপর পরের সব
// আউটকাম আগেভাগে জানা সম্ভব। Aviator-এর ক্ষেত্রে ঝুঁকি সবচেয়ে বেশি, কারণ
// crash_point DB-তে জমা হয় ও প্লেয়ারকে দেখানো হয় — অর্থাৎ আক্রমণকারী
// generator-এর কাঁচা আউটপুটের ধারাবাহিক নমুনাই হাতে পেয়ে যায়।
//
// এখানকার সব ফাংশন crypto.randomInt()-এর উপর দাঁড়ানো, যা rejection sampling
// করে uniform ও cryptographically secure মান দেয়।

const crypto = require('crypto');

// ৫৩-বিট (JS float-এর পূর্ণ mantissa) এনট্রপি — Math.random()-এর মতোই [0, 1)
const FLOAT_DENOMINATOR = 2 ** 53;

// [0, 1) রেঞ্জে uniform float. Math.random()-এর সরাসরি drop-in বিকল্প।
function randomFloat() {
  // crypto.randomInt এক কলে সর্বোচ্চ 2^48 রেঞ্জ দেয়, তাই ২৬ + ২৭ বিট জোড়া লাগানো
  const high = crypto.randomInt(0, 2 ** 26); // ২৬ বিট
  const low = crypto.randomInt(0, 2 ** 27);  // ২৭ বিট
  return (high * (2 ** 27) + low) / FLOAT_DENOMINATOR;
}

// [0, maxExclusive) রেঞ্জে uniform integer — Math.floor(Math.random() * n)-এর বিকল্প
function randomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('randomInt: maxExclusive অবশ্যই ধনাত্মক integer হতে হবে');
  }
  return crypto.randomInt(0, maxExclusive);
}

// [min, max] — দুই প্রান্তই অন্তর্ভুক্ত
function randomIntInclusive(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new RangeError('randomIntInclusive: min ও max integer হতে হবে');
  }
  if (max < min) throw new RangeError('randomIntInclusive: max অবশ্যই min-এর সমান বা বড় হতে হবে');
  return crypto.randomInt(min, max + 1);
}

// probability p (0..1) অনুযায়ী true/false — Math.random() < p -এর বিকল্প।
// float তুলনার বদলে integer তুলনা, যাতে odds ঠিক যতটা বলা হয়েছে ততটাই থাকে।
const CHANCE_PRECISION = 1_000_000;
function chance(probability) {
  if (typeof probability !== 'number' || Number.isNaN(probability)) {
    throw new RangeError('chance: probability সংখ্যা হতে হবে');
  }
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  return crypto.randomInt(0, CHANCE_PRECISION) < Math.round(probability * CHANCE_PRECISION);
}

// অ্যারে থেকে uniform একটা এলিমেন্ট
function pick(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RangeError('pick: খালি নয় এমন array লাগবে');
  }
  return items[crypto.randomInt(0, items.length)];
}

// weight অনুযায়ী নির্বাচন। weight ভগ্নাংশ হতে পারে (যেমন 0.3), তাই সব weight
// একটা সাধারণ scale দিয়ে integer বানিয়ে integer রেঞ্জে ড্র করা হয় — float
// জমা করলে rounding-এ সম্ভাবনা সামান্য সরে যেত।
const WEIGHT_SCALE = 1_000_000;
function weightedIndex(weights) {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new RangeError('weightedIndex: খালি নয় এমন array লাগবে');
  }
  const scaled = weights.map((w) => {
    const n = Math.round(Number(w) * WEIGHT_SCALE);
    if (!Number.isFinite(n) || n < 0) throw new RangeError('weightedIndex: weight অঋণাত্মক সংখ্যা হতে হবে');
    return n;
  });
  const total = scaled.reduce((sum, w) => sum + w, 0);
  if (total <= 0) throw new RangeError('weightedIndex: মোট weight শূন্যের বেশি হতে হবে');

  let draw = crypto.randomInt(0, total);
  for (let i = 0; i < scaled.length; i++) {
    if (draw < scaled[i]) return i;
    draw -= scaled[i];
  }
  return scaled.length - 1; // unreachable, তবু নিরাপদ fallback
}

module.exports = {
  randomFloat,
  randomInt,
  randomIntInclusive,
  chance,
  pick,
  weightedIndex
};
