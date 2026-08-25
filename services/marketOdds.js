// services/marketOdds.js
// ---------------------------------------------------------------------------
// মার্কেট অডসের একমাত্র authoritative উৎস।
//
// কেন এই মডিউল: আগে দুটো আলাদা বাজি-পথ (routes/matches.js-এর একক বাজি ও
// services/accumulator.js-এর পার্লে) নিজে নিজে অডস ঠিক করত, এবং দুটোই শেষ পর্যন্ত
// ক্লায়েন্টের পাঠানো `odd` ফিল্ডের উপর নির্ভর করত —
//   • routes/matches.js একেবারেই DB-র অডস পড়ত না, শুধু `oddNum > 1` যাচাই করে
//     ক্লায়েন্টের মানটাই bets.odd-এ লিখে দিত। সেটেলমেন্ট payout = stake × bets.odd,
//     তাই ১০ কয়েনের বাজিতে odd=9999999 পাঠিয়ে ১০ কোটি কয়েন তোলা সম্ভব ছিল
//     (পুনরুৎপাদন করা হয়েছে)।
//   • services/accumulator.js DB-র অডস পড়ত ঠিকই, কিন্তু runner কি-টা odds JSONB-তে
//     না থাকলে (markets.odds ডিফল্ট '{}') নিঃশব্দে ক্লায়েন্টের অডসে fallback করত।
//
// এখন দুটো পথই এই একটাই ফাংশন ব্যবহার করে, এবং এটা সবসময় fail-closed:
// runner অবশ্যই market.odds-এর একটা প্রকৃত কী হতে হবে, নাহলে বাজি প্রত্যাখ্যাত।
// ক্লায়েন্টের পাঠানো odd কখনো, কোনো অবস্থাতেই ব্যবহৃত হয় না।
// ---------------------------------------------------------------------------

// একটা বাজি বৈধ হওয়ার জন্য অডস অন্তত এর চেয়ে বেশি হতে হবে (১.০ মানে কোনো লাভ নেই)।
const MIN_VALID_ODD = 1;
// উপরের সীমা — bets.odd কলাম NUMERIC(10,2), কিন্তু বাস্তব কোনো মার্কেটে এর কাছাকাছিও
// অডস হয় না। অ্যাডমিন ভুল করে (বা কম্প্রোমাইজড অ্যাকাউন্ট থেকে) অস্বাভাবিক অডস বসালেও
// যাতে একটা কঠিন সিলিং থাকে।
const MAX_VALID_ODD = 1000;

/**
 * markets.odds কলামটা স্বাভাবিকভাবে JSONB (pg ড্রাইভার অবজেক্ট দেয়), কিন্তু পুরনো রো বা
 * ভিন্ন কলাম-টাইপে স্ট্রিংও আসতে পারে — সেক্ষেত্রে পার্স করার চেষ্টা করা হয়। পার্স না হলে
 * বা অবজেক্ট না হলে খালি অবজেক্ট, অর্থাৎ কোনো runner-ই মিলবে না (fail-closed)।
 */
function normalizeOddsMap(rawOdds) {
  let odds = rawOdds;
  if (typeof odds === 'string') {
    try { odds = JSON.parse(odds); } catch (e) { return {}; }
  }
  if (!odds || typeof odds !== 'object' || Array.isArray(odds)) return {};
  return odds;
}

/**
 * একটা মার্কেট রো ও ক্লায়েন্টের বেছে নেওয়া runner থেকে authoritative অডস বের করে।
 *
 * @param {object} market — markets টেবিলের সম্পূর্ণ রো
 * @param {*} runner — ক্লায়েন্টের পাঠানো runner (শুধু *কোন* ফলাফলে বাজি সেটা বোঝাতে,
 *                     কখনো অডসের মান বোঝাতে নয়)
 * @returns {{ ok: true, odd: number, runner: string } | { ok: false, reason: string }}
 *          reason: 'no_market' | 'no_odds' | 'invalid_runner' | 'unknown_runner' | 'invalid_odd'
 */
function resolveOdd(market, runner) {
  if (!market) return { ok: false, reason: 'no_market' };

  const odds = normalizeOddsMap(market.odds);
  const keys = Object.keys(odds);
  if (keys.length === 0) return { ok: false, reason: 'no_odds' };

  if (typeof runner !== 'string' || !runner.trim()) {
    return { ok: false, reason: 'invalid_runner' };
  }
  const key = runner.trim();

  // Object.prototype.hasOwnProperty দিয়ে যাচাই — সরাসরি odds[key] দেখলে
  // '__proto__'/'constructor'/'toString' এর মতো prototype-chain কী পাঠিয়ে
  // অপ্রত্যাশিত মান বের করে আনা যেত (prototype pollution-সংলগ্ন সারফেস)।
  if (!Object.prototype.hasOwnProperty.call(odds, key)) {
    return { ok: false, reason: 'unknown_runner' };
  }

  const odd = Number(odds[key]);
  if (!Number.isFinite(odd) || odd <= MIN_VALID_ODD || odd > MAX_VALID_ODD) {
    return { ok: false, reason: 'invalid_odd' };
  }

  // দুই দশমিক স্থানে নরমালাইজ — bets.odd কলাম NUMERIC(10,2), তাই স্টোর করা মান আর
  // এখানে হিসাব করা মান সবসময় হুবহু এক থাকে (সেটেলমেন্টের হিসাব যেন না বদলায়)।
  return { ok: true, odd: Math.round(odd * 100) / 100, runner: key };
}

module.exports = { resolveOdd, normalizeOddsMap, MIN_VALID_ODD, MAX_VALID_ODD };
