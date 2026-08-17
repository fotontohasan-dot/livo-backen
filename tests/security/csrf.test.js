const { app, getCsrfAgent, extractCsrfToken, uniqueUsername, REALISTIC_UA, fakeIp, freshRequest } = require('../helpers/app');

// middleware/csrf.js — Synchronizer Token Pattern।
// এখানে শুধু middleware-এর আচরণ যাচাই করা হচ্ছে; কোনো সুরক্ষা লজিক পরিবর্তন করা হয়নি।
describe('CSRF Protection (middleware/csrf.js)', () => {

  describe('টোকেন প্রকাশ (GET)', () => {
    test('GET /login পেজে csrf-token meta ট্যাগ থাকে এবং টোকেন খালি নয়', async () => {
      const { token } = await getCsrfAgent('/login');
      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(20);
    });

    test('একই সেশনে টোকেন স্থিতিশীল থাকে (প্রতি রিকোয়েস্টে বদলায় না)', async () => {
      const { agent, token } = await getCsrfAgent('/login');
      const second = await agent.get('/register');
      expect(extractCsrfToken(second.text)).toBe(token);
    });

    test('আলাদা সেশনে আলাদা টোকেন হয় (সেশন-বাউন্ড)', async () => {
      const a = await getCsrfAgent('/login');
      const b = await getCsrfAgent('/login');
      expect(a.token).not.toBe(b.token);
    });
  });

  describe('state-changing মেথড যাচাই', () => {
    test('টোকেন ছাড়া POST 403 দেয়', async () => {
      const { agent } = await getCsrfAgent('/login');
      const res = await agent.post('/login')
        .type('form')
        .send({ identifier: 'x@test.com', password: 'whatever' });
      expect(res.status).toBe(403);
    });

    test('ভুল/বানানো টোকেন দিয়ে POST 403 দেয়', async () => {
      const { agent } = await getCsrfAgent('/login');
      const res = await agent.post('/login')
        .type('form')
        .send({ identifier: 'x@test.com', password: 'whatever', _csrf: 'totally-made-up-token' });
      expect(res.status).toBe(403);
    });

    test('অন্য সেশনের বৈধ টোকেন নিজের সেশনে চলে না', async () => {
      const victim = await getCsrfAgent('/login');
      const attacker = await getCsrfAgent('/login');
      const res = await attacker.agent.post('/login')
        .type('form')
        .send({ identifier: 'x@test.com', password: 'whatever', _csrf: victim.token });
      expect(res.status).toBe(403);
    });

    test('সঠিক টোকেন দিলে CSRF স্তরে আটকায় না (403 নয়)', async () => {
      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent.post('/login')
        .type('form')
        .send({ identifier: 'nonexistent_csrf_user@test.com', password: 'wrongpass', _csrf: token });
      // ভুল ক্রেডেনশিয়াল বলে লগইন সফল হবে না, কিন্তু সেটা CSRF ব্লক নয় — redirect হয়
      expect(res.status).not.toBe(403);
    });

    test('X-CSRF-Token হেডার দিয়েও টোকেন পাঠানো যায়', async () => {
      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent.post('/login')
        .set('X-CSRF-Token', token)
        .type('form')
        .send({ identifier: 'nonexistent_csrf_user@test.com', password: 'wrongpass' });
      expect(res.status).not.toBe(403);
    });

    // রিগ্রেশন: query string-এ ?_csrf= পাঠিয়ে টোকেন যাচাই পাস করা আগে সম্ভব ছিল — কিন্তু
    // URL-এ থাকা টোকেন ব্রাউজার হিস্ট্রি/সার্ভার লগ/Referer-এর মাধ্যমে ফাঁস হতে পারে বলে
    // সেই সাপোর্ট সরানো হয়েছে (middleware/csrf.js: extractSubmittedToken)। এখন body/header
    // ছাড়া শুধু query string দিয়ে বৈধ টোকেন পাঠালেও 403 হওয়া উচিত।
    test('শুধু query string-এ বৈধ _csrf টোকেন পাঠালে আর গ্রহণযোগ্য নয় (403)', async () => {
      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent
        .post(`/login?_csrf=${encodeURIComponent(token)}`)
        .type('form')
        .send({ identifier: 'nonexistent_csrf_user@test.com', password: 'wrongpass' });
      expect(res.status).toBe(403);
    });
  });

  describe('এরর রেসপন্সের ধরন', () => {
    test('JSON রিকোয়েস্টে HTML পেজ নয়, JSON এরর ফেরত আসে', async () => {
      const { agent } = await getCsrfAgent('/login');
      const res = await agent.post('/login')
        .set('Accept', 'application/json')
        .send({ identifier: 'x@test.com', password: 'whatever' });
      expect(res.status).toBe(403);
      expect(res.body).toBeTruthy();
      expect(res.body.code).toBe('CSRF_TOKEN_INVALID');
      expect(res.body.success).toBe(false);
    });

    test('ব্রাউজার রিকোয়েস্টে HTML এরর পেজ ফেরত আসে, JSON নয়', async () => {
      const { agent } = await getCsrfAgent('/login');
      const res = await agent.post('/login')
        .set('Accept', 'text/html')
        .type('form')
        .send({ identifier: 'x@test.com', password: 'whatever' });
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toMatch(/html/);
    });

    test('CSRF এরর রেসপন্সে সেশন সিক্রেট ফাঁস হয় না', async () => {
      const { agent, token } = await getCsrfAgent('/login');
      const res = await agent.post('/login')
        .type('form')
        .send({ identifier: 'x@test.com', password: 'whatever', _csrf: 'wrong' });
      expect(res.status).toBe(403);
      expect(res.text || '').not.toContain(token);
    });
  });

  describe('নিরাপদ মেথড ও এক্সেম্পট পাথ', () => {
    test('GET রিকোয়েস্ট কখনো CSRF-এ ব্লক হয় না', async () => {
      const res = await freshRequest().get('/login').set('User-Agent', REALISTIC_UA);
      expect(res.status).toBe(200);
    });

    test('/telegram-webhook এক্সেম্পট — CSRF নয়, নিজস্ব secret যাচাইয়ে আটকায়', async () => {
      const res = await freshRequest()
        .post('/telegram-webhook')
        .set('User-Agent', REALISTIC_UA)
        .send({ update_id: 1 });
      expect(res.status).not.toBe(403);
      expect(res.text || '').not.toContain('CSRF');
    });

    test('/api/* এক্সেম্পট — CSRF এরর কোড দেয় না', async () => {
      const res = await freshRequest()
        .post('/api/v1/nonexistent-endpoint')
        .set('User-Agent', REALISTIC_UA)
        .send({});
      expect(res.body && res.body.code).not.toBe('CSRF_TOKEN_INVALID');
    });
  });

  describe('সুরক্ষিত রুটে প্রয়োগ', () => {
    test('/register টোকেন ছাড়া POST 403 দেয়', async () => {
      const res = await freshRequest()
        .post('/register')
        .set('User-Agent', REALISTIC_UA)
        .set('X-Forwarded-For', fakeIp())
        .type('form')
        .send({ username: uniqueUsername(), password: 'SecurePass123' });
      expect(res.status).toBe(403);
    });

    test('/admin/login টোকেন ছাড়া POST 403 দেয়', async () => {
      const res = await freshRequest()
        .post('/admin/login')
        .set('User-Agent', REALISTIC_UA)
        .set('X-Forwarded-For', fakeIp())
        .type('form')
        .send({ username: 'admin', password: 'whatever' });
      expect(res.status).toBe(403);
    });
  });
});
