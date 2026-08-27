// tests/testHarnessIntegrity.test.js
// ---------------------------------------------------------------------------
// টেস্ট হারনেস রিগ্রেশন গার্ড — CI-তে দেখা `read ECONNRESET`-এর মূল কারণ আটকানো।
//
// মূল কারণ: supertest-কে non-listening express অ্যাপ দিলে সে নিজেই সার্ভার
// ম্যানেজ করে (node_modules/supertest/lib/test.js):
//     serverAddress(): if (!app.address()) this._server = app.listen(0);
//     end():           if (server && server._handle) server.close(...)
// অর্থাৎ প্রতিটা রিকোয়েস্ট নিজে পোর্ট খোলে এবং রেসপন্স শেষে পোর্ট বন্ধ করে।
//
// সমান্তরাল রিকোয়েস্টে (games-cashout-timing.test.js-এ একই রাউন্ডে ১০টা cashout)
// যেটা আগে শেষ হয় সেটা `server.close()` ডেকে পোর্ট unbind করে দিত, আর তখনো
// কানেক্ট হতে থাকা বাকি রিকোয়েস্টগুলোর SYN RST খেত → ক্লায়েন্টে `read ECONNRESET`।
// লোকালি ~৩% রাউন্ডে, CI-এর ধীর রানারে অনেক বেশি — তাই CI-তে নিয়মিত ব্যর্থ হতো।
// (পুনরুৎপাদন: ৮০ রাউন্ড × ১০ সমান্তরাল রিকোয়েস্ট — ফিক্সের আগে ৪–১৪টি রাউন্ড
// ব্যর্থ, ফিক্সের পরে ০।)
//
// ফিক্স: tests/helpers/app.js একটাই দীর্ঘস্থায়ী listening সার্ভার রাখে; supertest
// listening Server পেলে নিজে আর listen/close করে না।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const http = require('http');
const { app, server, expressApp } = require('./helpers/app');

const TESTS_DIR = __dirname;

// এই ফাইলগুলো ইচ্ছাকৃতভাবে রুট app মডিউল সরাসরি require করে — লাইফসাইকেল
// যাচাইয়ের জন্য (supertest-এ পাস করে না)।
const ALLOWED_DIRECT_APP_REQUIRE = new Set([
  path.join(TESTS_DIR, 'appLifecycle.test.js'),
  path.join(TESTS_DIR, 'helpers', 'app.js'),
  // নিজের env নিয়ে স্বতন্ত্র অ্যাপ ইনস্ট্যান্স বুট করে, কিন্তু supertest-কে তার
  // নিজস্ব দীর্ঘস্থায়ী listening সার্ভারই দেয় (ফাইলের ভেতরের মন্তব্য দেখো)।
  path.join(TESTS_DIR, 'security', 'internalEndpointAuth.test.js'),
  // এই ফাইলটাই নিয়মটার ব্যাখ্যা ধারণ করে
  path.join(TESTS_DIR, 'testHarnessIntegrity.test.js'),
  // মন্তব্যে পুরনো প্যাটার্নটা উদাহরণ হিসেবে লেখা আছে
  path.join(TESTS_DIR, 'afterEnv.js')
]);

function walk(dir) {
  return fs.readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) return entry === 'e2e' ? [] : walk(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

describe('টেস্ট হারনেস — supertest সবসময় listening সার্ভার পায়', () => {
  test('helpers/app.js একটা listening http.Server এক্সপোর্ট করে (express অ্যাপ নয়)', () => {
    expect(app).toBeInstanceOf(http.Server);
    expect(app).toBe(server);
    expect(server.listening).toBe(true);
    expect(typeof expressApp).toBe('function'); // আসল express অ্যাপ আলাদাভাবে পাওয়া যায়
  });

  test('কোনো টেস্ট ফাইল supertest-কে সরাসরি express অ্যাপ দেয় না', () => {
    const offenders = [];
    for (const file of walk(TESTS_DIR)) {
      if (ALLOWED_DIRECT_APP_REQUIRE.has(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (/require\(['"]\.{1,2}(\/\.\.)*\/app(\.js)?['"]\)/.test(src)) {
        offenders.push(path.relative(TESTS_DIR, file));
      }
    }
    // এই ফাইলগুলোকে helpers/app.js-এর শেয়ার্ড listening সার্ভার ব্যবহার করতে হবে
    expect(offenders).toEqual([]);
  });

  test('১০টা সমান্তরাল রিকোয়েস্টের একটাও কানেকশন-রিসেটে ব্যর্থ হয় না', async () => {
    const request = require('supertest');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }).map(() => request(app).get('/health'))
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => r.reason && r.reason.code)).toEqual([]);
    // সার্ভার এখনো listening — supertest সেটা বন্ধ করে দেয়নি
    expect(server.listening).toBe(true);
  });
});
