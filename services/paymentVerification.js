// services/paymentVerification.js
// ---------------------------------------------------------------------------
// পেমেন্ট কলব্যাক যাচাইয়ের বিশুদ্ধ (pure) হেল্পার — কোনো নেটওয়ার্ক কল নেই, কোনো
// গেটওয়ে ক্রেডেনশিয়াল নেই।
//
// কেন আলাদা মডিউল: এই যুক্তিগুলো প্রথমে services/sslcommerz.js-এ রাখা হয়েছিল, কিন্তু
// টেস্টে ওই মডিউলটা পুরোপুরি jest.mock() দিয়ে বদলে ফেলা হয় (গেটওয়েতে আসল HTTP কল
// এড়াতে)। ফলে মকড টেস্টে currency/amount যাচাই নিঃশব্দে অদৃশ্য হয়ে যেত — অর্থাৎ একটা
// নিরাপত্তা পরীক্ষা টেস্ট-ডাবল দিয়ে নিষ্ক্রিয় করা যেত। যাচাইয়ের যুক্তি তাই I/O মডিউলের
// বাইরে রাখা হয়েছে, যাতে গেটওয়ে স্টাব করলেও যাচাই চলতেই থাকে।
// ---------------------------------------------------------------------------

// initPayment() সবসময় currency: 'BDT' দিয়ে সেশন খোলে, তাই ভ্যালিডেশন রেসপন্সেও
// BDT-ই ফেরত আসার কথা।
const EXPECTED_CURRENCY = 'BDT';

/**
 * ট্রানজেকশনটা প্রত্যাশিত মুদ্রায় সেটল হয়েছে কিনা।
 *
 * আগে কলব্যাকে শুধু status, amount আর tran_id মেলানো হতো — currency কখনো দেখা হতো না।
 * ফলে ভিন্ন মুদ্রায় সেটল হওয়া ট্রানজেকশনের সংখ্যাগত তুলনা (100 === 100) পাস করে যেত,
 * যদিও আসল মূল্য বহুগুণ কম হতে পারত।
 *
 * প্রোভাইডার ফিল্ডটা একেবারে না পাঠালে (স্যান্ডবক্স/পুরনো API রেসপন্স) currency দিয়ে
 * reject করা হয় না — সেটা সব বৈধ পেমেন্ট আটকে দিত। ওই ক্ষেত্রে amount তুলনাই ভরসা।
 */
function isExpectedCurrency(verification) {
  const currency = verification && (verification.currency_type || verification.currency);
  if (!currency) return true;
  return String(currency).toUpperCase() === EXPECTED_CURRENCY;
}

/**
 * তুলনার জন্য নির্ভরযোগ্য অঙ্ক — স্টোর কারেন্সিতে (BDT) সেটল হওয়া মান।
 *
 * SSLCommerz-এ `amount` স্টোর কারেন্সির অঙ্ক, আর `currency_amount` লেনদেনের মূল
 * মুদ্রার অঙ্ক। আগে কোথাও কোথাও currency_amount-কে অগ্রাধিকার দেওয়া হতো, যা BDT-র
 * সাথে তুলনা করলে ভুল ফল দিত।
 *
 * অঙ্কটা সংখ্যা না হলে (NaN/Infinity/অনুপস্থিত) null ফেরত দেয়, যাতে NaN কখনো
 * তুলনায় গিয়ে নীরবে false হয়ে না যায় — কল সাইট স্পষ্টভাবে reject করতে পারে।
 */
function storeAmountOf(verification) {
  if (!verification) return null;
  const raw = verification.amount != null ? verification.amount : verification.currency_amount;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * ভ্যালিডেশন রেসপন্সের অঙ্ক রিকোয়েস্টের অঙ্কের সমান কিনা।
 * টাকার তুলনা পূর্ণসংখ্যায় (নিকটতম) — ভাসমান দশমিকের তুলনা এড়াতে।
 */
function amountMatchesRequest(verification, requestAmount) {
  const verified = storeAmountOf(verification);
  if (verified === null) return false;
  const expected = Number(requestAmount);
  if (!Number.isFinite(expected)) return false;
  return Math.round(verified) === Math.round(expected);
}

module.exports = { EXPECTED_CURRENCY, isExpectedCurrency, storeAmountOf, amountMatchesRequest };
