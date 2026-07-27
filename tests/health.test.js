const request = require('supertest');
const { app } = require('./helpers/app');

describe('Health Check', () => {
  test('GET /health returns 200 with liveness status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });

  test('GET /ready returns readiness status (200 or 503)', async () => {
    const res = await request(app).get('/ready');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
  });
});
