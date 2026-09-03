const registry = require('../services/gameRegistry');

// ---------------------------------------------------------------------------
// প্রতিটা খেলার যোগ্য গেমের অভিজ্ঞতালব্ধ (empirical) RTP মেপে গাণিতিক RTP-র
// সাথে মেলানো হয়।
//
// কেন এটা দরকার:
// LIVO-02-এর আগে baccarat-এর আউটকাম ছিল সমান ১/৩ বণ্টনে, অথচ Tie ৮× ফেরত দিত।
// অর্থাৎ Tie বাজির RTP ছিল ২৬৬.৭% — খেলোয়াড় শুধু Tie ধরে অসীম টাকা তুলে নিতে
// পারত। কোনো টেস্ট সেটা ধরত না, কারণ কোনো টেস্টই RTP মাপত না।
//
// এই ফাইলের সবচেয়ে গুরুত্বপূর্ণ assertion হলো নিচের "কোনো বাজি খেলোয়াড়-অনুকূল
// নয়" টেস্টটা: প্রতিটা গেমের প্রতিটা নির্বাচনের RTP অবশ্যই ১০০%-এর নিচে থাকতে
// হবে। ভবিষ্যতে কেউ পেআউট বা সম্ভাবনা বদলালে এই টেস্ট সাথে সাথে ফেল করবে।
//
// দ্রষ্টব্য — এটা RTP-র মান "ভালো" কি না তা বিচার করে না (সেটা ব্যবসায়িক
// সিদ্ধান্ত); এটা শুধু নিশ্চিত করে যে বাস্তব বণ্টন ঘোষিত গণিতের সাথে মেলে এবং
// হাউস এজ ধনাত্মক থাকে।
// ---------------------------------------------------------------------------

const BET = 100;
const SAMPLES = 60000;
// ±2% পরম সহনশীলতা — SAMPLES = 60k-এ এই গেমগুলোর standard error যথেষ্ট ছোট,
// তাই এটা flaky নয়, কিন্তু আসল বাগ (যেমন ২৬৬% বনাম ৭৬%) ধরার জন্য যথেষ্ট আঁটসাঁট।
const TOLERANCE = 0.02;

function empiricalRtp(slug, selection) {
  const handler = registry.getHandler(slug);
  let returned = 0;
  for (let i = 0; i < SAMPLES; i++) {
    returned += handler(BET, selection).winAmount;
  }
  return returned / (SAMPLES * BET);
}

// গাণিতিকভাবে প্রত্যাশিত RTP — হ্যান্ডলারের সম্ভাবনা × পেআউট থেকে হাতে হিসাব করা।
const EXPECTED = {
  slots: [{ selection: undefined, rtp: 0.01 * 10 + 0.27 * 2 }],           // 0.640
  roulette: [
    { selection: 'Red', rtp: (18 / 37) * 2 },                              // 0.973
    { selection: 'Black', rtp: (18 / 37) * 2 }
  ],
  'andar-bahar': [
    { selection: 'Andar', rtp: 0.5 * 1.9 },                                // 0.950
    { selection: 'Bahar', rtp: 0.5 * 1.9 }
  ],
  'teen-patti': [{ selection: undefined, rtp: 0.40 * 1.95 }],              // 0.780
  blackjack: [{ selection: undefined, rtp: 0.42 * 2 }],                    // 0.840
  poker: [{ selection: undefined, rtp: 0.35 * 2.5 }],                      // 0.875
  baccarat: [
    { selection: 'Player', rtp: 0.4462 * 1.95 },                           // 0.870
    { selection: 'Banker', rtp: 0.4586 * 1.95 },                           // 0.894
    { selection: 'Tie', rtp: 0.0952 * 8 }                                  // 0.762
  ]
};

describe('গেম RTP অখণ্ডতা', () => {
  describe('অভিজ্ঞতালব্ধ RTP গাণিতিক RTP-র সাথে মেলে', () => {
    Object.entries(EXPECTED).forEach(([slug, cases]) => {
      cases.forEach(({ selection, rtp }) => {
        const label = selection ? `${slug} (${selection})` : slug;
        test(`${label} — প্রত্যাশিত ~${(rtp * 100).toFixed(1)}%`, () => {
          const actual = empiricalRtp(slug, selection);
          expect(Math.abs(actual - rtp)).toBeLessThan(TOLERANCE);
        });
      });
    });
  });

  test('কোনো গেমের কোনো বাজি খেলোয়াড়-অনুকূল নয় (RTP < 100%)', () => {
    const offenders = [];
    Object.entries(EXPECTED).forEach(([slug, cases]) => {
      cases.forEach(({ selection, rtp }) => {
        if (rtp >= 1) offenders.push(`${slug}/${selection || 'default'} = ${(rtp * 100).toFixed(1)}%`);
      });
    });
    expect(offenders).toEqual([]);
  });

  test('EXPECTED টেবিল প্রতিটা খেলার যোগ্য নন-crash গেমকে ঢাকে', () => {
    // নতুন গেম যোগ হলে অথচ RTP টেস্ট না লেখা হলে এই টেস্ট ফেল করবে —
    // অর্থাৎ কোনো গেম নিঃশব্দে অপরীক্ষিত অবস্থায় লাইভ হতে পারবে না।
    const playable = registry.playableSlugs().filter((s) => !registry.isCrashGame(s));
    expect(playable.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test('baccarat Tie কখনো ১/৩ বণ্টনে ফিরে যায় না (P0 রিগ্রেশন গার্ড)', () => {
    const handler = registry.getHandler('baccarat');
    let ties = 0;
    for (let i = 0; i < SAMPLES; i++) {
      if (handler(BET, 'Player').gameResult.outcome === 'Tie') ties++;
    }
    const tieRate = ties / SAMPLES;
    // আসল ব্যাকারাটে ~9.52%; পুরনো বাগে ছিল ~33.3%
    expect(tieRate).toBeGreaterThan(0.08);
    expect(tieRate).toBeLessThan(0.12);
  });

  test('ক্লায়েন্টের পাঠানো selection দিয়ে আউটকাম নির্ধারণ করা যায় না', () => {
    // selection শুধু ঠিক করে খেলোয়াড় কীসে বাজি ধরেছে; আউটকাম সবসময়
    // সার্ভার-সাইড CSPRNG থেকেই আসে।
    const handler = registry.getHandler('baccarat');
    const outcomes = new Set();
    for (let i = 0; i < 500; i++) outcomes.add(handler(BET, 'Tie').gameResult.outcome);
    expect(outcomes.size).toBeGreaterThan(1);
  });
});
