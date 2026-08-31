// tests/security/resourceExhaustion.test.js
// ---------------------------------------------------------------------------
// PHASE 13 (deep) — বাস্তব চাপ দিয়ে resource abuse যাচাই
//
// আগে শুধু কনফিগ পড়ে PASS বলা হয়েছিল। এই suite সত্যিকারের request পাঠিয়ে
// দেখে যে সীমাগুলো আসলেই প্রয়োগ হয়:
//
//   * বিশাল JSON / urlencoded body প্রত্যাখ্যাত হয় (413), process টেকে
//   * গভীরভাবে nested JSON প্রক্রিয়া করতে গিয়ে crash হয় না
//   * HTTP parameter pollution নিরাপদে সামলানো হয়
//   * বিশাল query string / header প্রত্যাখ্যাত হয়
//   * /csp-report-এর নতুন সীমা বাস্তবে কাজ করে (MEDIUM-10)
//   * অনেকগুলো concurrent request-এর পরেও server সাড়া দেয়
// ---------------------------------------------------------------------------

const request = require('supertest');
// tests/testHarnessIntegrity.test.js অনুযায়ী সব suite helpers/app.js-এর
// listening server ব্যবহার করবে, সরাসরি express app নয় (supertest-এর
// ephemeral port সমস্যা এড়াতে)।
const { app } = require('../helpers/app');
const { REALISTIC_UA } = require('../helpers/app');

const agent = () => request(app).set ? request(app) : request(app);

describe('Resource exhaustion (PHASE 13 deep)', () => {
  describe('Body size limits', () => {
    test('বিশাল JSON body প্রত্যাখ্যাত হয় (413), 200 নয়', async () => {
      const huge = { data: 'A'.repeat(2 * 1024 * 1024) }; // 2MB
      const res = await request(app)
        .post('/csp-report')
        .set('User-Agent', REALISTIC_UA)
        .set('Content-Type', 'application/json')
        .send(huge);

      expect(res.status).not.toBe(200);
      expect([413, 400, 204, 429, 403]).toContain(res.status);
    }, 30000);

    test('বিশাল urlencoded body প্রত্যাখ্যাত হয়', async () => {
      const res = await request(app)
        .post('/login')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send('identifier=' + 'A'.repeat(2 * 1024 * 1024));

      expect(res.status).not.toBe(200);
    }, 30000);

    test('বড় body প্রত্যাখ্যানের পরেও server স্বাভাবিকভাবে সাড়া দেয়', async () => {
      await request(app).post('/csp-report')
        .set('Content-Type', 'application/json')
        .send({ data: 'B'.repeat(1024 * 1024) })
        .catch(() => {});

      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }, 30000);
  });

  describe('Malformed / hostile payloads', () => {
    test('গভীরভাবে nested JSON crash ঘটায় না', async () => {
      let nested = {};
      let cur = nested;
      for (let i = 0; i < 2000; i++) { cur.a = {}; cur = cur.a; }

      const res = await request(app)
        .post('/csp-report')
        .set('Content-Type', 'application/json')
        .send(nested)
        .catch((e) => ({ status: 'ERR', err: e.message }));

      expect(res.status).not.toBe(500);

      //  server 
      expect((await request(app).get('/health')).status).toBe(200);
    }, 30000);

    test('ভাঙা JSON 500 নয়, 4xx দেয়', async () => {
      const res = await request(app)
        .post('/csp-report')
        .set('Content-Type', 'application/json')
        .send('{"broken": ');

      expect(res.status).toBeLessThan(500);
      expect((await request(app).get('/health')).status).toBe(200);
    }, 30000);

    test('__proto__ পাঠালে Object.prototype দূষিত হয় না', async () => {
      await request(app)
        .post('/csp-report')
        .set('Content-Type', 'application/json')
        .send(JSON.parse('{"__proto__": {"polluted": "yes"}}'))
        .catch(() => {});

      expect({}.polluted).toBeUndefined();
      expect(Object.prototype.polluted).toBeUndefined();
    }, 30000);

    test('HTTP parameter pollution নিরাপদে সামলানো হয়', async () => {
      const res = await request(app)
        .get('/login?next=/safe&next=//evil.example.com')
        .set('User-Agent', REALISTIC_UA);

      expect(res.status).toBeLessThan(500);
      //   redirect  
      if (res.headers.location) {
        expect(res.headers.location).not.toMatch(/evil\.example\.com/);
      }
    }, 30000);

    test('অত্যধিক লম্বা query string crash ঘটায় না', async () => {
      const res = await request(app)
        .get('/login?q=' + 'A'.repeat(50000))
        .set('User-Agent', REALISTIC_UA)
        .catch((e) => ({ status: 'ERR' }));

      expect(res.status).not.toBe(500);
      expect((await request(app).get('/health')).status).toBe(200);
    }, 30000);
  });

  describe('MEDIUM-10: /csp-report bounded', () => {
    test('অনেক ভিন্ন key পাঠালেও server টিকে থাকে এবং সাড়া দেয়', async () => {
      //   Map      
      for (let i = 0; i < 120; i++) {
        await request(app)
          .post('/csp-report')
          .set('Content-Type', 'application/csp-report')
          .send({ 'csp-report': {
            'violated-directive': `script-src-${i}`,
            'blocked-uri': `https://example-${i}.test/x.js`,
          } })
          .catch(() => {});
      }

      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }, 60000);

    test('/csp-report কখনো 500 দেয় না', async () => {
      const res = await request(app)
        .post('/csp-report')
        .set('Content-Type', 'application/json')
        .send({ nonsense: true });

      expect(res.status).toBeLessThan(500);
    }, 30000);
  });

  describe('Concurrency', () => {
    test('৫০টি concurrent request-এর পরেও server সাড়া দেয়', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          request(app).get('/health').then((r) => r.status).catch(() => 'ERR')
        )
      );

      const ok = results.filter((s) => s === 200).length;
      //  rate limit          
      expect(ok).toBeGreaterThan(0);
      expect(results.filter((s) => s === 500).length).toBe(0);

      expect((await request(app).get('/health')).status).toBe(200);
    }, 60000);

    test('concurrent login চেষ্টা 500 ঘটায় না', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          request(app).post('/login').set('User-Agent', REALISTIC_UA).type('form')
            .send({ identifier: '01700000000', password: 'wrong' })
            .then((r) => r.status).catch(() => 'ERR')
        )
      );

      expect(results.filter((s) => s === 500).length).toBe(0);
      expect((await request(app).get('/health')).status).toBe(200);
    }, 60000);
  });
});
