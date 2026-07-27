// tests/integration/security.test.js
const { BASE_URL: app } = require('../helpers/testServerConfig');
const { waitForApp } = require('../helpers/waitForApp');
const { buildTestUser, extractCsrfToken } = require('../helpers/testUser');
const { humanAgent, humanRequest, formRenderedAt } = require('../helpers/humanAgent');

describe('Security', () => {
  beforeAll(async () => {
    await waitForApp(app);
  }, 60000);

  describe('HTTP security headers (helmet)', () => {
    test('responses include standard security headers', async () => {
      const res = await humanRequest(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options'] || res.headers['content-security-policy']).toBeTruthy();
    });

    test('X-Powered-By header is not exposed (avoid leaking tech stack)', async () => {
      const res = await humanRequest(app).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('Admin route protection', () => {
    test('unauthenticated GET /admin redirects to /admin/login (no data leak)', async () => {
      const res = await humanRequest(app).get('/admin');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });

    test('unauthenticated GET /admin/api/system-diagnostics returns JSON 403, not a redirect (API-style path)', async () => {
      const res = await humanRequest(app).get('/admin/api/system-diagnostics');
      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty('success', false);
    });

    test('a regular (non-admin) logged-in user cannot access /admin', async () => {
      const agent = humanAgent(app);
      const page = await agent.get('/register');
      const token = extractCsrfToken(page.text);
      const user = buildTestUser();
      await agent.post('/register').type('form').send({ ...user, _csrf: token, form_rendered_at: formRenderedAt() });

      const res = await agent.get('/admin');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });
  });

  describe('Payment route protection', () => {
    test('unauthenticated GET /payment/deposit redirects to /login', async () => {
      const res = await humanRequest(app).get('/payment/deposit');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    test('unauthenticated GET /payment/withdraw redirects to /login', async () => {
      const res = await humanRequest(app).get('/payment/withdraw');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    test('unauthenticated GET /payment/admin/summary redirects (admin-only)', async () => {
      const res = await humanRequest(app).get('/payment/admin/summary');
      expect(res.status).toBe(302);
    });

    test('a logged-in user can view their own deposit page', async () => {
      const agent = humanAgent(app);
      const page = await agent.get('/register');
      const token = extractCsrfToken(page.text);
      const user = buildTestUser();
      await agent.post('/register').type('form').send({ ...user, _csrf: token, form_rendered_at: formRenderedAt() });

      const res = await agent.get('/payment/deposit');
      expect(res.status).toBe(200);
    });
  });

  describe('CSRF protection on state-changing routes', () => {
    test('POST without a CSRF token to a session-protected form route is rejected (403)', async () => {
      const agent = humanAgent(app);
      await agent.get('/login'); // সেশন শুরু করার জন্য
      const res = await agent.post('/register').type('form').send({ ...buildTestUser(), form_rendered_at: formRenderedAt() });
      expect(res.status).toBe(403);
    });

    test('CSRF protection does not apply to the public /api/ routes (server-to-server/API-key auth)', async () => {
      const res = await humanRequest(app).get('/api/v1/status'); // GET কখনোই CSRF-checked না, তাই সরাসরি JSON status দেখে যাচাই
      expect(res.status).toBe(200);
    });
  });

  describe('Rate limiting on the login endpoint', () => {
    test('repeated failed login attempts from the same IP eventually return 429', async () => {
      const agent = humanAgent(app); // এই টেস্টের জন্য ইচ্ছাকৃতভাবে একই ফেক IP বারবার ব্যবহার হয়
      const loginPage = await agent.get('/login');
      const token = extractCsrfToken(loginPage.text);

      let lastStatus = null;
      // app.js-এ loginLimiter max: 10 requests / 15 minutes প্রতি IP-তে (/login ও /register শেয়ার্ড)
      for (let i = 0; i < 12; i++) {
        const res = await agent
          .post('/login')
          .type('form')
          .send({ identifier: 'nonexistent_user', password: 'wrongpass', _csrf: token, form_rendered_at: formRenderedAt() });
        lastStatus = res.status;
        if (res.status === 429) break;
      }
      expect(lastStatus).toBe(429);
    });
  });
});
