// services/oddsResolver.js
// বাজির অডস সবসময় সার্ভার থেকেই আসতে হবে।
//
// আগে routes/matches.js ক্লায়েন্টের পাঠানো `odd` সরাসরি bets.odd-এ লিখত, আর
// সেটেলমেন্টে পেআউট হিসাব হয় `stake * bets.odd` দিয়ে (routes/admin.js) — অর্থাৎ
// রিকোয়েস্টে বড় odd পাঠিয়ে দিলে জেতা বাজিতে যত খুশি কয়েন তোলা যেত।
// services/accumulator.js-এও market.odds না থাকলে ক্লায়েন্টের odd fallback হিসেবে
// ব্যবহৃত হতো, একই সমস্যা।
//
// এখানকার resolveOdd() শুধু সার্ভারে জমা market.odds, নাহলে সার্ভার-নির্ধারিত
// ডিফল্ট ব্যবহার করে। ক্লায়েন্টের পাঠানো মান কখনো অডস হিসেবে গণ্য হয় না।

// ডিফল্ট অডস — views/match-detail.ejs যা দেখায় ঠিক তাই, যাতে market.odds ফাঁকা
// থাকলে প্লেয়ার যে সংখ্যাটা দেখে বাজি ধরেছে সেটাই সার্ভারে গণ্য হয়।
const DEFAULT_ODDS = {
  bookmaker: { '0': 1.85, '1': 2.10 },
  default: { yes: 1.75 }
};

// পেআউট বিস্ফোরণ ঠেকাতে সর্বোচ্চ সীমা — কোনো বৈধ মার্কেটে এর বেশি অডস থাকা উচিত না।
const MAX_ODD = 1000;

function defaultsFor(marketType) {
  return DEFAULT_ODDS[marketType] || DEFAULT_ODDS.default;
}

function toValidOdd(raw) {
  const odd = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(odd)) return null;
  if (odd <= 1 || odd > MAX_ODD) return null;
  return odd;
}

// market: markets টেবিলের রো (type, odds JSONB সহ)
// runner: ক্লায়েন্টের বেছে নেওয়া রানার কী — শুধু কোন অডস তুলতে হবে তা ঠিক করে,
//         মানটা নিজে কখনো অডস হয়ে যায় না।
// return: সংখ্যা, নাহলে null (তখন কলার বাজি বাতিল করবে)
function resolveOdd(market, runner) {
  if (!market) return null;

  const key = runner === null || runner === undefined ? null : String(runner);
  if (!key) return null;

  const stored = market.odds && typeof market.odds === 'object' ? market.odds[key] : undefined;
  if (stored !== undefined && stored !== null) {
    return toValidOdd(stored);
  }

  const fallback = defaultsFor(market.type)[key];
  if (fallback !== undefined) return toValidOdd(fallback);

  // অজানা রানার — এই মার্কেটে এমন কোনো সিলেকশন নেই।
  return null;
}

module.exports = { resolveOdd, MAX_ODD, DEFAULT_ODDS };
