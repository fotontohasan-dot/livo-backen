// tests/security/gameFairness.test.js
// ---------------------------------------------------------------------------
// রিগ্রেশন গার্ড — অডিট P0-03 / P0-04 / P1-01।
//
// আগের আচরণ (পরিমাপ করা হয়েছিল):
//   • ক্র্যাশ: crashPoint ~ Uniform(1,10)। m×-এ ক্যাশআউটের EV = m(10−m)/9, যা
//     1 < m < 9 পুরো রেঞ্জেই ১-এর বেশি — ৫×-এ মাপা RTP ছিল ২৭৭%।
//   • ব্যাকারাট: তিনটা ফলাফল সমান ১/৩ সম্ভাবনায়, Tie পেত ৮× — মাপা RTP ২৬৬%।
// দুটোই ছিল খেলোয়াড়ের অনুকূলে, অর্থাৎ সীমাহীন টাকা তোলার পথ।
//
// এই টেস্টগুলো নির্ধারক (deterministic): বণ্টনের বৈশিষ্ট্য যাচাই করতে ইনজেক্ট করা
// rng ব্যবহার করা হয়, আর পরিসংখ্যানগত যাচাইয়ে বড় নমুনা + উদার সহনশীলতা রাখা হয়েছে
// যাতে টেস্ট flaky না হয়।
// ---------------------------------------------------------------------------

const {
  generateCrashPoint,
  playBaccarat,
  isValidBaccaratSelection,
  BACCARAT_OUTCOMES
} = require('../../services/gameFairness');
const { secureRandom, secureInt, securePick, secureWeightedPick } = require('../../services/rng');

jest.setTimeout(60000);

const SAMPLES = 200000;

describe('services/rng — ক্রিপ্টোগ্রাফিকভাবে নিরাপদ র‍্যান্ডমনেস (P1-01)', () => {
  test('secureRandom() [0,1) রেঞ্জেই থাকে', () => {
    for (let i = 0; i < 20000; i++) {
      const v = secureRandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('secureRandom() যুক্তিসঙ্গতভাবে uniform (১০ বাকেট, প্রতিটি ~১০%)', () => {
    const buckets = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) buckets[Math.floor(secureRandom() * 10)]++;
    for (const c of buckets) expect(c / n).toBeGreaterThan(0.085);
    for (const c of buckets) expect(c / n).toBeLessThan(0.115);
  });

  test('secureInt() দুই প্রান্তসহ সীমার ভেতরেই থাকে এবং দুই প্রান্তই আসে', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
      const v = secureInt(0, 36);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(36);
      seen.add(v);
    }
    expect(seen.has(0)).toBe(true);
    expect(seen.has(36)).toBe(true);
    expect(seen.size).toBe(37);
  });

  test('securePick / secureWeightedPick অবৈধ ইনপুটে থ্রো করে (নীরবে undefined নয়)', () => {
    expect(() => securePick([])).toThrow();
    expect(() => secureWeightedPick([])).toThrow();
    expect(() => secureWeightedPick([{ weight: 0 }])).toThrow();
    expect(() => secureInt(5, 1)).toThrow();
  });

  test('টাকার পথে Math.random() আর ব্যবহৃত হয় না (সোর্স-লেভেল গার্ড)', () => {
    const fs = require('fs');
    const path = require('path');
    const files = [
      'routes/games.js', 'routes/matches.js',
      'services/wheel.js', 'services/redpacket.js',
      'services/gameFairness.js', 'services/accumulator.js'
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
      const offending = src
        .split('\n')
        .filter((line) => line.includes('Math.random(') && !line.trim().startsWith('//'));
      expect({ file: rel, lines: offending }).toEqual({ file: rel, lines: [] });
    }
  });
});

describe('ক্র্যাশ/এভিয়েটর বণ্টন (P0-03)', () => {
  test('crashPoint সবসময় ১.০০ ও maxMultiplier-এর মধ্যে থাকে', () => {
    for (let i = 0; i < 50000; i++) {
      const cp = generateCrashPoint({ edge: 0.03, maxMultiplier: 1000 });
      expect(cp).toBeGreaterThanOrEqual(1);
      expect(cp).toBeLessThanOrEqual(1000);
    }
  });

  test('maxMultiplier একটা কঠিন সিলিং — চরম rng-তেও অতিক্রম হয় না', () => {
    // u → 1 হলে raw multiplier → ∞; ক্ল্যাম্প কাজ করছে কিনা সেটাই যাচাই।
    const cp = generateCrashPoint({ edge: 0.03, maxMultiplier: 50, rng: () => 0.9999999999 });
    expect(cp).toBe(50);
  });

  test('u < edge হলে তাৎক্ষণিক bust (১.০০×)', () => {
    expect(generateCrashPoint({ edge: 0.05, rng: () => 0 })).toBe(1);
    expect(generateCrashPoint({ edge: 0.05, rng: () => 0.04 })).toBe(1);
  });

  test('ইনভার্স-ট্রান্সফর্ম সূত্র সঠিক: m = (1−edge)/(1−u)', () => {
    // u=0.5, edge=0 → 2.00 ; u=0.75, edge=0 → 4.00
    expect(generateCrashPoint({ edge: 0, maxMultiplier: 1e6, rng: () => 0.5 })).toBe(2);
    expect(generateCrashPoint({ edge: 0, maxMultiplier: 1e6, rng: () => 0.75 })).toBe(4);
  });

  test('অবৈধ কনফিগ থ্রো করে (নীরবে ০-এজ বণ্টনে পড়ে না)', () => {
    expect(() => generateCrashPoint({ edge: 1 })).toThrow();
    expect(() => generateCrashPoint({ edge: -0.1 })).toThrow();
    expect(() => generateCrashPoint({ maxMultiplier: 0.5 })).toThrow();
  });

  test('RTP ≤ 100% — যেকোনো ক্যাশআউট পয়েন্টে (মূল P0-03 রিগ্রেশন)', () => {
    const edge = 0.03;
    for (const m of [1.2, 1.5, 2, 3, 5, 10]) {
      let returned = 0;
      for (let i = 0; i < SAMPLES; i++) {
        if (generateCrashPoint({ edge, maxMultiplier: 1000 }) >= m) returned += m;
      }
      const rtp = returned / SAMPLES;
      // পুরনো Uniform(1,10) বণ্টনে এই মান ছিল ১.৭৮–২.৭৮; এখন ~০.৯৭ হওয়ার কথা।
      expect(rtp).toBeLessThan(1.0);
      expect(rtp).toBeGreaterThan(0.90); // এত কম নয় যে গেমটা অখেলাযোগ্য হয়ে যায়
    }
  });

  test('হাউস এজ কনফিগারযোগ্য — বেশি edge মানে কম RTP', () => {
    const measure = (edge) => {
      let r = 0;
      const n = 100000;
      for (let i = 0; i < n; i++) if (generateCrashPoint({ edge, maxMultiplier: 1000 }) >= 2) r += 2;
      return r / n;
    };
    const low = measure(0.01);
    const high = measure(0.20);
    expect(low).toBeGreaterThan(high);
    expect(high).toBeLessThan(0.85);
  });
});

describe('ব্যাকারাট (P0-04)', () => {
  test('ফলাফল-সম্ভাবনার যোগফল ১', () => {
    const total = BACCARAT_OUTCOMES.reduce((s, o) => s + o.weight, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  test('Tie আর ১/৩ নয় — প্রকৃত ব্যাকারাটের ~৯.৫%', () => {
    let ties = 0;
    for (let i = 0; i < SAMPLES; i++) {
      if (playBaccarat('Player').outcome === 'Tie') ties++;
    }
    const rate = ties / SAMPLES;
    expect(rate).toBeGreaterThan(0.085);
    expect(rate).toBeLessThan(0.106);
  });

  test('প্রতিটা বাজির RTP ১০০%-এর নিচে (মূল P0-04 রিগ্রেশন)', () => {
    for (const selection of ['Player', 'Banker', 'Tie']) {
      let returned = 0;
      for (let i = 0; i < SAMPLES; i++) returned += playBaccarat(selection).multiplier;
      const rtp = returned / SAMPLES;
      // পুরনো মডেলে Tie-এর RTP ছিল ~২৬৬%।
      expect(rtp).toBeLessThan(1.0);
      expect(rtp).toBeGreaterThan(0.80);
    }
  });

  test('Tie হলে Player/Banker বাজি push হয় (স্টেক ফেরত, multiplier 1)', () => {
    const tie = { outcome: 'Tie' };
    expect(playBaccarat('Player', { pick: () => tie }).multiplier).toBe(1);
    expect(playBaccarat('Banker', { pick: () => tie }).multiplier).toBe(1);
    expect(playBaccarat('Tie', { pick: () => tie }).multiplier).toBe(9);
  });

  test('জয়/হারের গুণক নির্ধারিত মান মেনে চলে', () => {
    expect(playBaccarat('Banker', { pick: () => ({ outcome: 'Banker' }) }).multiplier).toBe(1.95);
    expect(playBaccarat('Player', { pick: () => ({ outcome: 'Player' }) }).multiplier).toBe(2);
    expect(playBaccarat('Player', { pick: () => ({ outcome: 'Banker' }) }).multiplier).toBe(0);
    expect(playBaccarat('Tie', { pick: () => ({ outcome: 'Player' }) }).multiplier).toBe(0);
  });

  test('অবৈধ selection প্রত্যাখ্যাত হয়', () => {
    for (const bad of ['tie', 'PLAYER', '', null, undefined, 42, {}, ['Tie'], '__proto__']) {
      expect(isValidBaccaratSelection(bad)).toBe(false);
      expect(() => playBaccarat(bad)).toThrow();
    }
    for (const good of ['Player', 'Banker', 'Tie']) {
      expect(isValidBaccaratSelection(good)).toBe(true);
    }
  });
});
