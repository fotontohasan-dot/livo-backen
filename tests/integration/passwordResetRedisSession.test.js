// Redis সেশন-স্টোর সক্রিয় থাকলে পাসওয়ার্ড রিসেট (routes/auth.js → revokeAllOtherSessions(id, '', 'PASSWORD_RESET'))
// সত্যিই ইউজারের চালু সেশন বাতিল করে কিনা — HTTP স্তরে, আসল Redis + আসল Postgres-এ।
// দ্রষ্টব্য: এই কোডবেসে `must_reset_password` নামে কোনো কলাম/ফ্ল্যাগ নেই; জোরপূর্বক সেশন বাতিলের
// বাস্তব পথ হলো পাসওয়ার্ড রিসেট/পরিবর্তন, ডিভাইস লগআউট ও অ্যাডমিন বাতিল — এখানে রিসেট পথটা যাচাই হয়।
// app.js লোডের আগেই স্টোর নির্বাচনের env সেট করতে হয় (jest প্রতি ফাইলে আলাদা process.env দেয়)।
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
process.env.REDIS_ENABLED = 'true';
process.env.REDIS_URL = REDIS_URL;
process.env.SESSION_STORE_TYPE = 'redis';

const Redis = require('ioredis');
const request = require('supertest');
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

const SESS_PREFIX = 'livo:sess:'; // app.js-এর প্রোডাকশন prefix

async function registerUser(email, password) {
  const { agent, token } = await getCsrfAgent('/register');
  const res = await agent.post('/register').type('form').send({
    username: uniqueUsername('rr'), email, phone: uniquePhone(),
    password, confirmPassword: password, _csrf: token
  });
  expect(res.status).toBe(302);
  const row = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return row.rows[0].id;
}

async function login(email, password) {
  const { agent, token } = await getCsrfAgent('/login');
  const res = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ identifier: email, password, _csrf: token });
  expect(res.status).toBe(302);
  expect(res.headers.location).not.toMatch(/\/login/);
  return agent;
}

async function resetTokenFromQueue(email) {
  for (let i = 0; i < 60; i++) {
    const r = await pool.query(
      `SELECT payload FROM job_queue WHERE type='email' AND payload->>'kind'='password_reset' AND payload->>'to'=$1 ORDER BY id DESC LIMIT 1`,
      [email]
    );
    if (r.rows[0]) {
      const p = typeof r.rows[0].payload === 'string' ? JSON.parse(r.rows[0].payload) : r.rows[0].payload;
      const m = String(p.resetUrl || '').match(/\/reset-password\/([a-f0-9]+)/i);
      if (m) return m[1];
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
}

describe('password reset with the Redis session store active (real Redis + Postgres)', () => {
  let redis;
  beforeAll(() => { redis = new Redis(REDIS_URL); });
  afterAll(async () => { await redis.quit().catch(() => {}); });

  test('reset kills every live session of the user in Redis; the old cookie stops working', async () => {
    const email = `${uniqueUsername('rr')}@example.test`;
    const oldPass = 'SecurePass123';
    const userId = await registerUser(email, oldPass);

    // দুটি আলাদা ডিভাইস/সেশন
    const dev1 = await login(email, oldPass);
    const dev2 = await login(email, oldPass);
    expect((await dev1.get('/profile')).status).toBe(200);
    expect((await dev2.get('/profile')).status).toBe(200);

    const sids = (await pool.query(
      'SELECT sid FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]
    )).rows.map((r) => r.sid);
    expect(sids.length).toBeGreaterThanOrEqual(2);
    // সেশনগুলো সত্যিই Redis স্টোরে আছে (Postgres স্টোরে নয়)
    for (const sid of sids) expect(await redis.exists(`${SESS_PREFIX}${sid}`)).toBe(1);

    // রিসেট ফ্লো (unauthenticated, আলাদা ক্লায়েন্ট)
    const forgot = await getCsrfAgent('/forgot-password');
    await forgot.agent.post('/forgot-password').type('form').send({ email, _csrf: forgot.token });
    const token = await resetTokenFromQueue(email);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const page = await getCsrfAgent(`/reset-password/${token}`);
    const done = await page.agent.post(`/reset-password/${token}`).type('form')
      .send({ password: 'BrandNewPass456', confirmPassword: 'BrandNewPass456', _csrf: page.token });
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/login');

    // Redis থেকে সব সেশন মুছেছে, device_sessions revoked, এবং পুরনো কুকি আর অ্যাক্সেস দেয় না
    for (const sid of sids) expect(await redis.exists(`${SESS_PREFIX}${sid}`)).toBe(0);
    const active = await pool.query(
      'SELECT COUNT(*)::int AS n FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]
    );
    expect(active.rows[0].n).toBe(0);
    for (const dev of [dev1, dev2]) {
      const res = await dev.get('/profile');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
    }
  });
});
