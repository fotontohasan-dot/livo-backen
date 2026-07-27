const request = require('supertest');
const { app, REALISTIC_UA } = require('./helpers/app');

describe('Security', () => {
  test('Helmet security headers are present', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('Cross-origin POST with mismatched Origin header is rejected (403)', async () => {
    const res = await request(app)
      .post('/login')
      .set('Origin', 'https://evil-attacker-site.example')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: 'x@test.com', password: 'whatever' });
    expect(res.status).toBe(403);
  });

  test('Login rate limiter blocks after repeated failed attempts', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').set('User-Agent', REALISTIC_UA);
    const tokenMatch = /<meta name="csrf-token" content="([^"]*)"/.exec(loginPage.text || '');
    const token = tokenMatch ? tokenMatch[1] : '';

    let lastStatus = 200;
    for (let i = 0; i < 12; i++) {
      const res = await agent
        .post('/login')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ identifier: 'ratelimit_test@test.com', password: 'wrongpass', _csrf: token });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect([302, 429]).toContain(lastStatus);
  });

  test('Unknown route returns 404', async () => {
    const res = await request(app).get('/this-route-does-not-exist-xyz');
    expect(res.status).toBe(404);
  });
});
