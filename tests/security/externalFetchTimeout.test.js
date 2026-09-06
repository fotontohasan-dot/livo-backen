const fs = require('fs');
const path = require('path');

// ==================== external HTTP কলে টাইমআউট ====================
//
// Node-এর গ্লোবাল fetch()-এ ডিফল্ট টাইমআউট নেই। কোডবেসে ১৩টা জায়গায়
// তৃতীয় পক্ষের API ডাকা হত (Cloudinary, Telegram, SMS গেটওয়ে, AI API,
// GitHub) — কোথাও টাইমআউট ছিল না। একটা ধীর upstream পুরো রিকোয়েস্ট আটকে
// রাখত, আর scheduler/queue থেকে ডাকা হলে কাজ জমতে থাকত।
//
// সবগুলো এখন utils/httpClient.js-এর fetchWithTimeout() দিয়ে যায়।
//
// এই টেস্ট নতুন কাঁচা fetch() ঢোকা আটকায়। একটাও বাদ পড়লে সেটাই ঝুলে
// থাকার পথ হয়ে থাকত, আর সেটা কেবল প্রোডাকশনে upstream ধীর হলে দেখা যেত।

const ROOT = path.join(__dirname, '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SOURCES = ['routes', 'services', 'middleware', 'utils', 'queues']
  .filter((d) => fs.existsSync(path.join(ROOT, d)))
  .flatMap((d) => walk(path.join(ROOT, d)))
  .concat(['app.js', 'server.js', 'telegram-bot.js']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f)));

describe('external HTTP কলে টাইমআউট বাধ্যতামূলক', () => {
  test('সোর্স স্ক্যান কাজ করছে', () => {
    // ফাইল তালিকা খালি হলে নিচের sweep অর্থহীনভাবে পাস করত।
    expect(SOURCES.length).toBeGreaterThan(20);
  });

  test('কোথাও টাইমআউট ছাড়া await fetch( নেই', () => {
    const offenders = [];
    for (const file of SOURCES) {
      const src = fs.readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        // utils/httpClient.js-এর ভেতরেরটা বৈধ — ওখানেই signal বসানো হয়
        if (/await fetch\(/.test(line) && !/signal/.test(line)) {
          offenders.push(path.relative(ROOT, file) + ':' + (i + 1));
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('হেল্পার নিজে সঠিকভাবে লেখা', () => {
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'httpClient.js'), 'utf8');
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/controller\.abort\(\)/);
    expect(src).toMatch(/signal: controller\.signal/);
    // clearTimeout finally-তে — নাহলে সফল কলেও টাইমার ঝুলে থাকত
    expect(src).toMatch(/finally\s*\{[\s\S]*clearTimeout\(timer\)/);
    // রিকার্শন নেই
    const body = /async function fetchWithTimeout[\s\S]*?\n\}/.exec(src)[0];
    expect(body.slice(body.indexOf('{'))).not.toMatch(/fetchWithTimeout\(/);
  });

  test('টাইমআউট env দিয়ে বদলানো যায়, ডিফল্ট যুক্তিসঙ্গত', () => {
    const { DEFAULT_TIMEOUT_MS } = require('../../utils/httpClient');
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(1000);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30000);
  });

  test('টাইমআউট রানটাইমে সত্যিই কাজ করে', async () => {
    // static যাচাই যথেষ্ট নয় — হেল্পারটা আসলেই abort করে কি না দেখা হয়।
    const http = require('http');
    const { fetchWithTimeout } = require('../../utils/httpClient');

    const server = http.createServer(() => { /* কখনো উত্তর দেয় না */ });
    await new Promise((res) => server.listen(0, res));
    const port = server.address().port;

    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 300)
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  }, 15000);
});
