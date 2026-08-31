// tests/unit/featureFlags.test.js
// ---------------------------------------------------------------------------
// ফিচার রেজিস্ট্রি ও ফ্ল্যাগ সার্ভিসের ইউনিট টেস্ট।
//
// সবচেয়ে গুরুত্বপূর্ণ টেস্টটা নিচের "রেজিস্ট্রি ↔ বাস্তব গেট" ব্লকে: রেজিস্ট্রিতে
// একটা key থাকা মানেই অ্যাডমিন UI-তে একটা টগল দেখা যাবে। সেই টগলের পেছনে
// সত্যিকারের requireFeature() না থাকলে অ্যাডমিন এমন একটা সুইচ পেতেন যেটা
// চাপলে কিছুই হয় না — সেটাই ছিল মূল বাগ, তাই সেটা আর ফিরতে দেওয়া যাবে না।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const registry = require('../../services/featureRegistry');
const featureFlags = require('../../services/featureFlags');
const { requireFeature } = require('../../middleware/featureGate');

const ROOT = path.join(__dirname, '..', '..');

describe('featureRegistry', () => {
  test('প্রতিটা এন্ট্রির key ইউনিক ও বৈধ ফরম্যাটে', () => {
    const keys = registry.keys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]{3,60}$/);
  });

  test('প্রতিটা ফিচারের ক্যাটাগরি সংজ্ঞায়িত ও DB CHECK-এর সাথে সামঞ্জস্যপূর্ণ', () => {
    for (const f of registry.FEATURES) {
      expect(Object.keys(registry.CATEGORIES)).toContain(f.category);
      expect(featureFlags.VALID_CATEGORIES).toContain(f.category);
    }
  });

  test('প্রতিটা ফিচারের label ও description আছে (UI-তে খালি সেল দেখাবে না)', () => {
    for (const f of registry.FEATURES) {
      expect(typeof f.label).toBe('string');
      expect(f.label.length).toBeGreaterThan(0);
      expect(typeof f.description).toBe('string');
      expect(f.description.length).toBeGreaterThan(0);
    }
  });

  test('সব ফিচারের ডিফল্ট ON — ফ্ল্যাগ সিস্টেম ব্যর্থ হলে সাইট বন্ধ হয়ে যাবে না', () => {
    for (const f of registry.FEATURES) expect(registry.defaultFor(f.key)).toBe(true);
  });

  test('অজানা key-র ডিফল্ট false — ভুল করে কিছু খুলে যায় না', () => {
    expect(registry.defaultFor('no_such_feature')).toBe(false);
    expect(registry.isKnownKey('no_such_feature')).toBe(false);
  });
});

describe('requireFeature() — ডেভেলপার ভুল ধরা', () => {
  test('অজানা key দিয়ে গেট বসালে বুট-টাইমেই throw করে (নীরবে সবসময় ON হয়ে যায় না)', () => {
    expect(() => requireFeature('totally_made_up_key')).toThrow(/unknown feature key/);
  });

  test('বৈধ key দিয়ে মিডলওয়্যার ফাংশন ফেরত দেয়', () => {
    expect(typeof requireFeature('lucky_wheel')).toBe('function');
  });
});

describe('রেজিস্ট্রি ↔ বাস্তব গেট — প্রতিটা টগলের পেছনে সত্যিকারের প্রয়োগ আছে', () => {
  // রিপোর সব রুট ফাইল একবার পড়ে নেওয়া হয়
  const routeSrc = (() => {
    const dir = path.join(ROOT, 'routes');
    let all = '';
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) all += fs.readFileSync(path.join(dir, f), 'utf8') + '\n';
    }
    return all;
  })();

  test.each(registry.keys())('%s — অন্তত একটা রুটে requireFeature() বসানো আছে', (key) => {
    expect(routeSrc).toContain(`requireFeature('${key}')`);
  });

  test('রেজিস্ট্রির enforcement ফিল্ডে উল্লেখ করা ফাইলগুলো সত্যিই বিদ্যমান', () => {
    for (const f of registry.FEATURES) {
      for (const rel of f.enforcement || []) {
        expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
      }
    }
  });

  test('enforcement-এ উল্লেখ করা প্রতিটা ফাইলে সত্যিই ওই key-র গেট বসানো আছে', () => {
    // আগের টেস্টটা শুধু দেখত key-টা routes/-এর *কোথাও* আছে কিনা। ফলে
    // রেজিস্ট্রি "daily_rewards → routes/coins.js" দাবি করলেও coins.js-এ
    // কোনো গেট না থাকা ধরা পড়ত না — বাস্তবে POST /coins/daily-bonus ১০০ কয়েন
    // দিত অথচ ফ্ল্যাগ বন্ধ থাকলেও কাজ করত। এখন প্রতিটা দাবি ফাইল-ধরে যাচাই হয়।
    const mismatches = [];
    for (const f of registry.FEATURES) {
      for (const rel of f.enforcement || []) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        if (!src.includes(`requireFeature('${f.key}')`)) mismatches.push(`${f.key} → ${rel}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('গেট বসানো কোনো key রেজিস্ট্রির বাইরের নয়', () => {
    const used = [...routeSrc.matchAll(/requireFeature\('([a-z0-9_]+)'\)/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const k of used) expect(registry.isKnownKey(k)).toBe(true);
  });

  test('অ্যাডমিন প্যানেলের রুটে ফিচার গেট বসানো হয়নি (বন্ধ ফিচারও ম্যানেজ করা যায়)', () => {
    for (const f of ['admin.js', 'adminGames.js', 'adminLeaderboard.js', 'adminTelegram.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8');
      expect(src).not.toMatch(/requireFeature\(/);
    }
  });

  test('গেটওয়ে কলব্যাক রুট গেটমুক্ত — চলমান পেমেন্ট আটকে যায় না', () => {
    const payment = fs.readFileSync(path.join(ROOT, 'routes', 'payment.js'), 'utf8');
    for (const cb of ['/sslcommerz/success', '/sslcommerz/fail', '/sslcommerz/cancel', '/sslcommerz/ipn']) {
      const line = payment.split('\n').find(l => l.includes(`'${cb}'`) && l.includes('router.post'));
      expect(line).toBeDefined();
      expect(line).not.toMatch(/requireFeature/);
    }
  });
});

describe('বন্ধ ফিচারের বার্তা লোকালাইজড', () => {
  test('feature_currently_disabled দুই লোকেলেই আছে এবং সঠিক ভাষায়', () => {
    const bn = require('../../locales/bn.json');
    const en = require('../../locales/en.json');
    expect(bn.feature_currently_disabled).toBeTruthy();
    expect(en.feature_currently_disabled).toBeTruthy();
    expect(bn.feature_currently_disabled).toMatch(/[\u0980-\u09FF]/);
    expect(en.feature_currently_disabled).not.toMatch(/[\u0980-\u09FF]/);
  });
});
