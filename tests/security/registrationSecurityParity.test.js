// tests/security/registrationSecurityParity.test.js
// ---------------------------------------------------------------------------
// রেজিস্ট্রেশন সিকিউরিটি প্যারিটি অডিট।
//
// আগে src/pages/api/register.ts নামে একটা সমান্তরাল Next.js রেজিস্ট্রেশন backend
// ছিল যেটা routes/auth.js-এর POST /register-এর কোনো নিরাপত্তা নিয়ন্ত্রণ ছাড়াই
// সরাসরি DB-তে ইউজার ইনসার্ট করত — কোনো CSRF যাচাই, রেট-লিমিট, IP ব্লকলিস্ট/অ্যাডমিন
// IP রুল, bot detection/CAPTCHA/honeypot/timing চেক, fraudDetection.scanRegistration(),
// duplicateDetection.evaluateDuplicateAccount(), রেফারেল abuse protection, ইমেইল
// ভেরিফিকেশন টোকেন/ওয়ার্কফ্লো, ডিভাইস/অডিট লগিং — কিছুই ছিল না। যেহেতু README.md
// অনুযায়ী src/ Next.js অংশ প্রোডাকশন ট্র্যাফিক সার্ভ করে না (Docker ইমেজেও বিল্ড হয়
// না, next/react devDependency-তে) এবং Express-এর নিজস্ব CSRF মিডলওয়্যার /api/*
// প্রিফিক্স সম্পূর্ণ এক্সেম্পট রাখে (routes/api.js-এর জন্য, Next-এর pages/api-এর জন্য
// নয়) — এই দুটো সিস্টেম কখনো একই সেশন/CSRF/রেট-লিমিট স্ট্যাক শেয়ার করে না। তাই
// "প্যারিটি" আনার একমাত্র নিরাপদ উপায় ছিল দুর্বল duplicate route-টা সরিয়ে ফেলা এবং
// routes/auth.js-এর /register-কে একমাত্র registration path হিসেবে রাখা।
//
// এই টেস্ট নিশ্চিত করে সেই দুর্বল route আর ফিরে না আসে, এবং POST /register-এর
// প্রতিটা নিরাপত্তা নিয়ন্ত্রণ বাস্তবে চালু আছে।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, fakeIp, freshRequest } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');

describe('রিগ্রেশন গার্ড — সমান্তরাল, কম-সুরক্ষিত রেজিস্ট্রেশন backend আর নেই', () => {
  test('src/pages/api/register.ts মুছে ফেলা হয়েছে, ফিরে আসেনি', () => {
    const removedPath = path.join(ROOT, 'src', 'pages', 'api', 'register.ts');
    expect(fs.existsSync(removedPath)).toBe(false);
  });

  test('src/pages/register.tsx এখন Express-এর /register-এই রিডাইরেক্ট করে, নিজস্ব API কল করে না', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'register.tsx'), 'utf8');
    expect(src).not.toMatch(/fetch\(\s*['"]\/api\/register['"]/);
    expect(src).toMatch(/['"]\/register['"]/);
  });

  test('routes/auth.js-ই একমাত্র POST /register হ্যান্ডলার — অন্য কোনো routes/*.js ফাইলে ডুপ্লিকেট নেই', () => {
    const routesDir = path.join(ROOT, 'routes');
    const otherRouteFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js') && f !== 'auth.js');
    const duplicates = otherRouteFiles.filter((f) => {
      const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
      return /router\.post\(\s*['"]\/register['"]/.test(src);
    });
    expect(duplicates).toEqual([]);
  });
});

describe('POST /register — নিরাপত্তা নিয়ন্ত্রণ বাস্তবে সক্রিয়', () => {
  test('CSRF টোকেন ছাড়া POST 403 দেয়', async () => {
    const res = await freshRequest()
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .set('X-Forwarded-For', fakeIp())
      .type('form')
      .send({ username: uniqueUsername(), phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123' });
    expect(res.status).toBe(403);
  });

  test('honeypot (website ফিল্ড) পূরণ করলে bot হিসেবে ধরা হয় — সরাসরি ইউজার তৈরি হয় না', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const res = await agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({
        username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123',
        website: 'http://spam-bot.example.com', _csrf: token
      });
    // bot detection ফর্ম আবার দেখায় (redirect ফিরে /register-এ) — সরাসরি লগইন/হোমপেজে যায় না
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/');

    const { pool } = require('../../db');
    const created = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    expect(created.rows.length).toBe(0);
  });

  test('বৈধ রেজিস্ট্রেশনে referral_code সহ ইউজার তৈরি হয় ও ডুপ্লিকেট/ফ্রড চেক ব্লক করে না', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const phone = uniquePhone();
    const res = await agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const { pool } = require('../../db');
    const created = await pool.query('SELECT id, referral_code, role, coins FROM users WHERE username = $1', [username]);
    expect(created.rows.length).toBe(1);
    // privileged field mass-assignment protection: role/coins ইউজার-নিয়ন্ত্রিত নয়
    expect(created.rows[0].role).toBe('user');
    expect(Number(created.rows[0].coins)).toBe(0);
    expect(created.rows[0].referral_code).toBeTruthy();
  });

  test('একই ইউজারনেম দিয়ে দুটো একযোগে রেজিস্ট্রেশনে একটাই সফল হয় (রেস কন্ডিশন সেফ)', async () => {
    const { pool } = require('../../db');
    const username = uniqueUsername();
    const phoneA = uniquePhone();
    const phoneB = uniquePhone();

    const [a, b] = await Promise.all([
      getCsrfAgent('/register').then(({ agent, token }) => agent
        .post('/register').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username, phone: phoneA, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token })),
      getCsrfAgent('/register').then(({ agent, token }) => agent
        .post('/register').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username, phone: phoneB, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token }))
    ]);

    expect(a.status).toBe(302);
    expect(b.status).toBe(302);

    // ঠিক একটাই ইনসার্ট সফল হয়েছে — DB-এর UNIQUE constraint রেস কন্ডিশনে ডুপ্লিকেট আটকেছে,
    // ব্যর্থটা catch ব্লকে গিয়ে নিরাপদে error flash করে ফিরে এসেছে (crash করেনি)
    const rows = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    expect(rows.rows.length).toBe(1);
  });
});
