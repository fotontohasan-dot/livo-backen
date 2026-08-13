// tests/security/adminLeaderboard.test.js
// ---------------------------------------------------------------------------
// Admin → Leaderboard ম্যানেজমেন্ট পেজের নিরাপত্তা কভারেজ:
//   • অথেন্টিকেশন গেট (isAdmin) — লগইন ছাড়া/সাধারণ ইউজার ঢুকতে পারে না
//   • CSRF — টোকেন ছাড়া ব্যান/আনব্যান টগল পাস করে না
//   • Search/filter — সঠিকভাবে কাজ করে, SQL injection-ধর্মী ইনপুট নিরাপদ থাকে
//   • মডারেশন — ব্যান/আনব্যান টগল সঠিকভাবে কাজ করে, পাবলিক leaderboard cache ইনভ্যালিডেট হয়
//   • Audit — admin_logs + audit_logs দুই জায়গাতেই লেখা হয়
// পাবলিক /leaderboard পেজের আচরণ অপরিবর্তিত থাকে কিনা তাও যাচাই করা হয়েছে।
// এই টেস্টগুলো DB ব্যবহার করে (বাকি tests/security/*.test.js-এর মতোই)।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');
const cache = require('../../services/cache');
const cacheKeys = require('../../services/cacheKeys');

async function registerUser(agent, token) {
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  return { username, phone };
}

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const { username } = await registerUser(agent, token);
  const userRes = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
  return { agent, token, username, userId: userRes.rows[0].id };
}

async function makeTargetUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const { username } = await registerUser(agent, token);
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { username, userId: r.rows[0].id };
}

async function makeNonAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const { username } = await registerUser(agent, token);
  return { agent, token, username };
}

describe('Admin Leaderboard Management (routes/adminLeaderboard.js)', () => {
  describe('অথেন্টিকেশন ও অথরাইজেশন', () => {
    test('লগইন ছাড়া পেজে ঢোকা যায় না', async () => {
      const res = await freshRequest().get('/admin/leaderboard');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });

    test('সাধারণ (non-admin) ইউজারও ঢুকতে পারে না', async () => {
      const { agent } = await makeNonAdminAgent();
      const res = await agent.get('/admin/leaderboard');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });

    test('লগইন ছাড়া ব্যান টগল করা যায় না', async () => {
      const target = await makeTargetUser();
      const res = await freshRequest()
        .post(`/admin/leaderboard/${target.userId}/toggle-ban`)
        .type('form')
        .send({});
      expect([302, 403]).toContain(res.status);
      const row = await pool.query('SELECT is_banned FROM users WHERE id = $1', [target.userId]);
      expect(row.rows[0].is_banned).not.toBe(true);
    });

    test('অ্যাডমিন পেজটি দেখতে পারে', async () => {
      const { agent } = await makeAdminAgent();
      const res = await agent.get('/admin/leaderboard');
      expect(res.status).toBe(200);
      expect(res.text).toContain('লিডারবোর্ড');
    });
  });

  describe('CSRF সুরক্ষা', () => {
    test('CSRF টোকেন ছাড়া ব্যান টগল 403 দেয়', async () => {
      const { agent } = await makeAdminAgent();
      const target = await makeTargetUser();
      const res = await agent.post(`/admin/leaderboard/${target.userId}/toggle-ban`).type('form').send({});
      expect(res.status).toBe(403);
      const row = await pool.query('SELECT is_banned FROM users WHERE id = $1', [target.userId]);
      expect(row.rows[0].is_banned).not.toBe(true);
    });
  });

  describe('সার্চ/ফিল্টার', () => {
    test('ইউজারনেম দিয়ে সার্চ করলে সঠিক ইউজার ফেরত আসে', async () => {
      const { agent } = await makeAdminAgent();
      const target = await makeTargetUser();
      const res = await agent.get(`/admin/leaderboard?search=${encodeURIComponent(target.username)}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain(target.username);
    });

    test('SQL injection-ধর্মী সার্চ ইনপুট নিরাপদে হ্যান্ডল হয় (ক্র্যাশ করে না)', async () => {
      const { agent } = await makeAdminAgent();
      const res = await agent.get(`/admin/leaderboard?search=${encodeURIComponent("x'; DROP TABLE users;--")}`);
      expect(res.status).toBe(200);
      const check = await pool.query('SELECT 1 FROM users LIMIT 1');
      expect(check.rows.length).toBeGreaterThan(0);
    });

    test('status=banned ফিল্টার শুধু ব্যান করা ইউজার দেখায়', async () => {
      const { agent, token } = await makeAdminAgent();
      const target = await makeTargetUser();
      await agent.post(`/admin/leaderboard/${target.userId}/toggle-ban`).type('form').send({ _csrf: token });

      const res = await agent.get('/admin/leaderboard?status=banned');
      expect(res.status).toBe(200);
      expect(res.text).toContain(target.username);
    });
  });

  describe('মডারেশন (ব্যান/আনব্যান টগল)', () => {
    test('ব্যান টগল করলে is_banned পরিবর্তিত হয় এবং পাবলিক /leaderboard 200 থাকে', async () => {
      const { agent, token } = await makeAdminAgent();
      const target = await makeTargetUser();

      const res = await agent.post(`/admin/leaderboard/${target.userId}/toggle-ban`).type('form').send({ _csrf: token });
      expect(res.status).toBe(302);

      const row = await pool.query('SELECT is_banned FROM users WHERE id = $1', [target.userId]);
      expect(row.rows[0].is_banned).toBe(true);

      // পাবলিক লিডারবোর্ড পেজের আচরণ অপরিবর্তিত (এখনো লোড হয়, এই রুট স্পর্শ করেনি)
      const pub = await freshRequest().get('/leaderboard');
      expect(pub.status).toBe(200);
    });

    test('দ্বিতীয়বার টগল করলে আনব্যান হয়', async () => {
      const { agent, token } = await makeAdminAgent();
      const target = await makeTargetUser();

      await agent.post(`/admin/leaderboard/${target.userId}/toggle-ban`).type('form').send({ _csrf: token });
      await agent.post(`/admin/leaderboard/${target.userId}/toggle-ban`).type('form').send({ _csrf: token });

      const row = await pool.query('SELECT is_banned FROM users WHERE id = $1', [target.userId]);
      expect(row.rows[0].is_banned).toBe(false);
    });

    test('ব্যান টগল করলে leaderboard:top50 cache ইনভ্যালিডেট হয়', async () => {
      const { agent, token } = await makeAdminAgent();
      const target = await makeTargetUser();
      await cache.set(cacheKeys.leaderboardTop50(), JSON.stringify([{ dummy: true }]), 60);

      await agent.post(`/admin/leaderboard/${target.userId}/toggle-ban`).type('form').send({ _csrf: token });

      const cached = await cache.get(cacheKeys.leaderboardTop50()).catch(() => null);
      expect(cached).toBeNull();
    });

    test('অস্তিত্বহীন ইউজার আইডিতে টগল করলে এরর মেসেজসহ রিডাইরেক্ট হয়', async () => {
      const { agent, token } = await makeAdminAgent();
      const res = await agent.post('/admin/leaderboard/999999999/toggle-ban').type('form').send({ _csrf: token });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
    });
  });

  describe('Audit logging', () => {
    test('ব্যান টগল admin_logs ও audit_logs দুটোতেই লেখা হয়', async () => {
      const { agent, token, username: adminUsername } = await makeAdminAgent();
      const target = await makeTargetUser();

      await agent.post(`/admin/leaderboard/${target.userId}/toggle-ban`).type('form').send({ _csrf: token });

      const adminLog = await pool.query(
        `SELECT * FROM admin_logs WHERE admin_username = $1 AND action_type = 'USER_BAN' ORDER BY id DESC LIMIT 1`,
        [adminUsername]
      );
      expect(adminLog.rows.length).toBeGreaterThan(0);
      expect(adminLog.rows[0].details).toContain('লিডারবোর্ড');

      await new Promise(r => setTimeout(r, 300));
      const auditLog = await pool.query(
        `SELECT * FROM audit_logs WHERE actor_username = $1 AND action = 'USER_BANNED' ORDER BY id DESC LIMIT 1`,
        [adminUsername]
      );
      expect(auditLog.rows.length).toBeGreaterThan(0);
      expect(auditLog.rows[0].risk_level).toBe('high');
      expect(auditLog.rows[0].category).toBe('security');
    });
  });
});
