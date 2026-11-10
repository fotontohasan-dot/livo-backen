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
