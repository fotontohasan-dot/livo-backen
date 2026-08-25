// services/gameFairness.js
// ---------------------------------------------------------------------------
// গেমের ফলাফল-বণ্টনের গাণিতিক মডেল — রুট হ্যান্ডলার থেকে আলাদা রাখা হয়েছে যাতে
// প্রত্যাশিত মান (RTP) সরাসরি ইউনিট-টেস্ট করা যায়, HTTP স্তর ছাড়াই।
//
// কেন এই ফাইল: অডিটে ধরা পড়েছে দুটো গেমের বণ্টন গাণিতিকভাবে ভুল ছিল এবং দুটোতেই
// হাউস এজ *ঋণাত্মক* ছিল — অর্থাৎ খেলোয়াড়ের পক্ষে। পরিমাপ করা হয়েছে:
//   • ক্র্যাশ: crashPoint ~ Uniform(1,10) হওয়ায় m×-এ ক্যাশআউটের EV = m(10−m)/9,
//     যা 1 < m < 9 পুরো রেঞ্জেই ১-এর বেশি। ৫×-এ RTP মাপা হয়েছে ২৭৭%।
//   • ব্যাকারাট: Player/Banker/Tie সমান ১/৩ সম্ভাবনায় বাছা হতো, অথচ Tie ৮× পে করত
//     — RTP মাপা হয়েছে ২৬৬%।
// দুটোই এখানে সঠিক মডেল দিয়ে প্রতিস্থাপিত।
// ---------------------------------------------------------------------------

const { secureRandom, secureWeightedPick } = require('./rng');

// ==================== ক্র্যাশ / এভিয়েটর ====================
//
// লক্ষ্য: ক্যাশআউট পয়েন্ট m যাই হোক, প্রত্যাশিত রিটার্ন সবসময় (1 − edge) হবে।
// সেটা পেতে হলে দরকার:  P(crash ≥ m) = (1 − edge) / m
// কারণ তখন EV(m) = m · P(crash ≥ m) = (1 − edge) — m-নিরপেক্ষ ধ্রুবক।
//
// এর CDF:  F(m) = P(crash < m) = 1 − (1 − edge)/m
// ইনভার্স ট্রান্সফর্ম (U ~ Uniform[0,1)):  m = (1 − edge) / (1 − U)
// U < edge হলে m < 1 হয় — সেটাই তাৎক্ষণিক bust (1.00×), যার সম্ভাবনা ঠিক edge।
//
// এটাই ইন্ডাস্ট্রি-স্ট্যান্ডার্ড ক্র্যাশ বণ্টন। আগের Uniform(1,10) কোনো অর্থেই
// ক্র্যাশ গেমের বণ্টন ছিল না।

const DEFAULT_HOUSE_EDGE = 0.03;   // ৩% — RTP ৯৭%
const DEFAULT_MAX_MULTIPLIER = 1000;

/**
 * @param {object} opts
 * @param {number} opts.edge — হাউস এজ, 0 ≤ edge < 1
 * @param {number} opts.maxMultiplier — কঠিন সিলিং (unbounded payout ঠেকাতে)
 * @param {function} opts.rng — টেস্টে ইনজেক্ট করার জন্য; ডিফল্ট CSPRNG
 * @returns {number} crash point, দুই দশমিক স্থানে, সবসময় ≥ 1.00
 */
function generateCrashPoint({ edge = DEFAULT_HOUSE_EDGE, maxMultiplier = DEFAULT_MAX_MULTIPLIER, rng = secureRandom } = {}) {
  if (!(edge >= 0 && edge < 1)) throw new Error('generateCrashPoint: edge must be in [0,1)');
  if (!(maxMultiplier > 1)) throw new Error('generateCrashPoint: maxMultiplier must be > 1');

  const u = rng();
  // u → 1 হলে raw → ∞; maxMultiplier ক্ল্যাম্প সেটা ধরে। 1 − u কখনো ঠিক ০ হয় না
  // কারণ secureRandom() [0,1)-এ থাকে, তবু প্রতিরক্ষামূলকভাবে ক্ল্যাম্প করা হচ্ছে।
  const raw = (1 - edge) / Math.max(1 - u, Number.EPSILON);
  const clamped = Math.min(Math.max(raw, 1), maxMultiplier);
  // নিচের দিকে রাউন্ড (floor) — রাউন্ড-আপ করলে ক্র্যাশ পয়েন্ট সামান্য বেশি হয়ে
  // হাউস এজ কমে যেত। floor সবসময় হাউসের অনুকূলে, কখনো বিপরীতে নয়।
  return Math.floor(clamped * 100) / 100;
}

// ==================== ব্যাকারাট ====================
//
// ৮-ডেক ব্যাকারাটের প্রকৃত ফলাফল-সম্ভাবনা (স্ট্যান্ডার্ড, ব্যাপকভাবে প্রকাশিত মান):
//   Banker 45.86%, Player 44.62%, Tie 9.52%
// পেআউট (মোট রিটার্ন, স্টেক সহ):
//   Banker জয় → 1.95×  (1:1 minus 5% কমিশন)
//   Player জয় → 2.00×  (1:1)
//   Tie জয়    → 9.00×  (8:1)
//   Tie হলে Player/Banker বাজি push (স্টেক ফেরত, 1.00×) — এটাই আসল ব্যাকারাটের নিয়ম
//     এবং এটাই ব্যাংকার/প্লেয়ার বাজিকে ~৯৮.৯% RTP-তে নিয়ে আসে। আগের কোডে push ছিল না।
//
// ফলিত RTP:  Banker 0.4586·1.95 + 0.0952·1 = 98.9%
//            Player 0.4462·2.00 + 0.0952·1 = 98.8%
//            Tie    0.0952·9.00            = 85.7%

const BACCARAT_OUTCOMES = [
  { outcome: 'Banker', weight: 0.4586 },
  { outcome: 'Player', weight: 0.4462 },
  { outcome: 'Tie',    weight: 0.0952 }
];

const BACCARAT_SELECTIONS = ['Player', 'Banker', 'Tie'];

function isValidBaccaratSelection(selection) {
  return typeof selection === 'string' && BACCARAT_SELECTIONS.includes(selection);
}

/**
 * @returns {{ outcome: string, multiplier: number }} multiplier = মোট রিটার্ন গুণক
 *          (0 = হার, 1 = push/স্টেক ফেরত, >1 = জয়)
 */
function playBaccarat(selection, { pick = secureWeightedPick } = {}) {
  if (!isValidBaccaratSelection(selection)) {
    throw new Error('playBaccarat: invalid selection');
  }
  const { outcome } = pick(BACCARAT_OUTCOMES);

  if (outcome === selection) {
    if (outcome === 'Tie') return { outcome, multiplier: 9 };
    return { outcome, multiplier: outcome === 'Banker' ? 1.95 : 2 };
  }
  // Tie হলে Player/Banker বাজি push — স্টেক ফেরত, লাভ-ক্ষতি নেই
  if (outcome === 'Tie') return { outcome, multiplier: 1 };
  return { outcome, multiplier: 0 };
}

module.exports = {
  generateCrashPoint,
  playBaccarat,
  isValidBaccaratSelection,
  BACCARAT_OUTCOMES,
  BACCARAT_SELECTIONS,
  DEFAULT_HOUSE_EDGE,
  DEFAULT_MAX_MULTIPLIER
};
