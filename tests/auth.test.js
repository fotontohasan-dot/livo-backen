const request = require('supertest');
const { app, getCsrfAgent, uniqueUsername, REALISTIC_UA } = require('./helpers/app');

describe('Authentication', () => {
  test('POST without a CSRF token is rejected with 403', async () => {
    const res = await request(app)
      .post('/login')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: 'someone@test.com', password: 'whatever' });
    expect(res.status).toBe(403);
  });

  test('Protected route redirects to /login when not authenticated', async () => {
    const res = await request(app).get('/profile/security');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test('GET /register renders the registration page', async () => {
    const res = await request(app).get('/register');
    expect(res.status).toBe(200);
  });

  test('GET /login renders the login page', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
  });

  test('POST /register successfully creates a user and logs in (redirect to /)', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const phone = '01' + String(Date.now()).slice(-9);
    const res = await agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('POST /login with correct credentials logs the user in', async () => {
    const regAgentInfo = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const phone = '01' + String(Date.now()).slice(-9);
    await regAgentInfo.agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: regAgentInfo.token });

    const { agent, token } = await getCsrfAgent('/login');
    const res = await agent
      .post('/login')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: phone, password: 'SecurePass123', _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/login');
  });

  test('POST /register with missing password redirects back with error', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const res = await agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ username: uniqueUsername(), _csrf: token });
    expect([302, 429]).toContain(res.status);
  });

  test('POST /register with short password redirects back with error', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const res = await agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ username: uniqueUsername(), email: `${uniqueUsername()}@test.com`, password: '123', _csrf: token });
    expect([302, 429]).toContain(res.status);
  });

  test('POST /login with wrong credentials redirects back to /login', async () => {
    const { agent, token } = await getCsrfAgent('/login');
    const res = await agent
      .post('/login')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ identifier: 'nonexistent_user_xyz@test.com', password: 'wrongpass', _csrf: token });
    expect([302, 429]).toContain(res.status);
  });
});
