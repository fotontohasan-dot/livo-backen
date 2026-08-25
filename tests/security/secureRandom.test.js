const fs = require('fs');
const path = require('path');
const secureRandom = require('../../utils/secureRandom');

const ROOT = path.join(__dirname, '..', '..');

describe('secureRandom: ranges and distribution (P2-01)', () => {
  test('randomFloat stays in [0, 1) and is not constant', () => {
    const values = Array.from({ length: 2000 }, () => secureRandom.randomFloat());
    values.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    });
    expect(new Set(values).size).toBeGreaterThan(1900);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.42);
    expect(mean).toBeLessThan(0.58);
  });

  test('randomInt covers [0, max) and never returns max', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
      const v = secureRandom.randomInt(37);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(37);
      seen.add(v);
    }
    expect(seen.size).toBe(37);
  });

  test('randomInt rejects invalid bounds', () => {
    expect(() => secureRandom.randomInt(0)).toThrow(RangeError);
    expect(() => secureRandom.randomInt(-1)).toThrow(RangeError);
    expect(() => secureRandom.randomInt(2.5)).toThrow(RangeError);
  });

  test('randomIntInclusive covers both endpoints', () => {
    const seen = new Set();
    for (let i = 0; i < 3000; i++) {
      const v = secureRandom.randomIntInclusive(1, 8);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(8);
      seen.add(v);
    }
    expect(seen.size).toBe(8);
    expect(secureRandom.randomIntInclusive(4, 4)).toBe(4);
    expect(() => secureRandom.randomIntInclusive(5, 4)).toThrow(RangeError);
  });

  test('chance honours the stated probability', () => {
    const n = 20000;
    let hits = 0;
    for (let i = 0; i < n; i++) if (secureRandom.chance(0.4)) hits++;
    expect(hits / n).toBeGreaterThan(0.37);
    expect(hits / n).toBeLessThan(0.43);

    expect(secureRandom.chance(0)).toBe(false);
    expect(secureRandom.chance(1)).toBe(true);
    expect(secureRandom.chance(-1)).toBe(false);
    expect(secureRandom.chance(2)).toBe(true);
    expect(() => secureRandom.chance('x')).toThrow(RangeError);
  });

  test('pick returns members of the array and rejects empty input', () => {
    const items = ['Player', 'Banker', 'Tie'];
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(secureRandom.pick(items));
    expect([...seen].sort()).toEqual([...items].sort());
    expect(() => secureRandom.pick([])).toThrow(RangeError);
    expect(() => secureRandom.pick(null)).toThrow(RangeError);
  });

  test('weightedIndex respects fractional weights', () => {
    const weights = [25, 25, 15, 15, 45, 35, 25, 20, 8, 3, 1, 0.3];
    const total = weights.reduce((a, b) => a + b, 0);
    const counts = new Array(weights.length).fill(0);
    const n = 40000;
    for (let i = 0; i < n; i++) counts[secureRandom.weightedIndex(weights)]++;

    counts.forEach((count, i) => {
      const expected = (weights[i] / total) * n;
      expect(Math.abs(count - expected)).toBeLessThan(Math.max(60, expected * 0.25));
    });

    expect(secureRandom.weightedIndex([0, 5, 0])).toBe(1);
    expect(() => secureRandom.weightedIndex([])).toThrow(RangeError);
    expect(() => secureRandom.weightedIndex([0, 0])).toThrow(RangeError);
    expect(() => secureRandom.weightedIndex([-1, 2])).toThrow(RangeError);
  });
});

describe('no Math.random on money paths (P2-01 regression)', () => {
  const MONEY_PATH_FILES = [
    'routes/games.js',
    'services/wheel.js',
    'services/redpacket.js',
    'services/botDetection.js',
    'utils/secureRandom.js'
  ];

  test.each(MONEY_PATH_FILES)('%s contains no executable Math.random() call', (relPath) => {
    const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const offending = source
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /Math\.random\s*\(/.test(line))
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'));
    expect(offending).toEqual([]);
  });
});

describe('game outcome helpers stay in range (P2-01)', () => {
  test('crash point formula stays within 1.00–10.00', () => {
    for (let i = 0; i < 5000; i++) {
      const crashPoint = Number((1 + secureRandom.randomFloat() * 9).toFixed(2));
      expect(crashPoint).toBeGreaterThanOrEqual(1);
      expect(crashPoint).toBeLessThanOrEqual(10);
    }
  });

  test('roulette numbers stay within 0–36', () => {
    for (let i = 0; i < 5000; i++) {
      const n = secureRandom.randomInt(37);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(36);
    }
  });
});
