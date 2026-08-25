const fs = require('fs');
const path = require('path');
const { resolveOdd, MAX_ODD } = require('../../services/oddsResolver');

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

  test('unknown runner is rejected rather than defaulted', () => {
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, '2')).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, 'yes')).toBeNull();
    expect(resolveOdd({ type: 'fancy', odds: {} }, 'no')).toBeNull();
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

  test('a runner key cannot smuggle a number in as the odd', () => {
    // ক্লায়েন্ট runner হিসেবে সংখ্যা পাঠালেও সেটা কী, মান নয়।
    const market = { type: 'bookmaker', odds: { '0': 1.85 } };
    expect(resolveOdd(market, 999)).toBeNull();
    expect(resolveOdd(market, '1000')).toBeNull();
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
