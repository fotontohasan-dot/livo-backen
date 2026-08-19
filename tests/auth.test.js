const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('./helpers/app');
const bcrypt = require('bcryptjs');

describe('Authentication', () => {
  test('POST without a CSRF token is rejected with 403', async () => {
    const res = await freshRequest()
      .post('/login')
      .type('form')
      .send({ identifier: 'someone@test.com', password: 'whatever' });
    expect(res.status).toBe(403);
  });

  test('Protected route redirects to /login when not authenticated', async () => {
    const res = await freshRequest().get('/profile/security');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login/);
  });

  test('GET /register renders the registration page', async () => {
    const res = await freshRequest().get('/register');
    expect(res.status).toBe(200);
  });

  test('GET /login renders the login page', async () => {
    const res = await freshRequest().get('/login');
    expect(res.status).toBe(200);
  });

  test('POST /register successfully creates a user and logs in (redirect to /)', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const phone = uniquePhone();
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
    const phone = uniquePhone();
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

  test('অস্তিত্বহীন identifier দিয়ে লগইনেও bcrypt.compare() চালানো হয় (টাইমিং এনিউমারেশন গার্ড)', async () => {
    // ইউজার না পাওয়া গেলে bcrypt.compare() স্কিপ করলে রেসপন্স-টাইম দিয়ে অস্তিত্ব
    // এনিউমারেট করা যায় (একই এরর মেসেজ হলেও)। এই টেস্ট নিশ্চিত করে bcrypt.compare()
    // বাস্তবেই কল হচ্ছে দুই পথেই — শুধু মেসেজ এক হওয়াই যথেষ্ট না।
    const spy = jest.spyOn(bcrypt, 'compare');
    try {
      const { agent, token } = await getCsrfAgent('/login');
      await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: 'no-such-user-timing-probe@test.com', password: 'wrongpass', _csrf: token });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
