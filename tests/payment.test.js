const request = require('supertest');
const { app } = require('./helpers/app');

describe('Payment', () => {
  test('POST /payment/withdraw redirects to login when unauthenticated', async () => {
    const res = await request(app).post('/payment/withdraw').type('form').send({ amount: 500 });
    expect([302, 403]).toContain(res.status);
  });

  test('GET /payment/withdraw redirects to login when unauthenticated', async () => {
    const res = await request(app).get('/payment/withdraw');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test('GET /payment/deposit redirects to login when unauthenticated', async () => {
    const res = await request(app).get('/payment/deposit');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });
});
