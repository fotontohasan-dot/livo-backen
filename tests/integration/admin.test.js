// tests/integration/admin.test.js
const { BASE_URL: app } = require('../helpers/testServerConfig');
const { pool } = require('../../db');
const { waitForApp } = require('../helpers/waitForApp');
const { buildTestUser, extractCsrfToken } = require('../helpers/testUser');
const { humanAgent, humanRequest, formRenderedAt } = require('../helpers/humanAgent');

describe('Admin panel access control', () => {
  beforeAll(async () => {
    await waitForApp(app);
  }, 60000);

  test('unauthenticated requests never reach admin data (list of users stays private)', async () => {
    const res = await humanRequest(app).get('/admin');
    expect(res.status).toBe(302);
    expect(res.text).not.toMatch(/qauser_/);
  });

  test('promoting a user to admin (directly via DB, simulating an already-approved admin) grants /admin access', async () => {
    const agent = humanAgent(app);
    const page = await agent.get('/register');
    const token = extractCsrfToken(page.text);
    const user = buildTestUser();
    await agent.post('/register').type('form').send({ ...user, _csrf: token, form_rendered_at: formRenderedAt() });

    // ডাটাবেজে সরাসরি role আপডেট (এটা একটা isolated টেস্ট ডাটাবেজ — production ডেটা নয়)
    await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', user.username]);

    const res = await agent.get('/admin');
    // isAdmin মিডলওয়্যার সেশনে থাকা role নয়, প্রতিবার DB থেকে সরাসরি current role চেক করে —
    // তাই role আপডেট হওয়ার সাথে সাথেই (re-login ছাড়াই) অ্যাক্সেস পাওয়া উচিত।
    expect(res.status).toBe(200);
  });

  test('demoting an admin back to a regular user immediately revokes /admin access (no re-login needed)', async () => {
    const agent = humanAgent(app);
    const page = await agent.get('/register');
    const token = extractCsrfToken(page.text);
    const user = buildTestUser();
    await agent.post('/register').type('form').send({ ...user, _csrf: token, form_rendered_at: formRenderedAt() });

    await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', user.username]);
    const adminRes = await agent.get('/admin');
    expect(adminRes.status).toBe(200);

    await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['user', user.username]);
    const demotedRes = await agent.get('/admin');
    expect(demotedRes.status).toBe(302);
    expect(demotedRes.headers.location).toBe('/admin/login');
  });
});
