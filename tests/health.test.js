const { freshRequest } = require('./helpers/app');

describe('Health Check', () => {
  test('GET /health returns 200 with liveness status', async () => {
    const res = await freshRequest().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
  });

  test('GET /ready returns readiness status (200 or 503)', async () => {
    const res = await freshRequest().get('/ready');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
  });
});
