const fs = require('fs');
const path = require('path');
const registry = require('../services/gameRegistry');

// এই টেস্টগুলো একটাই জিনিস পাহারা দেয়: সার্ভার-সাইড লজিক ছাড়া কোনো গেম যেন
// কখনো খেলার যোগ্য না হয়। আগে ক্যাটালগে নাম থাকলেই গেম খেলা যেত, আর ফল আসত
// একটা জেনেরিক `chance(0.45) ? bet * 2 : 0` fallback থেকে — ১০৯টি আলাদা গেম
// আসলে একই নিয়মে সেটেল হতো।

describe('gameRegistry', () => {
  test('ক্যাটালগে নাম থাকলেই গেম খেলার যোগ্য হয় না', () => {
    const known = Object.keys(registry.CATALOGUE);
    const playable = registry.playableSlugs();

    expect(known.length).toBeGreaterThan(playable.length);
    expect(registry.isKnown('sakura-fortune')).toBe(true);
    expect(registry.isPlayable('sakura-fortune')).toBe(false);
  });

  test('চেনা + অচেনা গেম আলাদা করে বোঝা যায়', () => {
    expect(registry.isKnown('slots')).toBe(true);
    expect(registry.isKnown('this-game-does-not-exist')).toBe(false);
    expect(registry.isPlayable('this-game-does-not-exist')).toBe(false);
  });

  test('খেলার যোগ্য প্রতিটি গেমের আসল হ্যান্ডলার আছে', () => {
    for (const slug of registry.playableSlugs()) {
      if (registry.isCrashGame(slug)) continue; // রাউন্ড ফ্লো, তাৎক্ষণিক হ্যান্ডলার নয়
      const handler = registry.getHandler(slug);
      expect(typeof handler).toBe('function');

      const result = handler(100, 'Red');
      expect(typeof result.winAmount).toBe('number');
      expect(Number.isFinite(result.winAmount)).toBe(true);
      expect(result.winAmount).toBeGreaterThanOrEqual(0);
      expect(result).toHaveProperty('gameResult');
    }
  });

  test('playable আর comingSoon মিলে পুরো ক্যাটালগ, কোনো ওভারল্যাপ নেই', () => {
    const playable = registry.playableSlugs();
    const soon = registry.comingSoonSlugs();
    const known = Object.keys(registry.CATALOGUE);

    expect(playable.length + soon.length).toBe(known.length);
    expect(playable.filter((s) => soon.includes(s))).toEqual([]);
  });

  test('crash গেম আলাদা পথে চলে, getHandler() দিয়ে সেটেল হয় না', () => {
    expect(registry.isCrashGame('aviator')).toBe(true);
    expect(registry.isPlayable('aviator')).toBe(true);
    expect(() => registry.getHandler('aviator')(100)).toThrow();
  });

  test('registerGame: handler ছাড়া যোগ করলে গেম খেলার যোগ্য হয় না', () => {
    const out = registry.registerGame('temp-no-logic', 'Temp No Logic');
    expect(out.playable).toBe(false);
    expect(registry.isKnown('temp-no-logic')).toBe(true);
    expect(registry.isPlayable('temp-no-logic')).toBe(false);
    delete registry.CATALOGUE['temp-no-logic'];
  });

  test('registerGame: handler সহ যোগ করলে সাথে সাথেই খেলার যোগ্য', () => {
    const out = registry.registerGame('temp-with-logic', 'Temp With Logic', (bet) => ({
      winAmount: bet * 2,
      gameResult: { ok: true }
    }));
    expect(out.playable).toBe(true);
    expect(registry.getHandler('temp-with-logic')(50).winAmount).toBe(100);
    delete registry.CATALOGUE['temp-with-logic'];
  });

  test('registerGame খারাপ ইনপুট নেয় না', () => {
    expect(() => registry.registerGame('', 'X')).toThrow();
    expect(() => registry.registerGame('x', '')).toThrow();
    expect(() => registry.registerGame('x', 'X', 'not-a-function')).toThrow();
  });
});

describe('জেনেরিক fallback ফিরে আসেনি', () => {
  const gamesRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'games.js'), 'utf8');
  // কমেন্টে fallback-এর উল্লেখ আছে (কেন সরানো হলো তার ব্যাখ্যা) — সেটা কোড নয়,
  // তাই যাচাই করার আগে কমেন্ট লাইনগুলো বাদ দেওয়া হয়।
  const executableCode = gamesRoute
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  test('routes/games.js-এ 0.45 fallback নেই', () => {
    expect(executableCode).not.toMatch(/chance\(0\.45\)\s*\?\s*betAmount\s*\*\s*2/);
  });

  test('হ্যান্ডলার না থাকলে বাজি প্রত্যাখ্যান হয়', () => {
    expect(gamesRoute).toContain('games_not_available');
    expect(gamesRoute).toContain('gameRegistry.isPlayable');
  });

  test('অনুবাদে বার্তাটি দুই ভাষাতেই আছে', () => {
    const bn = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'bn.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));
    expect(bn.games_not_available).toBeTruthy();
    expect(en.games_not_available).toBeTruthy();
  });
});
