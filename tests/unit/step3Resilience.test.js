// Step 3 — circuit breaker, integration status (secret-free), A1 api-log cap, A2 per-account keys.
// DB-অংশ লোকাল Postgres লাগে (globalSetup-এ migrations চলে)।
const fs = require('fs');
const path = require('path');
const http = require('http');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const {
  CircuitBreaker, STATE, CircuitOpenError, CircuitTimeoutError, getBreaker, _resetForTests
} = require('../../services/circuitBreaker');

const fail = () => Promise.reject(new Error('boom'));
const ok = () => Promise.resolve('ok');

describe('3.2 circuit breaker', () => {
  let t;
  const mk = (opts) => new CircuitBreaker('t', { FAILURE_THRESHOLD: 3, RESET_TIMEOUT_MS: 1000, ...opts }, { now: () => t, env: {} });
  beforeEach(() => { t = 1_000_000; });

  test('CLOSED → OPEN ধারাবাহিক ব্যর্থতায়, OPEN-এ কল যায় না', async () => {
    const b = mk(); const fn = jest.fn(fail);
    for (let i = 0; i < 3; i++) await expect(b.fire(fn)).rejects.toThrow('boom');
    expect(b.getState()).toBe(STATE.OPEN);
    await expect(b.fire(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('OPEN → HALF_OPEN (reset সময়ের পর) → সফল probe-এ CLOSED', async () => {
    const b = mk();
    for (let i = 0; i < 3; i++) await b.fire(fail).catch(() => {});
    t += 1001;
    expect(b.getState()).toBe(STATE.HALF_OPEN);
    await expect(b.fire(ok)).resolves.toBe('ok');
    expect(b.getState()).toBe(STATE.CLOSED);
  });

  test('HALF_OPEN probe ব্যর্থ হলে আবার OPEN; একই সময়ে একটাই probe', async () => {
    const b = mk();
    for (let i = 0; i < 3; i++) await b.fire(fail).catch(() => {});
    t += 1001;
    let release; const slow = () => new Promise((r) => { release = r; });
    const p1 = b.fire(slow);
    await expect(b.fire(ok)).rejects.toBeInstanceOf(CircuitOpenError); // দ্বিতীয় probe নয়
    release(); await p1;
    expect(b.getState()).toBe(STATE.CLOSED);
    for (let i = 0; i < 3; i++) await b.fire(fail).catch(() => {});
    t += 1001;
    await b.fire(fail).catch(() => {});
    expect(b.getState()).toBe(STATE.OPEN);
  });

  test('error-rate ট্রিগার (মিশ্র ফলাফল)', async () => {
    const b = mk({ FAILURE_THRESHOLD: 100, MIN_REQUESTS: 10, ERROR_RATE: 0.5 });
    for (let i = 0; i < 5; i++) { await b.fire(ok); await b.fire(fail).catch(() => {}); }
    expect(b.getState()).toBe(STATE.OPEN);
  });

  test('isFailure (HTTP 5xx) ব্যর্থতা হিসেবে গোনা হয়, রেসপন্স ফেরত যায়', async () => {
    const b = mk();
    for (let i = 0; i < 3; i++) await expect(b.fire(() => ({ status: 503 }), { isFailure: (r) => r.status >= 500 })).resolves.toEqual({ status: 503 });
    expect(b.getState()).toBe(STATE.OPEN);
  });

  test('env কনফিগ: BREAKER_<NAME>_X প্রথমে, তারপর BREAKER_X, তারপর ডিফল্ট ৫s', () => {
    const def = new CircuitBreaker('sms', {}, { env: {} });
    expect(def.cfg.TIMEOUT_MS).toBe(5000);
    const g = new CircuitBreaker('sms', {}, { env: { BREAKER_TIMEOUT_MS: '2000' } });
    expect(g.cfg.TIMEOUT_MS).toBe(2000);
    const s = new CircuitBreaker('sms', {}, { env: { BREAKER_TIMEOUT_MS: '2000', BREAKER_SMS_TIMEOUT_MS: '700' } });
    expect(s.cfg.TIMEOUT_MS).toBe(700);
  });

  test('ধীর প্রোভাইডার কনফিগার করা timeout-এর মধ্যেই ফেরে (সময় মাপা)', async () => {
    const b = new CircuitBreaker('slow', { TIMEOUT_MS: 300 }, { env: {} });
    let aborted = false;
    const start = Date.now();
    await expect(b.fire((signal) => new Promise((res) => { signal.addEventListener('abort', () => { aborted = true; }); setTimeout(res, 5000).unref(); }))).rejects.toBeInstanceOf(CircuitTimeoutError);
    const took = Date.now() - start;
    console.log(`[timing] slow provider (5000ms) returned after ${took}ms with timeout 300ms`);
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(700);
    expect(aborted).toBe(true);
  });

  test('অবস্থা-পরিবর্তন লগ হয়', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const b = mk();
    for (let i = 0; i < 3; i++) await b.fire(fail).catch(() => {});
    expect(spy.mock.calls.some((c) => /\[circuit:t\] closed -> open/.test(String(c[0])))).toBe(true);
    spy.mockRestore();
  });
});

describe('3.2 integrationFetch + সার্ভিস আচরণ (আসল লোকাল HTTP সার্ভার)', () => {
  let server, port, mode = 'slow';
  beforeAll((done) => {
    server = http.createServer((req, res) => {
      if (mode === 'slow') return; // কখনো উত্তর দেয় না
      res.statusCode = mode === '500' ? 500 : 200; res.end('{}');
    }).listen(0, () => { port = server.address().port; done(); });
  });
  afterAll((done) => { server.closeAllConnections && server.closeAllConnections(); server.close(done); });
  beforeEach(() => { _resetForTests(); });

  test('integrationFetch: ধীর সার্ভারে timeout-এ ফেরে, ৫ ব্যর্থতার পর fail-fast', async () => {
    const { integrationFetch } = require('../../utils/integrationHttp');
    process.env.BREAKER_SMS_TIMEOUT_MS = '250';
    process.env.BREAKER_SMS_FAILURE_THRESHOLD = '2';
    _resetForTests();
    const t0 = Date.now();
    await expect(integrationFetch('sms', `http://127.0.0.1:${port}/`)).rejects.toBeDefined();
    await expect(integrationFetch('sms', `http://127.0.0.1:${port}/`)).rejects.toBeDefined();
    const slowTook = Date.now() - t0;
    const t1 = Date.now();
    await expect(integrationFetch('sms', `http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(CircuitOpenError);
    const fastFail = Date.now() - t1;
    console.log(`[timing] 2 timeouts total ${slowTook}ms (timeout 250ms each); open-circuit fail-fast ${fastFail}ms`);
    expect(slowTook).toBeLessThan(900);
    expect(fastFail).toBeLessThan(50);
    delete process.env.BREAKER_SMS_TIMEOUT_MS; delete process.env.BREAKER_SMS_FAILURE_THRESHOLD;
  });

  test('sendSms: circuit খোলা হলে SMS_CIRCUIT_OPEN, রিট্রাই নেই', async () => {
    process.env.SMS_API_URL = `http://127.0.0.1:${port}/`; process.env.SMS_API_KEY = 'k-test-secret-123456';
    process.env.BREAKER_SMS_TIMEOUT_MS = '200'; process.env.BREAKER_SMS_FAILURE_THRESHOLD = '1';
    _resetForTests();
    const { sendSms } = require('../../services/sms');
    const r1 = await sendSms('01700000000', 'x');
    expect(r1.ok).toBe(false);
    const r2 = await sendSms('01700000000', 'x');
    expect(r2.code).toBe('SMS_CIRCUIT_OPEN');
    for (const k of ['SMS_API_URL', 'SMS_API_KEY', 'BREAKER_SMS_TIMEOUT_MS', 'BREAKER_SMS_FAILURE_THRESHOLD']) delete process.env[k];
  });

  test('পেমেন্ট/ওয়ালেট কল breaker-এ নেই ও রিট্রাই নেই (সোর্স গার্ড)', () => {
    const ssl = read('services/sslcommerz.js');
    expect(ssl).toMatch(/breaker:\s*false/);
    expect(ssl).not.toMatch(/getBreaker|\.fire\(/);
    for (const f of ['services/sslcommerz.js', 'services/gatewayReconcile.js', 'services/paymentVerification.js']) {
      expect(read(f)).not.toMatch(/retry|attempts\s*[:=]\s*[2-9]/i);
    }
  });
});

describe('3.1 status — কোনো সিক্রেট নয়', () => {
  const SECRETS = {
    SMS_API_KEY: 'SMSKEY-super-secret-9f8e7d6c', SMS_API_URL: 'https://sms.example.com/send?token=abcd1234efgh5678',
    EMAIL_PASS: 'EmailPass!Secret#4567', EMAIL_USER: 'mailer@example.com',
    TELEGRAM_BOT_TOKEN: ['123456789', 'FAKE_TEST_TOKEN_NOT_REAL'].join(':'),
    CLOUDINARY_API_SECRET: 'cloud-secret-zzzzzz-123', CLOUDINARY_API_KEY: '987654321012345', CLOUDINARY_CLOUD_NAME: 'mycloud',
    RAPIDAPI_KEY: 'rapid-secret-key-abcdef', CRICKET_API_KEY: 'cric-secret-key-uvwxyz'
  };
  const saved = {};
  beforeAll(() => { for (const [k, v] of Object.entries(SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; } });
  afterAll(() => { for (const k of Object.keys(SECRETS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  const { sanitizeError, recordIntegrationResult, writeHeartbeat, buildStatusReport, MAX_ERR_LEN, _lastWrite } = require('../../services/integrationStatus');
  const { computeEnvFlags } = require('../../services/integrationRegistry');

  test('sanitizeError: মান, URL, টোকেন, Bearer সরায়; দৈর্ঘ্য সীমিত', () => {
    const msg = `fail ${SECRETS.SMS_API_KEY} at ${SECRETS.SMS_API_URL} bot${SECRETS.TELEGRAM_BOT_TOKEN} Authorization: Bearer abc.def.ghi key=${SECRETS.EMAIL_PASS} ` + 'x'.repeat(500);
    const out = sanitizeError(msg);
    for (const v of Object.values(SECRETS)) if (v.length >= 6) expect(out).not.toContain(v);
    expect(out).not.toMatch(/abcd1234efgh5678|Bearer abc/);
    expect(out.length).toBeLessThanOrEqual(MAX_ERR_LEN + 5);
  });

  test('env ফ্ল্যাগ শুধু boolean', () => {
    const flags = computeEnvFlags();
    expect(Object.values(flags).every((v) => typeof v === 'boolean')).toBe(true);
    expect(JSON.stringify(flags)).not.toMatch(/secret|SMSKEY|Pass!/i);
    expect(flags.sms).toBe(true); expect(flags['sports:cricapi']).toBe(true);
  });

  test('DB-তে রেকর্ড → রিপোর্ট JSON ও রেন্ডার করা HTML-এ কোনো সিক্রেট নেই', async () => {
    const { pool } = require('../../db');
    await pool.query("DELETE FROM integration_status WHERE name IN ('sms','email','telegram')");
    _lastWrite.clear(); // throttle রিসেট
    recordIntegrationResult('sms', false, `gateway said bad key ${SECRETS.SMS_API_KEY} url ${SECRETS.SMS_API_URL}`);
    recordIntegrationResult('email', false, `auth failed for ${SECRETS.EMAIL_USER} pass=${SECRETS.EMAIL_PASS}`);
    recordIntegrationResult('telegram', false, `https://api.telegram.org/bot${SECRETS.TELEGRAM_BOT_TOKEN}/sendMessage 401`);
    await new Promise((r) => setTimeout(r, 500));
    await writeHeartbeat('web'); await writeHeartbeat('worker').catch(() => {});
    const report = await buildStatusReport();
    const json = JSON.stringify(report);
    const stored = JSON.stringify((await pool.query('SELECT * FROM integration_status')).rows);
    for (const blob of [json, stored]) {
      for (const [k, v] of Object.entries(SECRETS)) {
        if (['EMAIL_USER', 'CLOUDINARY_CLOUD_NAME'].includes(k)) continue; // ঠিকানা/নাম গোপন সিক্রেট নয়
        expect({ k, leaked: blob.includes(v) }).toEqual({ k, leaked: false });
      }
    }
    const sms = report.integrations.find((i) => i.id === 'sms');
    expect(sms.configured.web).toBe(true);
    expect(sms.lastError).toBeTruthy();

    const html = await ejs.renderFile(path.join(ROOT, 'views/admin/integrations.ejs'), { report, t: (k) => k, layout: false, cspNonce: 'n', jsonScriptSafe: (v) => JSON.stringify(v === undefined ? null : v), csrfToken: 'c', user: { id: 1, username: 'a', role: 'admin' }, currentUser: { id: 1, username: 'a', role: 'admin' }, lang: 'en', locale: 'en', assetVersion: 'x', permissions: [], req: { path: '/admin/integrations' }, flash: {}, success: [], error: [], messages: {} }, { async: false }).catch((e) => { throw e; });
    for (const [k, v] of Object.entries(SECRETS)) {
      if (['EMAIL_USER', 'CLOUDINARY_CLOUD_NAME'].includes(k)) continue;
      expect({ k, leaked: html.includes(v) }).toEqual({ k, leaked: false });
    }
  });

  test('অ্যাডমিন রুট: isAdmin + system_diagnostics_view; ত্রুটি ক্লায়েন্টে যায় না', () => {
    const src = read('routes/adminHealthFix.js');
    expect(src).toMatch(/\/integrations['"][\s\S]{0,120}isAdmin[\s\S]{0,120}system_diagnostics_view/);
    expect(src).toMatch(/integrations_status_failed/);
  });
});

describe('A1 api-log কিউ সীমা', () => {
  const load = (counts, addImpl) => {
    jest.resetModules();
    const queue = { getJobCounts: jest.fn().mockResolvedValue(counts), add: jest.fn(addImpl || (async () => ({ id: '1' }))) };
    jest.doMock('../../queues/definitions', () => ({ QUEUE_NAMES: { API_LOG: 'api-log', EMAIL: 'e', NOTIFICATION: 'n', ACTIVITY_LOG: 'a', FRAUD_SCAN: 'f' }, getQueue: () => queue }));
    jest.doMock('../../queues/connection', () => ({ isQueueEnabled: () => true }));
    return { queue, producers: require('../../queues/producers') };
  };
  afterEach(() => { jest.dontMock('../../queues/definitions'); jest.dontMock('../../queues/connection'); jest.resetModules(); });

  test('retention সীমা (count) জবে বসে', async () => {
    const { queue, producers } = load({ waiting: 0, delayed: 0 });
    await producers.enqueueApiLog({ a: 1 });
    const opts = queue.add.mock.calls[0][2];
    expect(opts.removeOnComplete).toEqual({ count: 100 });
    expect(opts.removeOnFail.count).toBe(200);
  });

  test('Redis-গভীরতা সীমা ছাড়ালে লগ ফেলে দেয় (enqueue হয় না)', async () => {
    const { queue, producers } = load({ waiting: 6000, delayed: 0 });
    await producers.enqueueApiLog({ a: 1 }); // প্রথম কল গভীরতা রিফ্রেশ শুরু করে
    await new Promise((r) => setTimeout(r, 20));
    const r = await producers.enqueueApiLog({ a: 2 });
    expect(r).toMatchObject({ queued: false, dropped: 'queue_depth' });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(producers.getApiLogQueueStats().droppedDepth).toBeGreaterThan(0);
  });

  test('Redis ব্যর্থ হলে DB INSERT fallback নয়; ফেলে দেয়', async () => {
    const { producers } = load({ waiting: 0, delayed: 0 }, async () => { throw new Error('redis down'); });
    const r = await producers.enqueueApiLog({ a: 1 });
    expect(r).toMatchObject({ queued: false, dropped: 'redis_error' });
  });
});

describe('A2 প্রতি-অ্যাকাউন্ট কী + IP ছাদ', () => {
  const { loginAccountKey, resetAccountKey, IP_CEILINGS } = require('../../middleware/rateLimitPolicy');
  const rq = (body, ip = '10.0.0.1', params) => ({ body, ip, params });

  test('একই IP, ভিন্ন অ্যাকাউন্ট → ভিন্ন কী; একই অ্যাকাউন্ট (কেস/স্পেস নির্বিশেষে) → একই কী', () => {
    expect(loginAccountKey(rq({ identifier: '01711111111' }))).not.toBe(loginAccountKey(rq({ identifier: '01722222222' })));
    expect(loginAccountKey(rq({ identifier: ' A@B.com ' }, '1.1.1.1'))).toBe(loginAccountKey(rq({ identifier: 'a@b.com' }, '2.2.2.2')));
  });
  test('identifier না থাকলে IP-কী (কড়া সীমা বহাল); কী-তে প্লেইন ফোন/ইমেইল নেই', () => {
    expect(loginAccountKey(rq({}))).toMatch(/^ip:/);
    expect(loginAccountKey(rq({ identifier: '01711111111' }))).not.toContain('01711111111');
    expect(resetAccountKey(rq({ email: 'x@y.com' }))).not.toContain('x@y.com');
  });
  test('একক অ্যাকাউন্টের সীমা ঢিলা হয়নি; IP ছাদ আলাদা', () => {
    const app = read('app.js'); const auth = read('routes/auth.js');
    expect(app).toMatch(/const loginLimiter = rateLimit\(\{[\s\S]*?max: 10,/);
    expect(app).toMatch(/const registerLimiter = rateLimit\(\{[\s\S]*?max: 10,/);
    expect(auth).toMatch(/const resetLimiter = rateLimit\(\{[\s\S]*?max: 5,/);
    expect(IP_CEILINGS).toEqual({ login: 100, reset: 50 });
  });
});
