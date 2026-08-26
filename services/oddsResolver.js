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

// যে মার্কেটে কোনো অডস সংরক্ষিত নেই তার জন্য শেষ ফলব্যাক। match-detail পেজে
// bookmaker-এর প্রথম রানারের ডিফল্টও এটাই, তাই প্লেয়ার যা দেখে তার সাথে মেলে।
const FALLBACK_ODD = 1.85;

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

// markets.odds কলামটা JSONB, কিন্তু এতে দুই রকম আকার জমা হয়:
//
//   ১. অবজেক্ট — runner কী → অডস, যেমন {"0": 1.85, "1": 2.10}
//      (views/match-detail.ejs এই আকারই ধরে নেয়)
//   ২. একক সংখ্যা — অ্যাডমিন প্যানেলের ফর্ম (views/admin/markets.ejs) `odds`
//      ফিল্ডে একটাই সংখ্যা পাঠায় (`<input type="number" name="odds">`), আর
//      routes/admin.js সেটা সরাসরি JSONB-তে লেখে। Postgres সেটা বৈধ JSON
//      number হিসেবেই রাখে, অর্থাৎ market.odds === 1.85। এখানে পুরো মার্কেট
//      সারিটাই এক রানার (name = "Team A Win"), তাই ওই সংখ্যাটাই এই বাজির অডস।
//
// শুধু অবজেক্ট আকার ধরে নিলে অ্যাডমিনের তৈরি প্রতিটি মার্কেটে বাজি ধরা বন্ধ
// হয়ে যায় — দুটো আকারই সামলানো লাগে।
function readStoredOdd(market, key) {
  const odds = market.odds;
  if (odds === null || odds === undefined) return undefined;

  if (typeof odds === 'number' || typeof odds === 'string') {
    return odds;
  }
  if (typeof odds === 'object' && !Array.isArray(odds)) {
    return odds[key];
  }
  return undefined;
}

// market: markets টেবিলের রো (type, odds JSONB সহ)
// runner: ক্লায়েন্টের বেছে নেওয়া রানার কী — শুধু কোন অডস তুলতে হবে তা ঠিক করে,
//         মানটা নিজে কখনো অডস হয়ে যায় না।
// return: সংখ্যা, নাহলে null (তখন কলার বাজি বাতিল করবে)
function resolveOdd(market, runner) {
  if (!market) return null;

  const key = runner === null || runner === undefined ? null : String(runner);
  if (!key) return null;

  const stored = readStoredOdd(market, key);
  if (stored !== undefined && stored !== null) {
    return toValidOdd(stored);
  }

  const fallback = defaultsFor(market.type)[key];
  if (fallback !== undefined) return toValidOdd(fallback);

  // এখানে পৌঁছানো মানে: রানারটি মার্কেটের জমা অডসেও নেই, ওই মার্কেট-টাইপের
  // ডিফল্ট তালিকাতেও নেই — অর্থাৎ ক্লায়েন্ট এমন একটা রানার পাঠিয়েছে যা এই
  // মার্কেটে আদৌ নেই।
  //
  // আগে এই অবস্থায় FALLBACK_ODD (1.85) ফেরত যেত, ফলে বানানো রানার নামেও
  // বাজি বসে যেত। সেটেলমেন্টের সময় ওই রানার কোনো ফলাফলের সাথে মেলে না, তাই
  // বাজিটা অনির্দিষ্টকাল pending থেকে যেত বা ভুলভাবে সেটেল হতো — দুটোই
  // রিপোর্টিং ও পেআউটের হিসাব নষ্ট করে।
  //
  // সঠিক আচরণ: অচেনা রানার প্রত্যাখ্যান করা। null পেলে কলার বাজি বাতিল করে।
  // এতে অডস-বিহীন বৈধ মার্কেটও আটকাবে — সেটাই কাম্য, কারণ সার্ভার যে অডসে
  // বাজি নিচ্ছে সেটা জানা না থাকলে বাজি নেওয়াই উচিত নয়।
  return null;
}

module.exports = { resolveOdd, MAX_ODD, DEFAULT_ODDS, FALLBACK_ODD };
