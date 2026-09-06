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

describe('Phase 9 — sports API-তে টাইমআউট আছে', () => {
  test('fetchWithTimeout হেল্পার AbortController ব্যবহার করে', () => {
    expect(SRC).toMatch(/async function fetchWithTimeout/);
    expect(SRC).toMatch(/new AbortController\(\)/);
    expect(SRC).toMatch(/controller\.abort\(\)/);
    expect(SRC).toMatch(/signal: controller\.signal/);
  });

  test('টাইমার সবসময় পরিষ্কার হয় (finally-তে)', () => {
    // clearTimeout না হলে প্রতিটা সফল কলেও একটা টাইমার ঝুলে থাকত এবং
    // process বন্ধ হতে দেরি করত।
    const body = /async function fetchWithTimeout[\s\S]*?\n\}/.exec(SRC)[0];
    expect(body).toMatch(/finally\s*\{[\s\S]*clearTimeout\(timer\)/);
  });

  test('হেল্পার নিজেকে ডাকে না (রিকার্শন নেই)', () => {
    // প্রথম খসড়ায় ঠিক এই ভুলটা হয়েছিল — ভেতরে fetch()-এর বদলে
    // fetchWithTimeout() বসে গিয়েছিল, যা অসীম রিকার্শন তৈরি করত।
    const body = /async function fetchWithTimeout[\s\S]*?\n\}/.exec(SRC)[0];
    const inner = body.slice(body.indexOf('{'));
    expect(inner).not.toMatch(/fetchWithTimeout\(/);
    expect(inner).toMatch(/await fetch\(url,/);
  });

  test('কোনো কাঁচা fetch( অবশিষ্ট নেই', () => {
    // একটা কল বাদ পড়লে সেটাই ঝুলে থাকার পথ হয়ে থাকত।
    const calls = [...SRC.matchAll(/await fetch\(/g)];
    // হেল্পারের ভেতরের একটাই বৈধ
    expect(calls.length).toBe(1);
    expect([...SRC.matchAll(/await fetchWithTimeout\(/g)].length).toBeGreaterThanOrEqual(4);
  });

  test('টাইমআউট env দিয়ে বদলানো যায়, ডিফল্ট যুক্তিসঙ্গত', () => {
    expect(SRC).toMatch(/process\.env\.SPORTS_API_TIMEOUT_MS/);
    const m = /API_TIMEOUT_MS = Number\(process\.env\.SPORTS_API_TIMEOUT_MS\) \|\| (\d+)/.exec(SRC);
    expect(m).not.toBeNull();
    const def = Number(m[1]);
    expect(def).toBeGreaterThan(1000);
    expect(def).toBeLessThanOrEqual(30000);
  });
});

describe('Phase 9 — API ব্যর্থতা নিরাপদে সামলানো হয়', () => {
  test('প্রতিটা external কল try/catch-এ মোড়ানো', () => {
    // AbortError catch না হলে টাইমআউট মানে অপ্রত্যাশিত ৫০০।
    const calls = [...SRC.matchAll(/await fetchWithTimeout\(/g)];
    for (const c of calls) {
      const before = SRC.slice(0, c.index);
      const lastTry = before.lastIndexOf('try {');
      const lastCatch = before.lastIndexOf('catch');
      expect(lastTry).toBeGreaterThan(lastCatch);
    }
  });

  test('ব্যর্থতায় নিরাপদ ফলব্যাক ফেরত দেওয়া হয়', () => {
    // খালি অ্যারে বা null — কখনো আংশিক/অসংগত ডেটা নয়।
    expect(SRC).toMatch(/catch[\s\S]{0,200}?return \[\]/);
    expect(SRC).toMatch(/catch[\s\S]{0,200}?return null/);
  });
});
