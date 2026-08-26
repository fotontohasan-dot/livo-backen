const { freshRequest } = require('./helpers/app');

describe('API', () => {
  test('Unknown /api/* paths return 404 (no unauthenticated API surface exposed)', async () => {
    const res = await freshRequest().get('/api/matches');
    expect(res.status).toBe(404);
  });

  test('Unknown /api/* POST paths do not leak a CSRF-token error before 404ing', async () => {
    const res = await freshRequest().post('/api/some-endpoint').send({});
    if (res.status === 403) {
      expect(res.body && res.body.code).not.toBe('CSRF_TOKEN_INVALID');
    } else {
      expect(res.status).toBe(404);
    }
  });
});
