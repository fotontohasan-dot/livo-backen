// tests/integration/auth.test.js
const { BASE_URL: app } = require('../helpers/testServerConfig');
const { waitForApp } = require('../helpers/waitForApp');
const { buildTestUser, extractCsrfToken } = require('../helpers/testUser');
const { humanAgent, formRenderedAt } = require('../helpers/humanAgent');

describe('Authentication (register / login / logout)', () => {
  let agent;
  let csrfToken;

  beforeAll(async () => {
    await waitForApp(app);
  }, 60000);

  beforeEach(async () => {
    // প্রতিটা টেস্টের জন্য নতুন agent — নিজস্ব কুকি-জার + নিজস্ব ফেক IP
    // (rate limiter/bot-detection যাতে টেস্টগুলোকে একে অপরের সাথে না মেশায়)
    agent = humanAgent(app);
    const registerPage = await agent.get('/register');
    csrfToken = extractCsrfToken(registerPage.text);
  });

  test('GET /register renders the registration page (200) and issues a CSRF token', async () => {
    const res = await agent.get('/register');
    expect(res.status).toBe(200);
    expect(extractCsrfToken(res.text)).toBeTruthy();
  });

  test('POST /register with a valid, unique user succeeds and starts a session', async () => {
    const user = buildTestUser();
    const res = await agent
      .post('/register')
      .type('form')
      .send({ ...user, _csrf: csrfToken, form_rendered_at: formRenderedAt() });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    // সেশন তৈরি হয়েছে কিনা — একটা isAuth-প্রোটেক্টেড পেজে (payment/deposit) এখন
    // অ্যাক্সেস পাওয়া উচিত (redirect করবে না /login-এ)
    const protectedRes = await agent.get('/payment/deposit');
    expect(protectedRes.status).toBe(200);
  });

  test('POST /register rejects a password shorter than 8 characters', async () => {
    const user = buildTestUser({ password: 'short', confirmPassword: 'short' });
    const res = await agent
      .post('/register')
      .type('form')
      .send({ ...user, _csrf: csrfToken, form_rendered_at: formRenderedAt() });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/register');
  });

  test('POST /register rejects a duplicate username', async () => {
    const user = buildTestUser();

    const first = await agent
      .post('/register')
      .type('form')
      .send({ ...user, _csrf: csrfToken, form_rendered_at: formRenderedAt() });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/');

    // দ্বিতীয়বার একই username দিয়ে — নতুন agent/সেশন/IP দিয়ে (আগেরটা লগইন হয়ে গেছে)
    const secondAgent = humanAgent(app);
    const page = await secondAgent.get('/register');
    const token2 = extractCsrfToken(page.text);
    const dup = await secondAgent
      .post('/register')
      .type('form')
      .send({ ...buildTestUser({ username: user.username }), _csrf: token2, form_rendered_at: formRenderedAt() });

    expect(dup.status).toBe(302);
    expect(dup.headers.location).toBe('/register');
  });

  test('POST /register without a CSRF token is rejected', async () => {
    const user = buildTestUser();
    const res = await agent.post('/register').type('form').send({ ...user, form_rendered_at: formRenderedAt() }); // কোনো _csrf ফিল্ড নেই
    expect(res.status).toBe(403);
  });

  test('POST /login with correct credentials logs the user in', async () => {
    const user = buildTestUser();
    await agent.post('/register').type('form').send({ ...user, _csrf: csrfToken, form_rendered_at: formRenderedAt() });
    await agent.get('/logout');

    const loginPage = await agent.get('/login');
    const loginToken = extractCsrfToken(loginPage.text);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ identifier: user.username, password: user.password, _csrf: loginToken, form_rendered_at: formRenderedAt() });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('POST /login with a wrong password is rejected', async () => {
    const user = buildTestUser();
    await agent.post('/register').type('form').send({ ...user, _csrf: csrfToken, form_rendered_at: formRenderedAt() });
    await agent.get('/logout');

    const loginPage = await agent.get('/login');
    const loginToken = extractCsrfToken(loginPage.text);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ identifier: user.username, password: 'WrongPassword123!', _csrf: loginToken, form_rendered_at: formRenderedAt() });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('POST /login is not vulnerable to a basic SQL-injection style identifier', async () => {
    const loginPage = await agent.get('/login');
    const loginToken = extractCsrfToken(loginPage.text);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ identifier: "' OR '1'='1' -- ", password: "' OR '1'='1", _csrf: loginToken, form_rendered_at: formRenderedAt() });

    // Parameterized query ব্যবহার হয়, তাই login ব্যর্থ হয়ে /login-এ redirect করা উচিত,
    // কোনো ইউজার হিসেবে সফল লগইন (রুট / বা /admin-এ redirect) হওয়া উচিত না।
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /logout clears the session', async () => {
    const user = buildTestUser();
    await agent.post('/register').type('form').send({ ...user, _csrf: csrfToken, form_rendered_at: formRenderedAt() });

    await agent.get('/logout');

    const adminRes = await agent.get('/admin');
    expect(adminRes.status).toBe(302);
    expect(adminRes.headers.location).toBe('/admin/login');
  });
});
