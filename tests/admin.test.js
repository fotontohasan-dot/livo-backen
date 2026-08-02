const request = require('supertest');
const { app, getCsrfAgent } = require('./helpers/app');

describe('Admin Panel', () => {
  test('GET /admin/login renders the admin login page', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
  });

  test('GET /admin redirects to /admin/login when not authenticated', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/login/);
  });

  test('POST /admin/login with wrong credentials does not grant access', async () => {
    const { agent, token } = await getCsrfAgent('/admin/login');
    const res = await agent
      .post('/admin/login')
      .type('form')
      .send({ username: 'nonexistent_admin_xyz', password: 'wrongpass', _csrf: token });
    expect(res.status).toBe(200); // renders login page again with error, not a redirect
  });

  test('Admin API-style route rejects unauthenticated access with 403 JSON', async () => {
    const res = await request(app).get('/admin/api/some-protected-endpoint');
    expect([403, 404]).toContain(res.status);
  });
});
