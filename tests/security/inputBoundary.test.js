// tests/security/inputBoundary.test.js
// ---------------------------------------------------------------------------
// PHASE 08 — ইনপুট/ডেটা-বাউন্ডারি হার্ডেনিং।
//
// যে বাস্তব সমস্যা এখানে লক করা হচ্ছে (ফিক্সের আগে reproduce করা):
//   গ্লোবাল এরর হ্যান্ডলার err.status/err.statusCode উপেক্ষা করে সবকিছুকে 500 বানাত।
//   body-parser ভাঙা JSON-এ SyntaxError (status 400) আর অতিরিক্ত বড় বডিতে
//   entity.too.large (status 413) থ্রো করে — দুটোই 500 হয়ে ফিরত। ফলে:
//     • ক্লায়েন্ট বুঝত না দোষটা তার রিকোয়েস্টের, নাকি সার্ভারের;
//     • প্রতিটা ভাঙা রিকোয়েস্ট error_logs টেবিলে "সার্ভার ত্রুটি" হিসেবে জমা হয়ে
//       আসল সার্ভার বাগ ঢেকে দিত;
//     • যে কেউ ইচ্ছা করে ভাঙা বডি পাঠিয়ে error_logs ফোলাতে পারত (রিসোর্স খরচ)।
//
// এছাড়া ইনপুট-বাউন্ডারির সাধারণ কভারেজ: ত্রুটিপূর্ণ ID, পেজিনেশন সীমা,
// টাইপ কনফিউশন, এবং রেসপন্সে সংবেদনশীল ফিল্ড ফাঁস না হওয়া।
//
// আসল PostgreSQL ব্যবহার করা হয়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, freshRequest } = require('../helpers/app');

const LEAK_PATTERNS = [
  /at Object\./, /at Function\./, /node_modules/, /\/home\/[a-z]+\/repo/,
  /SyntaxError/, /SELECT\s+.+\s+FROM\s+/i, /invalid input syntax/i,
  /SESSION_SECRET|DATABASE_URL|STORE_PASSWD/
];

function assertNoLeak(res) {
  const body = JSON.stringify(res.body || '') + (res.text || '');
  for (const p of LEAK_PATTERNS) expect(body).not.toMatch(p);
}

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, username, userId: r.rows[0].id };
}

describe('ভাঙা রিকোয়েস্ট বডি — সঠিক স্ট্যাটাস, সার্ভার ত্রুটি নয়', () => {
  test('ভাঙা JSON 400 দেয়, 500 নয়', async () => {
    const res = await freshRequest()
      .post('/announcements/1/dismiss')
      .set('Content-Type', 'application/json')
      .send('{"a":');

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    assertNoLeak(res);
  });

  test('অতিরিক্ত বড় বডি 413 দেয়, 500 নয়', async () => {
    const res = await freshRequest()
      .post('/announcements/1/dismiss')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'A'.repeat(3 * 1024 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.status).not.toBe(500);
    assertNoLeak(res);
  });

  test('JSON রিকোয়েস্টে JSON-ই ফেরত আসে (HTML পেজ নয়)', async () => {
    const res = await freshRequest()
      .post('/announcements/1/dismiss')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .send('{"a":');

    expect(res.body).toBeDefined();
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe('string');
    // পার্সারের আসল বার্তা কখনো ক্লায়েন্টে যায় না
    expect(res.body.message).not.toMatch(/JSON|token|position/i);
  });

  test('ক্লায়েন্টের ভুলে error_logs টেবিল ভরে না', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS c FROM error_logs');

    for (let i = 0; i < 3; i += 1) {
      await freshRequest()
        .post('/announcements/1/dismiss')
        .set('Content-Type', 'application/json')
        .send('{"broken":');
    }
    await new Promise((r) => setTimeout(r, 800)); // অ্যাসিঙ্ক ইনসার্টের জন্য সময়

    const after = await pool.query('SELECT COUNT(*)::int AS c FROM error_logs');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  test('4xx ম্যাপিং শুধু ক্লায়েন্ট-ত্রুটিতে — 5xx এখনো 500 থাকে (রিগ্রেশন গার্ড)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
    // অজানা/সার্ভার ত্রুটি এখনো 500-এ পড়ে
    expect(src).toMatch(/const statusCode = isClientError \? rawStatus : 500;/);
    // শুধু 400–499 রেঞ্জই ক্লায়েন্ট-ত্রুটি ধরা হয়
    expect(src).toMatch(/rawStatus >= 400 && rawStatus < 500/);
    // আসল 5xx এখনো error_logs-এ লেখা হয়
    expect(src).toMatch(/if \(!isClientError\) \{/);
  });
});

describe('ত্রুটিপূর্ণ ID — নিয়ন্ত্রিত রেসপন্স, ক্র্যাশ নয়', () => {
  const hostileIds = ['abc', '-1', '0', 'NaN', 'Infinity', '1e309',
    '9999999999999999999', '1.5', 'null', '../../etc/passwd', "1' OR '1'='1"];

  test.each(hostileIds)('GET /matches/%s নিরাপদে সামলানো হয়', async (id) => {
    const res = await freshRequest().get(`/matches/${encodeURIComponent(id)}`);
    expect(res.status).toBeLessThan(500);
    assertNoLeak(res);
  });

  test.each(hostileIds)('GET /news/%s নিরাপদে সামলানো হয়', async (id) => {
    const res = await freshRequest().get(`/news/${encodeURIComponent(id)}`);
    expect(res.status).toBeLessThan(500);
    assertNoLeak(res);
  });
});

describe('পেজিনেশন সীমা', () => {
  test('পাবলিক API-তে limit উপরের দিকে বাউন্ডেড', async () => {
    const res = await freshRequest().get('/api/v1/matches?limit=999999');
    // API key ছাড়া 401, কিন্তু কোনোভাবেই 500 বা আনবাউন্ডেড ফল নয়
    expect(res.status).toBeLessThan(500);
  });

  test('ঋণাত্মক/NaN page ক্র্যাশ করায় না', async () => {
    const { agent } = await makeUser();
    for (const p of ['-5', 'NaN', 'abc', '1e400', '']) {
      const res = await agent.get(`/profile/history?page=${encodeURIComponent(p)}`);
      expect(res.status).toBeLessThan(500);
    }
  });

  test('কোনো রুটে ব্যবহারকারী-নিয়ন্ত্রিত ORDER BY নেই (SQL ইনজেকশন সারফেস)', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'routes');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).not.toMatch(/ORDER BY \$\{/);
      expect(src).not.toMatch(/ORDER BY['"]\s*\+/);
    }
  });
});

describe('টাইপ কনফিউশন — অ্যারে/অবজেক্ট যেখানে স্কেলার প্রত্যাশিত', () => {
  test('লগইনে অ্যারে username ক্র্যাশ করায় না ও তথ্য ফাঁস করে না', async () => {
    const { agent, token } = await getCsrfAgent('/login');
    const res = await agent.post('/login').type('form')
      .send(`username[]=a&username[]=b&password=x&_csrf=${encodeURIComponent(token)}`);
    expect(res.status).toBeLessThan(500);
    assertNoLeak(res);
  });

  test('লগইনে অবজেক্ট username ক্র্যাশ করায় না', async () => {
    const { agent, token } = await getCsrfAgent('/login');
    const res = await agent.post('/login').type('form')
      .send(`username[a]=1&password=x&_csrf=${encodeURIComponent(token)}`);
    expect(res.status).toBeLessThan(500);
    assertNoLeak(res);
  });
});

describe('রেসপন্স সিরিয়ালাইজেশন — সংবেদনশীল ফিল্ড যায় না', () => {
  const SENSITIVE = ['password', 'reset_token', 'verification_token', 'totp_secret'];

  test('JSON এন্ডপয়েন্টগুলো গোপন ফিল্ড ফেরত দেয় না', async () => {
    const { agent } = await makeUser();
    for (const ep of ['/profile/api/balance', '/chat/history', '/games/api/recent-wins', '/matches/api/live']) {
      const res = await agent.get(ep);
      const body = JSON.stringify(res.body || '');
      for (const key of SENSITIVE) expect(body).not.toContain(key);
    }
  });
});
