// tests/auth-google.test.js
// google-auth-library-কে সরাসরি মক করা হচ্ছে (services/googleAuth.js এটাই ব্যবহার করে) —
// এই sandbox-এর নেটওয়ার্ক allowlist-এ accounts.google.com/oauth2.googleapis.com নেই, তাই আসল
// Google-এর সাথে end-to-end যাচাই সম্ভব না। state/nonce/session-reuse/find-or-create লজিক —
// এই সবগুলো routes/auth.js-এর নিজস্ব কোড, google-auth-library-নির্ভর না, তাই পুরোপুরি যাচাইযোগ্য।
jest.mock('../services/googleAuth');

const googleAuth = require('../services/googleAuth');
const { pool } = require('../db');
// `app` এখানে helpers/app.js-এর শেয়ার্ড listening সার্ভার — supertest-কে non-listening
// express অ্যাপ দিলে সে প্রতি রিকোয়েস্টে নিজে listen/close করে (ECONNRESET-এর উৎস)।
const { app, getCsrfAgent, freshRequest, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const supertest = require('supertest');
const bcrypt = require('bcryptjs');

function mockConfigured(exchangeImpl) {
  googleAuth.isConfigured.mockReturnValue(true);
  googleAuth.generateAuthUrl.mockImplementation((redirectUri, state, nonce) =>
    `https://accounts.google.com/mock-oauth?state=${state}&nonce=${nonce}`
  );
  if (exchangeImpl) googleAuth.exchangeCodeForProfile.mockImplementation(exchangeImpl);
}

function extractStateFromRedirect(location) {
  const url = new URL(location);
  return url.searchParams.get('state');
}

function fakeIp() {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

function ipAgent() {
  const ip = fakeIp();
  const raw = supertest.agent(app);
  return {
    get: (path) => raw.get(path).set('X-Forwarded-For', ip).set('User-Agent', REALISTIC_UA)
  };
}

describe('Google Sign-In', () => {
  afterEach(() => jest.clearAllMocks());

  describe('GET /auth/google', () => {
    test('কনফিগার করা না থাকলে /login-এ এরর সহ রিডাইরেক্ট হয়', async () => {
      googleAuth.isConfigured.mockReturnValue(false);
      const res = await freshRequest().get('/auth/google');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
    });

    test('কনফিগার করা থাকলে Google-এর URL-এ রিডাইরেক্ট করে ও state/nonce জেনারেট করে', async () => {
      mockConfigured();
      const res = await freshRequest().get('/auth/google');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('accounts.google.com');
      expect(googleAuth.generateAuthUrl).toHaveBeenCalledTimes(1);
      const [, state, nonce] = googleAuth.generateAuthUrl.mock.calls[0];
      expect(state).toHaveLength(48); // randomBytes(24).toString('hex')
      expect(nonce).toHaveLength(48);
    });
  });

  describe('GET /auth/google/callback', () => {
    test('code/state ছাড়া কল করলে এরর সহ /login-এ রিডাইরেক্ট হয়, লগইন হয় না', async () => {
      mockConfigured();
      const res = await freshRequest().get('/auth/google/callback');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
      expect(googleAuth.exchangeCodeForProfile).not.toHaveBeenCalled();
    });

    test('ভুল/অমিল state প্রত্যাখ্যাত হয় (CSRF/replay সুরক্ষা)', async () => {
      mockConfigured();
      const agent = ipAgent();
      const start = await agent.get('/auth/google');
      expect(start.status).toBe(302);

      const res = await agent.get('/auth/google/callback?code=fakecode&state=totally-wrong-state');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
      expect(googleAuth.exchangeCodeForProfile).not.toHaveBeenCalled();
    });

    test('Google থেকে error প্যারামিটার এলে (ইউজার consent বাতিল করলে) লগইন হয় না', async () => {
      mockConfigured();
      const res = await freshRequest().get('/auth/google/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
      expect(googleAuth.exchangeCodeForProfile).not.toHaveBeenCalled();
    });

    test('অভেরিফাইড ইমেইল প্রত্যাখ্যাত হয়', async () => {
      const email = `unverified_${Date.now()}@example.com`;
      mockConfigured(async () => ({ googleId: `g_${Date.now()}`, email, emailVerified: false, name: 'Test', picture: null }));

      const agent = ipAgent();
      const start = await agent.get('/auth/google');
      const state = extractStateFromRedirect(start.headers.location);

      const res = await agent.get(`/auth/google/callback?code=fakecode&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);

      const u = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
      expect(u.rows.length).toBe(0); // অ্যাকাউন্ট তৈরি হয়নি
    });

    test('নতুন ইমেইলে সফল Google লগইন — নতুন অ্যাকাউন্ট তৈরি হয়, session establish হয়, password bcrypt-হ্যাশড ও র‍্যান্ডম, google_id সেভ থাকে', async () => {
      const googleId = `g_new_${Date.now()}`;
      const email = `newgoogleuser_${Date.now()}@example.com`;
      mockConfigured(async () => ({ googleId, email, emailVerified: true, name: 'New Google User', picture: 'https://example.com/pic.jpg' }));

      const agent = ipAgent();
      const start = await agent.get('/auth/google');
      const state = extractStateFromRedirect(start.headers.location);

      const res = await agent.get(`/auth/google/callback?code=fakecode&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toMatch(/\/login/);

      const u = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      expect(u.rows.length).toBe(1);
      expect(u.rows[0].google_id).toBe(googleId);
      expect(u.rows[0].auth_provider).toBe('google');
      expect(u.rows[0].email_verified).toBe(true);
      expect(u.rows[0].password).toBeTruthy();
      expect(await bcrypt.compare(googleId, u.rows[0].password)).toBe(false); // পাসওয়ার্ডটা আসলেই র‍্যান্ডম, google id নয়

      // session সত্যিই establish হয়েছে কিনা — এখনই /profile অ্যাক্সেসযোগ্য হওয়া উচিত
      const profileRes = await agent.get('/profile');
      expect(profileRes.status).toBe(200);
    });

    test('বিদ্যমান local অ্যাকাউন্টের একই ইমেইলে Google লগইন করলে — নতুন অ্যাকাউন্ট তৈরি না হয়ে বিদ্যমানটার সাথে google_id লিংক হয়', async () => {
      const { agent: regAgent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      const email = `linkme_${Date.now()}@example.com`;
      await regAgent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username, email, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
      const before = await pool.query('SELECT id, password FROM users WHERE email=$1', [email]);
      expect(before.rows.length).toBe(1);

      const googleId = `g_link_${Date.now()}`;
      mockConfigured(async () => ({ googleId, email, emailVerified: true, name: 'Link Me', picture: null }));

      const agent = ipAgent();
      const start = await agent.get('/auth/google');
      const state = extractStateFromRedirect(start.headers.location);
      const res = await agent.get(`/auth/google/callback?code=fakecode&state=${state}`);
      expect(res.status).toBe(302);

      const after = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      expect(after.rows.length).toBe(1); // কোনো ডুপ্লিকেট অ্যাকাউন্ট তৈরি হয়নি
      expect(after.rows[0].id).toBe(before.rows[0].id);
      expect(after.rows[0].google_id).toBe(googleId);
      expect(after.rows[0].password).toBe(before.rows[0].password); // বিদ্যমান পাসওয়ার্ড অপরিবর্তিত
    });

    test('আগে থেকেই লিংক করা google_id দিয়ে আবার লগইন করলে একই অ্যাকাউন্টেই ঢোকে (ডুপ্লিকেট হয় না)', async () => {
      const googleId = `g_repeat_${Date.now()}`;
      const email = `repeatgoogle_${Date.now()}@example.com`;
      mockConfigured(async () => ({ googleId, email, emailVerified: true, name: 'Repeat User', picture: null }));

      const agent1 = ipAgent();
      const s1 = await agent1.get('/auth/google');
      await agent1.get(`/auth/google/callback?code=x&state=${extractStateFromRedirect(s1.headers.location)}`);
      const firstLogin = await pool.query('SELECT id FROM users WHERE google_id=$1', [googleId]);
      expect(firstLogin.rows.length).toBe(1);

      const agent2 = ipAgent();
      const s2 = await agent2.get('/auth/google');
      await agent2.get(`/auth/google/callback?code=y&state=${extractStateFromRedirect(s2.headers.location)}`);

      const all = await pool.query('SELECT id FROM users WHERE google_id=$1', [googleId]);
      expect(all.rows.length).toBe(1); // দ্বিতীয়বারও একই একটামাত্র রো
      expect(all.rows[0].id).toBe(firstLogin.rows[0].id);
    });

    test('ব্যান করা অ্যাকাউন্ট Google দিয়েও লগইন করতে পারে না', async () => {
      const googleId = `g_banned_${Date.now()}`;
      const email = `bannedgoogle_${Date.now()}@example.com`;
      mockConfigured(async () => ({ googleId, email, emailVerified: true, name: 'Banned', picture: null }));

      const agent = ipAgent();
      const s1 = await agent.get('/auth/google');
      await agent.get(`/auth/google/callback?code=x&state=${extractStateFromRedirect(s1.headers.location)}`);
      await pool.query('UPDATE users SET is_banned=true WHERE google_id=$1', [googleId]);
      await agent.get('/logout');

      const s2 = await agent.get('/auth/google');
      const res = await agent.get(`/auth/google/callback?code=z&state=${extractStateFromRedirect(s2.headers.location)}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);

      const profileCheck = await agent.get('/profile');
      expect(profileCheck.status).toBe(302); // সেশন establish হয়নি
    });

    test('exchangeCodeForProfile থ্রো করলে (নেটওয়ার্ক/Google এরর) গ্রেসফুলি /login-এ রিডাইরেক্ট হয়', async () => {
      mockConfigured(async () => { throw new Error('simulated google api error'); });
      const agent = ipAgent();
      const start = await agent.get('/auth/google');
      const state = extractStateFromRedirect(start.headers.location);
      const res = await agent.get(`/auth/google/callback?code=x&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
    });
  });

  describe('UI', () => {
    test('লগইন পেজে "Continue with Google" বাটন/লিংক আছে', async () => {
      const res = await freshRequest().get('/login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('/auth/google');
    });

    test('রেজিস্ট্রেশন পেজে "Continue with Google" বাটন/লিংক আছে', async () => {
      const res = await freshRequest().get('/register');
      expect(res.status).toBe(200);
      expect(res.text).toContain('/auth/google');
    });
  });

  describe('বিদ্যমান ইমেইল/ফোন+পাসওয়ার্ড লগইন অক্ষত আছে', () => {
    test('স্বাভাবিক রেজিস্ট্রেশন+লগইন এখনও কাজ করে', async () => {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      const phone = uniquePhone();
      const reg = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
      expect(reg.status).toBe(302);

      const g = await getCsrfAgent('/login');
      const res = await g.agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: phone, password: 'SecurePass123', _csrf: g.token });
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toMatch(/\/login/);
    });
  });
});
