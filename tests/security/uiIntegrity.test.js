// tests/security/uiIntegrity.test.js
// ---------------------------------------------------------------------------
// Phase 05 রিগ্রেশন কভারেজ — ফ্রন্টএন্ড/UI ইন্টিগ্রিটি অডিটে পাওয়া confirmed bug-গুলোর জন্য।
//
// ১) KYC ফর্মে action/method ছিল না — সাবমিট করলে GET হিসেবে বর্তমান পেজেই যেত, POST
//    /extra/kyc-তে কখনোই পৌঁছাত না। ফলে KYC সাবমিশন সম্পূর্ণ ভাঙা ছিল।
// ২) Registration-এ email ফরম্যাট সার্ভার-সাইড ভ্যালিডেট হতো না — যেকোনো স্ট্রিং (script
//    ট্যাগ সহ) email হিসেবে সেভ হতো, পরে admin/settings ও admin/users পেজে unescaped
//    রেন্ডার হয়ে stored-XSS তৈরি করত।
// ৩) tournaments.ejs-এ ফরইচ লুপ ভ্যারিয়েবল `t` translation object `t`-কে শ্যাডো করত,
//    ফলে running/prize/participants/entry_fee_label/free/start/details লেবেলগুলো
//    ভুল/undefined দেখাত।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

describe('KYC ফর্ম action/method', () => {
  test('views/kyc.ejs ফর্ম POST /extra/kyc-তে সাবমিট হয়', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });

    const page = await agent.get('/extra/kyc');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/<form[^>]*id="kycForm"[^>]*action="\/extra\/kyc"[^>]*method="POST"/i);
  });
});

describe('Registration email ভ্যালিডেশন (XSS প্রতিরোধ)', () => {
  test('অবৈধ/স্ক্রিপ্ট-ট্যাগ email দিয়ে রেজিস্ট্রেশন প্রত্যাখ্যাত হয়', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const res = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({
        username,
        email: '<script>alert(1)</script>',
        password: 'SecurePass123',
        confirmPassword: 'SecurePass123',
        _csrf: token
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/register');

    const check = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    expect(check.rows.length).toBe(0);
  });

  test('বৈধ email দিয়ে রেজিস্ট্রেশন সফল হয়', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const res = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({
        username,
        email: `${username}@example.com`,
        password: 'SecurePass123',
        confirmPassword: 'SecurePass123',
        _csrf: token
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('অবৈধ ফোন ফরম্যাট দিয়ে রেজিস্ট্রেশন প্রত্যাখ্যাত হয়', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const res = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({
        username,
        phone: '123',
        password: 'SecurePass123',
        confirmPassword: 'SecurePass123',
        _csrf: token
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/register');

    const check = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    expect(check.rows.length).toBe(0);
  });
});

describe('Admin পেজে user email escape হয়', () => {
  async function makeAdminAgent() {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
    return agent;
  }

  test('admin/users পেজে ইউজারের email/username escape করে দেখানো হয়', async () => {
    const admin = await makeAdminAgent();
    const target = uniqueUsername();
    await pool.query(
      `INSERT INTO users (username, email, password, role, coins) VALUES ($1, $2, 'x', 'user', 0)`,
      [target, `${target}+safe@example.com`]
    );

    const res = await admin.get('/admin/users');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });
});

describe('tournaments.ejs ট্রান্সলেশন লেবেল শ্যাডোয়িং', () => {
  test('/tournaments পেজে translation লেবেল সঠিকভাবে রেন্ডার হয়, raw key নয়', async () => {
    const res = await require('../helpers/app').freshRequest().get('/tournaments');
    expect(res.status).toBe(200);
    // raw untranslated key name literally leaking into HTML হলে bug থাকবে
    expect(res.text).not.toMatch(/>running</);
    expect(res.text).not.toMatch(/>participants</);
  });
});
