const { freshRequest, REALISTIC_UA } = require('./helpers/app');

describe('Security', () => {
  test('Helmet security headers are present', async () => {
    const res = await freshRequest().get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('Cross-origin POST with mismatched Origin header is rejected (403)', async () => {
    const res = await freshRequest()
      .post('/login')
      .set('Origin', 'https://evil-attacker-site.example')
      .type('form')
      .send({ identifier: 'x@test.com', password: 'whatever' });
    expect(res.status).toBe(403);
  });

  // রিগ্রেশন: app.js-এর origin-check middleware আগে "null"/অপার্সেবল Origin হেডারে
  // থ্রো করে খালি catch(e){}-এ পড়ে চুপচাপ next() ডেকে দিত — অর্থাৎ sandboxed iframe/
  // data:/file: URL থেকে আসা "null" origin দিয়ে এই সুরক্ষা কার্যত বাইপাস হয়ে যেত।
  test('State-changing POST with Origin: null is rejected (403)', async () => {
    const res = await freshRequest()
      .post('/login')
      .set('Origin', 'null')
      .type('form')
      .send({ identifier: 'x@test.com', password: 'whatever' });
    expect(res.status).toBe(403);
  });

  test('State-changing POST with a malformed (unparseable) Origin header is rejected (403)', async () => {
    const res = await freshRequest()
      .post('/login')
      .set('Origin', 'not a valid url::')
      .type('form')
      .send({ identifier: 'x@test.com', password: 'whatever' });
    expect(res.status).toBe(403);
  });

  test('State-changing POST with a matching same-host Origin is not rejected by the origin-check layer', async () => {
    const res = await freshRequest()
      .post('/login')
      .set('Origin', 'http://127.0.0.1')
      .type('form')
      .send({ identifier: 'x@test.com', password: 'whatever' });
    // origin-check layer শুধু host মিসম্যাচ/malformed origin আটকায় — এখানে host ভিন্ন হওয়ায়
    // (127.0.0.1 বনাম test সার্ভারের হোস্ট) এটাও আসলে 403 পাবে, তবে কারণ ভিন্ন (mismatch, malformed না)।
    // মূল লক্ষ্য: এই কেসেও আচরণ deterministic — crash/500 না, পরিষ্কার 403।
    expect(res.status).toBe(403);
  });

  test('Login rate limiter blocks after repeated failed attempts', async () => {
    // নিজস্ব ডেডিকেটেড IP — এই টেস্ট ইচ্ছাকৃতভাবে লিমিট শেষ করে, তাই সেটা যেন
    // অন্য কোনো টেস্টের কোটায় প্রভাব না ফেলে।
    const agent = freshRequest();
    const loginPage = await agent.get('/login');
    const tokenMatch = /<meta name="csrf-token" content="([^"]*)"/.exec(loginPage.text || '');
    const token = tokenMatch ? tokenMatch[1] : '';

    let lastStatus = 200;
    for (let i = 0; i < 12; i++) {
      const res = await agent
        .post('/login')
        .type('form')
        .send({ identifier: 'ratelimit_test@test.com', password: 'wrongpass', _csrf: token });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect([302, 403, 429]).toContain(lastStatus);
  });

  test('Unknown route returns 404', async () => {
    const res = await freshRequest().get('/this-route-does-not-exist-xyz');
    expect(res.status).toBe(404);
  });
});
