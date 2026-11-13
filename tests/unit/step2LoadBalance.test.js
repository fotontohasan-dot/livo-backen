// Step 2 (load-balance) — DB/Redis ছাড়া চলে। বাস্তব Redis রিস্টার্ট/২-ইনস্ট্যান্স যাচাই staging-এ আলাদাভাবে।
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('2.1 WebSocket-only Socket.IO', () => {
  test('সার্ভার transports: [websocket]', () => {
    expect(read('services/socket.js')).toMatch(/new Server\(server, \{[\s\S]{0,600}transports: \['websocket'\]/);
  });
  test('ক্লায়েন্ট helper একই transports ব্যবহার করে', () => {
    expect(read('public/js/socket-client.js')).toMatch(/transports: \['websocket'\]/);
  });
  test('কোনো ক্লায়েন্ট ফাইল সরাসরি io() ডাকে না — সব helper দিয়ে', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, f.name);
        if (f.isDirectory()) { if (!/vendor|lib/.test(f.name)) walk(rel); continue; }
        if (!f.name.endsWith('.js') || f.name === 'socket-client.js' || f.name.endsWith('.min.js')) continue;
        const code = read(rel).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        if (/(^|[^\w.])(window\.)?io\(\s*[^)]*\)/.test(code.replace(/typeof\s+(window\.)?io\b/g, ''))) offenders.push(rel);
      }
    };
    walk('public/js');
    expect(offenders).toEqual([]);
  });
  test('যে ভিউ socket.io.js লোড করে সেখানে helper-ও লোড হয়', () => {
    for (const v of ['views/partials/head.ejs', 'views/admin/dashboard.ejs', 'views/admin/chat.ejs', 'views/profile/chat.ejs', 'views/matches.ejs']) {
      expect(read(v)).toMatch(/socket\.io\.js"><\/script>\s*<script src="\/js\/socket-client\.js">/);
    }
  });
});

describe('2.2 Worker → socket (redis-emitter)', () => {
  const src = read('services/socket.js');
  test('emitter একই REDIS_URL ব্যবহার করে (অ্যাডাপ্টারের মতো), CACHE_REDIS_URL নয়', () => {
    const block = src.slice(src.indexOf('function getEmitter'), src.indexOf('const emitBus'));
    expect(block).toMatch(/process\.env\.REDIS_URL/);
    expect(block).not.toMatch(/CACHE_REDIS_URL/);
    expect(block).toMatch(/redis-emitter/);
  });
  test('emit ফাংশনগুলো io-এর বদলে emitBus() (io || emitter) ব্যবহার করে', () => {
    expect(src).toMatch(/const emitBus = \(\) => io \|\| getEmitter\(\)/);
    expect(read('services/notify.js')).toMatch(/require\('\.\/socket'\)\.getEmitter\(\)/);
  });
  test('Redis ডাউনে publish ব্যর্থতা unhandledRejection হয় না (র‍্যাপার .catch)', () => {
    expect(src).toMatch(/client\.publish\(channel, msg\)\.catch/);
  });
});

describe('2.3 cache.js', () => {
  test('give-up-after-N আচরণ নেই, রিট্রাই অনির্দিষ্ট', () => {
    const src = read('services/cache.js');
    expect(src).not.toMatch(/REDIS_MAX_RETRIES|boundedRetryStrategy|giving up after/);
    expect(src).toMatch(/infiniteRetryStrategy/);
  });
  test('computeBackoffMs: দ্বিগুণ হয়, ৩০ সেকেন্ডে ক্যাপ, jitter সীমার ভেতর', () => {
    const { computeBackoffMs } = require('../../services/cache');
    const noJitter = () => 0.5;
    expect(computeBackoffMs(1, 500, 30000, noJitter)).toBe(500);
    expect(computeBackoffMs(2, 500, 30000, noJitter)).toBe(1000);
    expect(computeBackoffMs(3, 500, 30000, noJitter)).toBe(2000);
    expect(computeBackoffMs(50, 500, 30000, noJitter)).toBe(30000);
    for (let a = 1; a < 80; a++) {
      const d = computeBackoffMs(a, 500, 30000);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(30000);
    }
  });
  test('Redis ডাউনে getOrSet: একযোগে ৫০ কল → ১টা DB কোয়েরি (single-flight), তারপর লোকাল ক্যাশ', async () => {
    jest.resetModules();
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // কনফিগার্ড কিন্তু ডাউন (কেউ শুনছে না)
    process.env.REDIS_RETRY_BASE_MS = '5000';
    const cache = require('../../services/cache');
    let calls = 0;
    const fetchFn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { n: calls }; };
    const results = await Promise.all(Array.from({ length: 50 }, () => cache.getOrSet('k', 60, fetchFn)));
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.n)).size).toBe(1);
    await cache.getOrSet('k', 60, fetchFn);
    expect(calls).toBe(1); // ছোট লোকাল ক্যাশ থেকে
    await cache.del('k'); // একই প্রসেসে invalidate করলে লোকাল কপিও বাতিল
    await cache.getOrSet('k', 60, fetchFn);
    expect(calls).toBe(2);
    await cache.close();
  });
  test('Redis বন্ধ/অকনফিগার্ড (REDIS_ENABLED=false) হলে আগের আচরণ: সরাসরি fetch, কোনো স্টেইল কপি নেই', async () => {
    jest.resetModules();
    process.env.REDIS_ENABLED = 'false';
    const cache = require('../../services/cache');
    let calls = 0;
    const fetchFn = async () => ++calls;
    await cache.getOrSet('z', 60, fetchFn); await cache.getOrSet('z', 60, fetchFn);
    expect(calls).toBe(2);
  });
  test('Redis ডাউনে ভিন্ন key-এ DB কনকারেন্সি সীমিত', async () => {
    jest.resetModules();
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.REDIS_RETRY_BASE_MS = '5000';
    process.env.CACHE_FALLTHROUGH_CONCURRENCY = '3';
    const cache = require('../../services/cache');
    let active = 0; let maxActive = 0;
    const fetchFn = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 15)); active--; return 1; };
    await Promise.all(Array.from({ length: 30 }, (_, i) => cache.getOrSet('key' + i, 60, fetchFn)));
    expect(maxActive).toBeLessThanOrEqual(3);
    delete process.env.CACHE_FALLTHROUGH_CONCURRENCY; delete process.env.REDIS_URL; delete process.env.REDIS_RETRY_BASE_MS;
    process.env.REDIS_ENABLED = 'false';
    await cache.close();
  });
});

describe('2.4 রেট-লিমিট নীতি', () => {
  const { userOrIpKey } = require('../../middleware/rateLimitPolicy');
  function buildApp(max) {
    const app = express();
    app.set('trust proxy', 1);
    app.use((req, res, next) => { // সেশন মক: x-test-user হেডার থাকলে লগইন-করা ইউজার
      req.session = req.get('x-test-user') ? { user: { id: Number(req.get('x-test-user')) } } : {};
      next();
    });
    app.use(rateLimit({ windowMs: 60000, limit: max, keyGenerator: userOrIpKey, standardHeaders: true, legacyHeaders: false }));
    app.get('/x', (req, res) => res.send('ok'));
    return app;
  }
  test('একই IP-র দুই ইউজার একে অপরকে ব্লক করে না', async () => {
    const app = buildApp(2);
    const hit = (u) => request(app).get('/x').set('X-Forwarded-For', '203.0.113.7').set('x-test-user', String(u));
    expect((await hit(1)).status).toBe(200);
    expect((await hit(1)).status).toBe(200);
    expect((await hit(1)).status).toBe(429); // ইউজার ১ শেষ
    expect((await hit(2)).status).toBe(200); // ইউজার ২ একই IP থেকেও চলে
  });
  test('অ্যানোনিমাস রিকোয়েস্ট IP দিয়ে গোনা হয়', async () => {
    const app = buildApp(2);
    const hit = (ip) => request(app).get('/x').set('X-Forwarded-For', ip);
    await hit('198.51.100.1'); await hit('198.51.100.1');
    expect((await hit('198.51.100.1')).status).toBe(429);
    expect((await hit('198.51.100.2')).status).toBe(200);
  });
  test('429-এ Retry-After হেডার আসে', async () => {
    const app = buildApp(1);
    await request(app).get('/x').set('X-Forwarded-For', '192.0.2.9');
    const res = await request(app).get('/x').set('X-Forwarded-For', '192.0.2.9');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
  test('login/OTP/financial/payment সীমা আগের মতোই (ঢিলা হয়নি)', () => {
    const app = read('app.js'); const auth = read('routes/auth.js'); const pay = read('routes/payment.js');
    expect(app).toMatch(/const loginLimiter = rateLimit\(\{\s*windowMs: 15 \* 60 \* 1000,\s*keyGenerator: loginAccountIpKey,\s*max: 10,/); // Step 4B A2: কী এখন অ্যাকাউন্ট+IP (আগে শুধু অ্যাকাউন্ট); সংখ্যা ও উইন্ডো অপরিবর্তিত
    expect(app).toMatch(/const financialLimiter = rateLimit\(\{\s*windowMs: 15 \* 60 \* 1000,\s*max: 20,/);
    expect(pay).toMatch(/const paymentLimiter = rateLimit\(\{\s*windowMs: 15 \* 60 \* 1000,\s*max: 15,/);
    expect(auth).toMatch(/const resetLimiter = rateLimit\(\{\s*windowMs: 15 \* 60 \* 1000,\s*max: 5,/);
  });
});

describe('2.5 API লগিং রিকোয়েস্ট পাথের বাইরে', () => {
  test('apiLogger-এ সরাসরি DB/INSERT নেই', () => {
    const src = read('middleware/apiLogger.js');
    expect(src).not.toMatch(/require\('\.\.\/db'\)|pool\.query|INSERT INTO/);
    expect(src).toMatch(/enqueueApiLog/);
  });
  test('প্রসেসর api_usage_logs-এ লেখে (worker পাথে)', () => {
    expect(read('queues/processors/apiLog.js')).toMatch(/INSERT INTO api_usage_logs/);
  });
  test('bounded: সীমা ছাড়ালে লগ ফেলে দেয় ও গোনে, রিকোয়েস্ট আটকায় না', async () => {
    jest.resetModules();
    process.env.API_LOG_MAX_PENDING = '2';
    const calls = [];
    jest.doMock('../../queues/producers', () => ({ enqueueApiLog: (p) => { calls.push(p); return new Promise(() => {}); } }));
    const { apiUsageLogger, getApiLogStats } = require('../../middleware/apiLogger');
    const fire = () => new Promise((resolve) => {
      const res = { statusCode: 200, end() { return this; } };
      const req = { method: 'GET', originalUrl: '/api/x?token=secret', headers: {}, ip: '1.2.3.4' };
      apiUsageLogger(req, res, () => { res.end(); resolve(); });
    });
    for (let i = 0; i < 5; i++) await fire();
    await new Promise((r) => setImmediate(r));
    const st = getApiLogStats();
    expect(st.pending).toBe(2);
    expect(st.dropped).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].endpoint).toBe('/api/x'); // কোয়েরি-স্ট্রিং (টোকেন) লগে যায় না
    delete process.env.API_LOG_MAX_PENDING;
    jest.dontMock('../../queues/producers');
  });
});

describe('2.6 হালকা /ready', () => {
  const src = read('services/healthCheck.js');
  const ready = src.slice(src.indexOf('async function readiness'), src.indexOf('module.exports'));
  test('readiness-এ SELECT 1 + Redis PING, টেবিল স্ক্যান নেই', () => {
    expect(ready).toMatch(/SELECT 1/);
    expect(ready).toMatch(/\.ping\(\)/);
    expect(ready).not.toMatch(/COUNT\(\*\)/i);
    expect(ready).toMatch(/READY_TIMEOUT_MS/);
  });
  test('/health তুচ্ছ থাকে (DB/Redis ছোঁয় না)', () => {
    const live = src.slice(src.indexOf('async function liveness'), src.indexOf('async function readiness'));
    expect(live).not.toMatch(/pool|redis|query/i);
  });
  test('postgres ডায়াগনস্টিক চেকেও COUNT(*) FROM users নেই', () => {
    expect(src).not.toMatch(/SELECT COUNT\(\*\) FROM users/);
  });
});
