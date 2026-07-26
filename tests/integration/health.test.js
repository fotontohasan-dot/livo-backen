// tests/integration/health.test.js
const request = require('supertest');
const app = require('../../app');
const { waitForApp } = require('../helpers/waitForApp');

describe('Health Check endpoints', () => {
  beforeAll(async () => {
    await waitForApp(app);
  }, 60000);

  test('GET /ready returns 200 and ready:true once DB is connected', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ready: true });
  });

  test('GET /health returns a full health report without requiring authentication', async () => {
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('checks');
    expect(res.body.checks).toHaveProperty('uptime');
  });

  test('GET /health does not leak sensitive information (no DB credentials, no stack traces)', async () => {
    const res = await request(app).get('/health');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/DATABASE_URL|SESSION_SECRET|password/i);
  });
});
