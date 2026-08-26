const fs = require('fs');
const path = require('path');
const { resolveOdd, MAX_ODD, FALLBACK_ODD } = require('../../services/oddsResolver');

const ROOT = path.join(__dirname, '..', '..');

describe('oddsResolver: odds come from the server only (P2-04)', () => {
  test('stored market odds win', () => {
    const market = { type: 'bookmaker', odds: { '0': 1.5, '1': 2.4 } };
    expect(resolveOdd(market, '0')).toBe(1.5);
    expect(resolveOdd(market, 1)).toBe(2.4);
  });

  test('falls back to the same defaults the match page renders', () => {
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, '0')).toBe(1.85);
    expect(resolveOdd({ type: 'bookmaker', odds: null }, '1')).toBe(2.1);
    expect(resolveOdd({ type: 'fancy', odds: {} }, 'yes')).toBe(1.75);
  });

  test('a market whose odds are a single number uses that number', () => {
    // অ্যাডমিন ফর্ম (views/admin/markets.ejs) একটাই সংখ্যা পাঠায়, তাই JSONB-তে
    // scalar হিসেবে জমা হয় — প্রতিটি প্রোডাকশন মার্কেট এই আকারেই থাকে।
    expect(resolveOdd({ type: 'match_winner', odds: 1.85 }, 'X')).toBe(1.85);
    expect(resolveOdd({ type: 'match_winner', odds: '2.4' }, 'Team A')).toBe(2.4);
    expect(resolveOdd({ type: 'match_winner', odds: 2.4 }, 'anything')).toBe(2.4);
  });

  test('an out-of-band scalar odd is still rejected', () => {
    expect(resolveOdd({ type: 'match_winner', odds: 99999 }, 'X')).toBeNull();
    expect(resolveOdd({ type: 'match_winner', odds: 1 }, 'X')).toBeNull();
    expect(resolveOdd({ type: 'match_winner', odds: 'abc' }, 'X')).toBeNull();
  });

  test('মার্কেটে না থাকা রানার প্রত্যাখ্যাত হয়, ফলব্যাক অডস দেওয়া হয় না', () => {
    // আগের আচরণ: অচেনা রানারের জন্যও FALLBACK_ODD ফেরত যেত, তাই বানানো রানার
    // নামে বাজি বসে যেত। সেটেলমেন্টে ওই রানার কোনো ফলাফলের সাথে মিলত না —
    // বাজি অনির্দিষ্টকাল pending থাকত বা ভুলভাবে সেটেল হতো।
    //
    // এখন অচেনা রানার মানে null, আর কলার বাজিটাই বাতিল করে।
    expect(resolveOdd({ type: 'match_winner', odds: {} }, 'X')).toBeNull();
    expect(resolveOdd({ type: 'fancy', odds: {} }, 'no')).toBeNull();

    // মার্কেট-টাইপের ডিফল্ট তালিকায় থাকা রানার আগের মতোই সার্ভার-নির্ধারিত
    // অডস পায় — এই পরিবর্তনে বৈধ বাজি আটকায়নি।
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, '0')).toBe(1.85);
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, '1')).toBe(2.10);
    expect(resolveOdd({ type: 'fancy', odds: {} }, 'yes')).toBe(1.75);

    expect(FALLBACK_ODD).toBeGreaterThan(1);
    expect(FALLBACK_ODD).toBeLessThanOrEqual(MAX_ODD);
  });

  test('a missing market or runner is still rejected', () => {
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, null)).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, undefined)).toBeNull();
    expect(resolveOdd(null, '0')).toBeNull();
  });

  test('stored odds outside the valid band are rejected, not clamped', () => {
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': 1 } }, '0')).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': 0.5 } }, '0')).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': -5 } }, '0')).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': MAX_ODD + 1 } }, '0')).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': 'abc' } }, '0')).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': null } }, '0')).toBe(1.85);
  });

  test('runner কী দিয়ে অডস পাচার করা যায় না', () => {
    // ক্লায়েন্ট runner হিসেবে ৯৯৯ পাঠালে সেটা কী, মান নয়। মার্কেটে '999'
    // নামে কোনো রানার নেই, তাই এখন বাজিটাই প্রত্যাখ্যাত — আগে ফলব্যাক অডসে
    // বসে যেত।
    const market = { type: 'bookmaker', odds: { '0': 1.85 } };
    expect(resolveOdd(market, 999)).toBeNull();
    expect(resolveOdd(market, '1000')).toBeNull();
    expect(resolveOdd(market, 999)).not.toBe(999);
  });
});

describe('bet placement never trusts a client-supplied odd (P2-04 regression)', () => {
  test('routes/matches.js does not read odd from the request body', () => {
    const source = fs.readFileSync(path.join(ROOT, 'routes/matches.js'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/parseFloat\(\s*odd\s*\)/);
    expect(code).not.toMatch(/req\.body\.odd/);
    expect(code).toMatch(/resolveOdd\(/);
  });

  test('services/accumulator.js does not fall back to the client odd', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services/accumulator.js'), 'utf8');
    expect(source).not.toMatch(/parseFloat\(\s*sel\.odd\s*\)/);
    expect(source).toMatch(/resolveOdd\(/);
  });

  test('accumulator enforces an upper stake bound', () => {
    const source = fs.readFileSync(path.join(ROOT, 'services/accumulator.js'), 'utf8');
    expect(source).toMatch(/max_bet/);
  });
});
