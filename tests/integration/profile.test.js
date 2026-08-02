// tests/integration/profile.test.js
const request = require('supertest');
const { app, getCsrfAgent, uniqueUsername, REALISTIC_UA } = require('../helpers/app');

async function registerAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = '01' + String(Date.now()).slice(-9);
  const password = 'SecurePass123';
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password, confirmPassword: password, _csrf: token });
  return { agent, username, phone, password };
}

describe('Profile routes', () => {
  test('unauthenticated GET /profile/security redirects to /login', async () => {
    const res = await request(app).get('/profile/security');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test('GET /profile/api/balance returns JSON for logged-in user', async () => {
    const { agent } = await registerAgent();
    const res = await agent.get('/profile/api/balance').set('User-Agent', REALISTIC_UA);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coins');
  });

  test('GET /profile/security renders for logged-in user', async () => {
    const { agent } = await registerAgent();
    const res = await agent.get('/profile/security').set('User-Agent', REALISTIC_UA);
    expect(res.status).toBe(200);
  });

  test('POST /profile/change-password rejects wrong current password', async () => {
    const { agent } = await registerAgent();
    const page = await agent.get('/profile/security').set('User-Agent', REALISTIC_UA);
    const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '')?.[1] || '';

    const res = await agent
      .post('/profile/change-password')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ current_password: 'WrongOldPass1!', new_password: 'NewPass123!', confirmPassword: 'NewPass123!', _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile/security');
  });

  test('POST /profile/change-password succeeds and new login works', async () => {
    const { agent, phone } = await registerAgent();
    const page = await agent.get('/profile/security').set('User-Agent', REALISTIC_UA);
    const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '')?.[1] || '';

    const res = await agent
      .post('/profile/change-password')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ current_password: 'SecurePass123', new_password: 'NewPass456!', confirmPassword: 'NewPass456!', _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile/security');

    await agent.get('/logout').set('User-Agent', REALISTIC_UA);
    const { agent: loginAgent, token: loginToken } = await getCsrfAgent('/login');
    const loginRes = await loginAgent
      .post('/login')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: phone, password: 'NewPass456!', _csrf: loginToken });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).not.toBe('/login');
  });

  test('POST /profile/change-password without CSRF token is rejected', async () => {
    const { agent } = await registerAgent();
    const res = await agent
      .post('/profile/change-password')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ current_password: 'SecurePass123', new_password: 'AnotherPass123!', confirmPassword: 'AnotherPass123!' });
    expect(res.status).toBe(403);
  });
});
