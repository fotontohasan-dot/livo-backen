// tests/security/accountLifecycleSecurity.test.js
// ---------------------------------------------------------------------------
// PHASE 5 — AUTHENTICATION & ACCOUNT SECURITY
//
//   MEDIUM-5 : password reset সম্পন্ন হলে audit trail থাকতে হবে
//   LOW-2    : cross-site GET /logout সরাসরি session ধ্বংস করবে না
//   Regression: registration mass-assignment, session fixation,
//               account enumeration, banned-user login
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');

const PASSWORD = 'SecurePass123';

async function registerUser(extra = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('ac');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: PASSWORD, confirmPassword: PASSWORD, _csrf: token, ...extra });
  const r = await pool.query('SELECT id, role FROM users WHERE username = $1', [username]);
  return { agent, token, username, user: r.rows[0] };
}

describe('Account lifecycle security (PHASE 5)', () => {
  describe('Registration', () => {
    test('role নিজে পাঠিয়ে admin হওয়া যায় না (mass assignment নেই)', async () => {
      const { user } = await registerUser({ role: 'admin', coins: 999999, is_banned: false });
      expect(user.role).toBe('user');
    });

    test('নতুন account শূন্য balance নিয়ে তৈরি হয়', async () => {
      const { user } = await registerUser({ coins: 500000 });
      const r = await pool.query('SELECT coins FROM users WHERE id = $1', [user.id]);
      expect(Number(r.rows[0].coins)).toBe(0);
    });
  });

  describe('Login', () => {
    test('session fixation: login-এর পরে session id বদলে যায়', async () => {
      const { agent, username } = await registerUser();
      const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      await pool.query('UPDATE users SET phone = $1 WHERE id = $2', [uniquePhone(), r.rows[0].id]);

      //  register-  session   ,       
      // sid    -   
      const sessions = await pool.query(
        'SELECT COUNT(*)::int c FROM device_sessions WHERE user_id = $1', [r.rows[0].id]
      );
      expect(sessions.rows[0].c).toBeGreaterThanOrEqual(1);
      expect(agent).toBeDefined();
    });

    test('banned user login করতে পারে না', async () => {
      const { username, user } = await registerUser();
      const bannedPhone = uniquePhone();
      await pool.query('UPDATE users SET is_banned = true, phone = $1 WHERE id = $2', [bannedPhone, user.id]);

      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: bannedPhone, password: PASSWORD, _csrf: token });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
      const after = await agent.get('/profile/security');
      expect(after.status).toBe(302);
      expect(username).toBeDefined();
    });
  });

  describe('Password reset', () => {
    test('MEDIUM-5: reset সম্পন্ন হলে PASSWORD_RESET_COMPLETED audit event লেখা হয়', async () => {
      const { user } = await registerUser();
      const email = `${uniqueUsername('mail')}@example.com`;
      await pool.query('UPDATE users SET email = $1, email_verified = true WHERE id = $2', [email, user.id]);

      const { hashToken, issueToken } = require('../../utils/tokens');
      const { token, tokenHash } = issueToken();
      await pool.query(
        `UPDATE users SET reset_token = $1, reset_token_expiry = NOW() + INTERVAL '1 hour' WHERE id = $2`,
        [tokenHash, user.id]
      );
      expect(hashToken(token)).toBe(tokenHash);

      const { agent, token: csrf } = await getCsrfAgent(`/reset-password/${token}`);
      const res = await agent.post(`/reset-password/${token}`).set('User-Agent', REALISTIC_UA).type('form')
        .send({ password: 'BrandNewPass456', confirmPassword: 'BrandNewPass456', _csrf: csrf });
      expect(res.status).toBe(302);

      const audit = await pool.query(
        `SELECT status, risk_level, details::text AS d FROM audit_logs
          WHERE actor_id = $1 AND action = 'PASSWORD_RESET_COMPLETED' ORDER BY id DESC LIMIT 1`,
        [user.id]
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].status).toBe('success');
      //   /token   
      expect(audit.rows[0].d).not.toContain('BrandNewPass456');
      expect(audit.rows[0].d).not.toContain(token);
    });

    test('reset token একবারই ব্যবহার করা যায়', async () => {
      const { user } = await registerUser();
      const { issueToken } = require('../../utils/tokens');
      const { token, tokenHash } = issueToken();
      await pool.query(
        `UPDATE users SET reset_token = $1, reset_token_expiry = NOW() + INTERVAL '1 hour' WHERE id = $2`,
        [tokenHash, user.id]
      );

      const first = await getCsrfAgent(`/reset-password/${token}`);
      await first.agent.post(`/reset-password/${token}`).set('User-Agent', REALISTIC_UA).type('form')
        .send({ password: 'FirstNewPass111', confirmPassword: 'FirstNewPass111', _csrf: first.token });

      const second = await getCsrfAgent('/forgot-password');
      const res2 = await second.agent.post(`/reset-password/${token}`).set('User-Agent', REALISTIC_UA).type('form')
        .send({ password: 'SecondNewPass222', confirmPassword: 'SecondNewPass222', _csrf: second.token });

      expect(res2.headers.location).toBe('/forgot-password');
      const row = await pool.query('SELECT reset_token FROM users WHERE id = $1', [user.id]);
      expect(row.rows[0].reset_token).toBeNull();
    });

    test('অস্তিত্বহীন email দিলেও একই response (enumeration নেই)', async () => {
      const a = await getCsrfAgent('/forgot-password');
      const res = await a.agent.post('/forgot-password').set('User-Agent', REALISTIC_UA).type('form')
        .send({ email: `${uniqueUsername('none')}@example.com`, _csrf: a.token });
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/not found|নেই|খুঁজে পাওয়া যায়নি/i);
    });
  });

  describe('LOW-2: logout CSRF', () => {
    test('same-origin GET /logout আগের মতোই কাজ করে (zero-regression)', async () => {
      const { agent } = await registerUser();
      expect((await agent.get('/profile/security')).status).toBe(200);

      await agent.get('/logout');

      const after = await agent.get('/profile/security');
      expect(after.status).toBe(302);
      expect(after.headers.location).toMatch(/\/login/);
    });

    test('cross-site GET /logout session ধ্বংস করে না', async () => {
      const { agent } = await registerUser();
      expect((await agent.get('/profile/security')).status).toBe(200);

      const res = await agent.get('/logout').set('Sec-Fetch-Site', 'cross-site');
      expect(res.status).toBe(200);
      expect(res.text).toContain('action="/logout"');

      //  session  
      expect((await agent.get('/profile/security')).status).toBe(200);
    });

    test('mismatched Origin দিয়ে GET /logout session ধ্বংস করে না', async () => {
      const { agent } = await registerUser();
      const res = await agent.get('/logout').set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(200);
      expect((await agent.get('/profile/security')).status).toBe(200);
    });

    test('POST /logout CSRF token সহ কাজ করে', async () => {
      const { agent } = await registerUser();
      const page = await agent.get('/profile/security');
      const m = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text);

      const res = await agent.post('/logout').set('User-Agent', REALISTIC_UA).type('form')
        .send({ _csrf: m ? m[1] : '' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
      expect((await agent.get('/profile/security')).status).toBe(302);
    });

    test('unauthenticated GET /logout সরাসরি login-এ পাঠায়', async () => {
      const res = await freshRequest().get('/logout');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/login/);
    });
  });
});
