const fs = require('fs');
const path = require('path');

// ==================== Phase 9: sports API timeout ====================
//
// roadmap Phase 9-এর দাবি: API timeout ও API failure হলেও অ্যাপ্লিকেশন যেন
// unsafe state-এ না যায়।
//
// services/sportsAPI.js external API (cricapi, RapidAPI) থেকে ম্যাচ ও odds
// আনে। Node-এর fetch()-এ ডিফল্ট টাইমআউট নেই, তাই upstream ঝুলে গেলে কলটাও
// অনির্দিষ্টকাল ঝুলত — একটা ধীর তৃতীয় পক্ষ পুরো রিকোয়েস্ট আটকে রাখত, আর
// scheduler থেকে ডাকা হলে কাজ জমতে থাকত।
//
// fetchWithTimeout() যোগ করা হয়েছে: AbortController + setTimeout। টাইমআউট
// হলে AbortError ছোঁড়ে, যা প্রতিটা কলারের বিদ্যমান catch ধরে এবং নিরাপদ
// ফলব্যাক (খালি অ্যারে / null) ফেরত দেয় — অর্থাৎ ব্যর্থতা throw হয়ে
// রিকোয়েস্ট ভাঙে না।

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'services', 'sportsAPI.js'), 'utf8');

describe('Phase 9 — sports API-তে টাইমআউট আছে (Step 3: breaker-সহ integrationFetch)', () => {
  test('সব কল integrationFetch (AbortController + timeout) দিয়ে যায়', () => {
    expect(SRC).toMatch(/integrationFetch\(/);
    expect(SRC).toMatch(/sports:cricapi/);
    expect(SRC).toMatch(/sports:rapidapi/);
    const http = fs.readFileSync(path.join(ROOT, 'utils', 'integrationHttp.js'), 'utf8');
    expect(http).toMatch(/AbortController|signal/);
    const cb = fs.readFileSync(path.join(ROOT, 'services', 'circuitBreaker.js'), 'utf8');
    expect(cb).toMatch(/new AbortController\(\)/);
    expect(cb).toMatch(/controller\.abort\(\)/);
    expect(cb).toMatch(/finally\s*\{[\s\S]*clearTimeout\(timer\)/); // টাইমার সবসময় পরিষ্কার
  });

  test('কোনো কাঁচা fetch( অবশিষ্ট নেই', () => {
    expect([...SRC.matchAll(/await fetch\(/g)].length).toBe(0);
    expect([...SRC.matchAll(/await (cricFetch|footballFetch)\(/g)].length).toBeGreaterThanOrEqual(4);
  });

  test('টাইমআউট env দিয়ে বদলানো যায়, ডিফল্ট ৫s', () => {
    expect(SRC).toMatch(/process\.env\.SPORTS_API_TIMEOUT_MS/);
    const cb = fs.readFileSync(path.join(ROOT, 'services', 'circuitBreaker.js'), 'utf8');
    expect(cb).toMatch(/pick\('TIMEOUT_MS', 5000\)/);
  });
});

describe('Phase 9 — API ব্যর্থতা নিরাপদে সামলানো হয়', () => {
  test('প্রতিটা external কল try/catch-এ মোড়ানো', () => {
    const calls = [...SRC.matchAll(/await (cricFetch|footballFetch)\(/g)];
    for (const c of calls) {
      const before = SRC.slice(0, c.index);
      expect(before.lastIndexOf('try {')).toBeGreaterThan(before.lastIndexOf('catch'));
    }
  });

  test('ব্যর্থতায় নিরাপদ ফলব্যাক: সর্বশেষ ভালো ডেটা (stale) নয়তো খালি/null', () => {
    expect(SRC).toMatch(/function staleOr/);
    expect(SRC).toMatch(/catch[\s\S]{0,200}?return staleOr\(/);
  });
});

// ==================== Step 4D-fix: দুর্বল হয়ে যাওয়া দুটো চেক, এখন integrationFetch-এর বিরুদ্ধে ====================
// #258-এর আগে এই ফাইল (১) ডিফল্ট timeout-এর আক্ষরিক মান ও (২) ব্যর্থতায় আক্ষরিক [] / null ফলব্যাক এবং
// (৩) রেসপন্সের পর টাইমার পরিষ্কার হওয়া যাচাই করত। helper সরে যাওয়ায় সেগুলো আলগা হয়ে গিয়েছিল; এখানে ফেরানো হলো।
describe('Step 4D-fix — integrationFetch: আক্ষরিক ডিফল্ট, আক্ষরিক ফলব্যাক, টাইমার পরিষ্কার', () => {
  const CB_SRC = fs.readFileSync(path.join(ROOT, 'services', 'circuitBreaker.js'), 'utf8');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  test('ডিফল্ট timeout-এর আক্ষরিক মান সীমার ভেতরে (>১s, ≤৩০s) এবং sportsAPI সেটা integrationFetch-এ পাঠায়', () => {
    const m = /TIMEOUT_MS:\s*pick\('TIMEOUT_MS',\s*(\d+)\)/.exec(CB_SRC);
    expect(m).not.toBeNull();
    const def = Number(m[1]);
    expect(def).toBeGreaterThan(1000);
    expect(def).toBeLessThanOrEqual(30000);
    expect(SRC).toMatch(/API_TIMEOUT_MS\s*=\s*Number\(process\.env\.SPORTS_API_TIMEOUT_MS\)\s*\|\|\s*undefined/);
    expect(SRC).toMatch(/integrationFetch\(integration, url, options, \{ timeoutMs: API_TIMEOUT_MS \}\)/);
  });

  test('প্রতিটা catch আক্ষরিক [] বা null ফলব্যাক দিয়ে staleOr ডাকে (আগের return []/null চেকের সমতুল্য)', () => {
    const returns = [...SRC.matchAll(/return staleOr\(([^;\n]*)\);/g)].map((m) => m[1].trim());
    expect(returns.length).toBeGreaterThanOrEqual(4);
    for (const args of returns) expect(args).toMatch(/,\s*(\[\]|null)$/);
    expect(returns.some((a) => /,\s*\[\]$/.test(a))).toBe(true);
    expect(returns.some((a) => /,\s*null$/.test(a))).toBe(true);
  });

  test('runtime: ঝুলে থাকা upstream → timeout-এর মধ্যে আক্ষরিক [] ফেরে, throw নয়, একটাই HTTP কল', async () => {
    const hang = jest.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }));
    global.fetch = hang;
    const saved = { k: process.env.CRICKET_API_KEY, t: process.env.SPORTS_API_TIMEOUT_MS };
    process.env.CRICKET_API_KEY = 'test-key';
    process.env.SPORTS_API_TIMEOUT_MS = '300';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let sports;
    jest.isolateModules(() => { sports = require('../../services/sportsAPI'); });
    const started = Date.now();
    const out = await sports.getCricketCurrentMatches();
    const took = Date.now() - started;
    if (saved.k === undefined) delete process.env.CRICKET_API_KEY; else process.env.CRICKET_API_KEY = saved.k;
    if (saved.t === undefined) delete process.env.SPORTS_API_TIMEOUT_MS; else process.env.SPORTS_API_TIMEOUT_MS = saved.t;
    expect(out).toEqual([]);
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500);
    expect(hang).toHaveBeenCalledTimes(1);
  });

  // timeout টাইমার (অনন্য মান ৭৭৭৭ms) সফল ও ব্যর্থ — দুই ক্ষেত্রেই এবং breaker/no-breaker দুই পথেই পরিষ্কার হয়
  function trackTimers() {
    const realSet = global.setTimeout; const realClear = global.clearTimeout;
    const created = []; const cleared = new Set();
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => { const h = realSet(fn, ms, ...a); if (ms === 7777) created.push(h); return h; });
    jest.spyOn(global, 'clearTimeout').mockImplementation((h) => { cleared.add(h); return realClear(h); });
    return { created, cleared, sweep: () => created.forEach((h) => realClear(h)) };
  }

  const PATHS = [
    ['breaker (sports পথ)', 'sports:timer-check', {}],
    ['breaker:false (পেমেন্ট পথ)', 'payment:timer-check', { breaker: false }]
  ];
  describe.each(PATHS)('%s', (_label, name, extra) => {
    const { integrationFetch } = require('../../utils/integrationHttp');
    const { _resetForTests } = require('../../services/circuitBreaker');
    beforeEach(() => _resetForTests());

    test.each([['সফল রেসপন্সের পর', true], ['ব্যর্থ কলের পর', false]])('%s টাইমার পরিষ্কার', async (_l, ok) => {
      global.fetch = jest.fn(() => (ok ? Promise.resolve({ ok: true, status: 200 }) : Promise.reject(new Error('boom'))));
      const t = trackTimers();
      const p = integrationFetch(name, 'http://upstream.test/', {}, { ...extra, timeoutMs: 7777 });
      if (ok) await p; else await expect(p).rejects.toThrow('boom');
      const dangling = t.created.filter((h) => !t.cleared.has(h));
      t.sweep();
      expect(t.created.length).toBeGreaterThanOrEqual(1);
      expect(dangling).toHaveLength(0);
    });
  });
});
