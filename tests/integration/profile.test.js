// tests/integration/profile.test.js
const { BASE_URL: app } = require('../helpers/testServerConfig');
const { waitForApp } = require('../helpers/waitForApp');
const { buildTestUser, extractCsrfToken } = require('../helpers/testUser');
const { humanAgent, humanRequest, formRenderedAt } = require('../helpers/humanAgent');

async function registerAgent() {
  const agent = humanAgent(app);
  const page = await agent.get('/register');
  const token = extractCsrfToken(page.text);
  const user = buildTestUser();
  await agent.post('/register').type('form').send({ ...user, _csrf: token, form_rendered_at: formRenderedAt() });
  return { agent, user };
}

describe('Profile routes', () => {
  beforeAll(async () => {
    await waitForApp(app);
  }, 60000);

  test('unauthenticated GET /profile/security redirects to /login', async () => {
    const res = await humanRequest(app).get('/profile/security');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /profile/api/balance returns JSON balance for logged-in user', async () => {
    const { agent } = await registerAgent();
    const res = await agent.get('/profile/api/balance');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coins');
    expect(res.body.success).toBe(true);
  });

  test('GET /profile/security renders for logged-in user', async () => {
    const { agent } = await registerAgent();
    const res = await agent.get('/profile/security');
    expect(res.status).toBe(200);
  });

  test('POST /profile/change-password rejects wrong current password', async () => {
    const { agent } = await registerAgent();
    const page = await agent.get('/profile/security');
    const token = extractCsrfToken(page.text);

    const res = await agent.post('/profile/change-password').type('form').send({
      current_password: 'WrongOldPass1!',
      new_password: 'NewPass123!',
      confirmPassword: 'NewPass123!',
      _csrf: token
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile/security');
  });

  test('POST /profile/change-password succeeds with correct current password and new login works', async () => {
    const { agent, user } = await registerAgent();
    const page = await agent.get('/profile/security');
    const token = extractCsrfToken(page.text);

    const res = await agent.post('/profile/change-password').type('form').send({
      current_password: user.password,
      new_password: 'NewPass456!',
      confirmPassword: 'NewPass456!',
      _csrf: token
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile/security');

    await agent.get('/logout');
    const loginPage = await agent.get('/login');
    const loginToken = extractCsrfToken(loginPage.text);
    const loginRes = await agent.post('/login').type('form').send({
      identifier: user.username,
      password: 'NewPass456!',
      _csrf: loginToken,
      form_rendered_at: formRenderedAt()
    });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).toBe('/');
  });

  test('POST /profile/change-password without CSRF token is rejected', async () => {
    const { agent, user } = await registerAgent();
    const res = await agent.post('/profile/change-password').type('form').send({
      current_password: user.password,
      new_password: 'AnotherPass123!',
      confirmPassword: 'AnotherPass123!'
    });
    expect(res.status).toBe(403);
  });
});
