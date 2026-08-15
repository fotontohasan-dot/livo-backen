// পাসওয়ার্ড রিকভারির পুরো লাইফসাইকেল কভার করে:
//   forgot-password ফর্ম → টোকেন ইস্যু → reset-password → টোকেন invalidate →
//   নতুন পাসওয়ার্ডে লগইন → পুরনো পাসওয়ার্ড অকার্যকর।
const request = require('supertest');
const app = require('../../app.js');
const { pool } = require('../../db');
const {
  extractCsrfToken, getCsrfAgent, uniqueUsername, uniquePhone,
  REALISTIC_UA, fakeIp, wrapAgentWithIp, freshRequest
} = require('../helpers/app');

const BOT_UA = 'curl/8.4.0'; // services/botDetection.js এটাকে সন্দেহজনক ধরে → CAPTCHA চাওয়া হয়

function uniqueEmail() {
  return `${uniqueUsername('pr')}@example.test`;
}

async function registerUser(email, password) {
  const { agent, token } = await getCsrfAgent('/register');
  const res = await agent
    .post('/register')
    .type('form')
    .send({
      username: uniqueUsername('pr'),
      email,
      phone: uniquePhone(),
      password,
      confirmPassword: password,
      _csrf: token
    });
  expect(res.status).toBe(302);
  const row = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  expect(row.rows.length).toBe(1);
  return row.rows[0].id;
}

// forgot-password ফর্ম সাবমিট করে DB থেকে ইস্যু হওয়া reset_token পড়ে আনে
async function requestReset(email) {
  const { agent, token } = await getCsrfAgent('/forgot-password');
  const res = await agent.post('/forgot-password').type('form').send({ email, _csrf: token });
  expect(res.status).toBe(200);
  const row = await pool.query('SELECT reset_token FROM users WHERE email = $1', [email]);
  return row.rows[0].reset_token;
}

describe('Password recovery — forgot-password form', () => {
  test('ফর্মে বট-ডিটেকশনের প্রত্যাশিত ফিল্ডগুলো (honeypot + form_rendered_at) রেন্ডার হয়', async () => {
    const res = await freshRequest().get('/forgot-password');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/name="form_rendered_at"/);
    expect(res.text).toMatch(/name="website"/);
  });

  // রিগ্রেশন: রুট CAPTCHA চাইলে ভিউতে সেই প্রশ্নটাই রেন্ডার হতো না, ফলে ইউজার কখনোই
  // পাস করতে পারত না — পাসওয়ার্ড রিসেট স্থায়ীভাবে অসম্ভব হয়ে যেত।
  test('সন্দেহজনক রিকোয়েস্টে CAPTCHA প্রশ্ন ও উত্তরের ইনপুট ফর্মেই দেখা যায়, এবং উত্তর দিলে রিসেট চলে', async () => {
    const email = uniqueEmail();
    await registerUser(email, 'SecurePass123');

    const agent = wrapAgentWithIp(request.agent(app), fakeIp());
    const page = await agent.get('/forgot-password').set('User-Agent', BOT_UA);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/name="captcha_answer"/);

    const question = /যাচাই করুন:\s*(\d+)\s*([+\-])\s*(\d+)\s*=/.exec(page.text);
    expect(question).not.toBeNull();
    const [, a, op, b] = question;
    const answer = op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);

    const res = await agent
      .post('/forgot-password')
      .set('User-Agent', BOT_UA)
      .type('form')
      .send({
        email,
        captcha_answer: String(answer),
        form_rendered_at: /value="(\d+)"/.exec(page.text)[1],
        _csrf: extractCsrfToken(page.text)
      });
    expect(res.status).toBe(200);

    const row = await pool.query('SELECT reset_token FROM users WHERE email = $1', [email]);
    expect(row.rows[0].reset_token).toBeTruthy();
  });

  test('অস্তিত্বহীন ইমেইলেও একই সফল রেসপন্স আসে (user enumeration protection)', async () => {
    const { agent, token } = await getCsrfAgent('/forgot-password');
    const res = await agent
      .post('/forgot-password')
      .type('form')
      .send({ email: `${uniqueUsername('nobody')}@example.test`, _csrf: token });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/রিসেট লিঙ্ক পাঠানো হয়েছে/);
  });
});

describe('Password recovery — token lifecycle', () => {
  test('টোকেন ইস্যু হয়, পাসওয়ার্ড বদলায়, এবং নতুন পাসওয়ার্ডেই লগইন হয়', async () => {
    const email = uniqueEmail();
    const userId = await registerUser(email, 'SecurePass123');

    const token = await requestReset(email);
    expect(token).toMatch(/^[a-f0-9]{64}$/); // crypto.randomBytes(32) hex — অনুমানযোগ্য নয়

    const expiry = await pool.query('SELECT reset_token_expiry FROM users WHERE id = $1', [userId]);
    expect(new Date(expiry.rows[0].reset_token_expiry).getTime()).toBeGreaterThan(Date.now());

    const page = await getCsrfAgent(`/reset-password/${token}`);
    const res = await page.agent
      .post(`/reset-password/${token}`)
      .type('form')
      .send({ password: 'BrandNewPass456', confirmPassword: 'BrandNewPass456', _csrf: page.token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');

    const after = await pool.query('SELECT reset_token, reset_token_expiry FROM users WHERE id = $1', [userId]);
    expect(after.rows[0].reset_token).toBeNull();
    expect(after.rows[0].reset_token_expiry).toBeNull();

    const loginNew = await getCsrfAgent('/login');
    const okLogin = await loginNew.agent
      .post('/login')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: email, password: 'BrandNewPass456', _csrf: loginNew.token });
    expect(okLogin.status).toBe(302);
    expect(okLogin.headers.location).not.toMatch(/\/login/);

    const loginOld = await getCsrfAgent('/login');
    const badLogin = await loginOld.agent
      .post('/login')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: email, password: 'SecurePass123', _csrf: loginOld.token });
    expect(badLogin.headers.location).toMatch(/\/login/);
  });

  // রিগ্রেশন: আগে SELECT আর UPDATE আলাদা ছিল, তাই একই টোকেন দ্বিতীয়বারেও কাজ করে ফেলতে পারত
  test('একই টোকেন দ্বিতীয়বার ব্যবহার করা যায় না (single-use)', async () => {
    const email = uniqueEmail();
    await registerUser(email, 'SecurePass123');
    const token = await requestReset(email);

    const first = await getCsrfAgent(`/reset-password/${token}`);
    await first.agent
      .post(`/reset-password/${token}`)
      .type('form')
      .send({ password: 'FirstReset123', confirmPassword: 'FirstReset123', _csrf: first.token });

    const second = await getCsrfAgent('/login');
    const replay = await second.agent
      .post(`/reset-password/${token}`)
      .type('form')
      .send({ password: 'AttackerPass999', confirmPassword: 'AttackerPass999', _csrf: second.token });
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe('/forgot-password');

    // দ্বিতীয় (রিপ্লে) সাবমিশনের পাসওয়ার্ড কার্যকর হয়নি — প্রথমটাই বহাল
    const check = await getCsrfAgent('/login');
    const attacker = await check.agent
      .post('/login')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: email, password: 'AttackerPass999', _csrf: check.token });
    expect(attacker.headers.location).toMatch(/\/login/);
  });

  test('মেয়াদোত্তীর্ণ টোকেন প্রত্যাখ্যাত হয় এবং পাসওয়ার্ড বদলায় না', async () => {
    const email = uniqueEmail();
    const userId = await registerUser(email, 'SecurePass123');
    const token = await requestReset(email);

    await pool.query(`UPDATE users SET reset_token_expiry = NOW() - INTERVAL '1 hour' WHERE id = $1`, [userId]);

    const before = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    const { agent, token: csrf } = await getCsrfAgent('/login');
    const res = await agent
      .post(`/reset-password/${token}`)
      .type('form')
      .send({ password: 'ExpiredTry123', confirmPassword: 'ExpiredTry123', _csrf: csrf });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/forgot-password');

    const after = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    expect(after.rows[0].password).toBe(before.rows[0].password);
  });

  test('অকার্যকর টোকেনে GET এবং POST দুটোই /forgot-password-এ ফেরত পাঠায়', async () => {
    const bogus = 'f'.repeat(64);
    const getRes = await freshRequest().get(`/reset-password/${bogus}`);
    expect(getRes.status).toBe(302);
    expect(getRes.headers.location).toBe('/forgot-password');

    const { agent, token: csrf } = await getCsrfAgent('/login');
    const postRes = await agent
      .post(`/reset-password/${bogus}`)
      .type('form')
      .send({ password: 'WhateverPass1', confirmPassword: 'WhateverPass1', _csrf: csrf });
    expect(postRes.status).toBe(302);
    expect(postRes.headers.location).toBe('/forgot-password');
  });

  test('CSRF টোকেন ছাড়া reset-password POST 403 দেয়', async () => {
    const res = await freshRequest()
      .post(`/reset-password/${'a'.repeat(64)}`)
      .type('form')
      .send({ password: 'NoCsrfPass123', confirmPassword: 'NoCsrfPass123' });
    expect(res.status).toBe(403);
  });

  test('৮ অক্ষরের কম পাসওয়ার্ড বা অমিল কনফার্মেশন প্রত্যাখ্যাত হয়, টোকেন নষ্ট হয় না', async () => {
    const email = uniqueEmail();
    const userId = await registerUser(email, 'SecurePass123');
    const token = await requestReset(email);

    const shortTry = await getCsrfAgent(`/reset-password/${token}`);
    const short = await shortTry.agent
      .post(`/reset-password/${token}`)
      .type('form')
      .send({ password: 'abc', confirmPassword: 'abc', _csrf: shortTry.token });
    expect(short.headers.location).toBe(`/reset-password/${token}`);

    const mismatchTry = await getCsrfAgent(`/reset-password/${token}`);
    const mismatch = await mismatchTry.agent
      .post(`/reset-password/${token}`)
      .type('form')
      .send({ password: 'LongEnough123', confirmPassword: 'DifferentOne123', _csrf: mismatchTry.token });
    expect(mismatch.headers.location).toBe(`/reset-password/${token}`);

    const still = await pool.query('SELECT reset_token FROM users WHERE id = $1', [userId]);
    expect(still.rows[0].reset_token).toBe(token);
  });

  // রিগ্রেশন: অ্যাকাউন্ট টেকওভারের পর ভিকটিম রিসেট করলেও আক্রমণকারীর সেশন বহাল থাকত
  test('রিসেটের পর ইউজারের আগের সব ডিভাইস সেশন revoke হয়ে যায়', async () => {
    const email = uniqueEmail();
    const userId = await registerUser(email, 'SecurePass123');

    const active = await pool.query(
      'SELECT COUNT(*)::int AS c FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    expect(active.rows[0].c).toBeGreaterThan(0);

    const token = await requestReset(email);
    const page = await getCsrfAgent(`/reset-password/${token}`);
    await page.agent
      .post(`/reset-password/${token}`)
      .type('form')
      .send({ password: 'RotatedPass789', confirmPassword: 'RotatedPass789', _csrf: page.token });

    const after = await pool.query(
      'SELECT COUNT(*)::int AS c FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    expect(after.rows[0].c).toBe(0);
  });
});
