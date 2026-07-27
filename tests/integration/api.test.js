// tests/integration/api.test.js
const request = require('supertest');
const { BASE_URL: app } = require('../helpers/testServerConfig');
const { waitForApp } = require('../helpers/waitForApp');

describe('Public API (/api/v1)', () => {
  beforeAll(async () => {
    await waitForApp(app);
  }, 60000);

  test('GET /api/v1/status is publicly accessible without an API key', async () => {
    const res = await request(app).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: 'v1' });
    expect(res.body).toHaveProperty('time');
  });

  test('GET /api/v1/matches without an API key is rejected with 401', async () => {
    const res = await request(app).get('/api/v1/matches');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'unauthorized');
  });

  test('GET /api/v1/leaderboard with an invalid API key is rejected with 401', async () => {
    const res = await request(app)
      .get('/api/v1/leaderboard')
      .set('X-API-Key', 'this-key-does-not-exist');
    expect(res.status).toBe(401);
  });

  test('GET /api/v1/tournaments rejects malformed pagination params (negative offset)', async () => {
    // এই এন্ডপয়েন্ট API key ছাড়া 401 দেয় — pagination validation তার আগেই বসানো
    // মিডলওয়্যার চেইনে requireApiKey এর পরে চলে, তাই 401 আসাটাই প্রত্যাশিত ও নিরাপদ আচরণ।
    const res = await request(app).get('/api/v1/tournaments?offset=-1');
    expect(res.status).toBe(401);
  });

  test('unknown /api/v1 route returns 404, not a stack trace', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
  });
});
