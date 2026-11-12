// tests/security/metricsNoSecrets.test.js
// ---------------------------------------------------------------------------
// Step 4E / Task 2 — /metrics:
//   (১) লগইন বা টোকেন ছাড়া খোলে না (ভুল টোকেনেও না)
//   (২) অনুমোদিত অনুরোধেও রেসপন্সে কোনো সিক্রেট নেই (env-এর আসল মান ও কানেকশন-স্ট্রিং প্যাটার্ন)
//   (৩) প্রয়োজনীয় অপারেশনাল মেট্রিক আছে (event loop lag, memory, DB pool, 5xx গণনার counter)
//
// সিক্রেট হিসেবে এই টেস্টে শুধু স্পষ্ট নকল মান বসানো হয়; আসল কোনো মান কোডে নেই।
// ---------------------------------------------------------------------------

const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');

const PASSWORD = 'SecurePass123';
const FAKE_TOKEN = 'fake-metrics-token-for-test-only';
const FAKE_ENV = {
  FEED_API_KEY: 'fake-feed-key-for-test-only',
  WALLET_CALLBACK_BKASH_SECRET: 'fake-bkash-callback-secret-test',
  WALLET_CALLBACK_UPAY_SECRET: 'fake-upay-callback-secret-test'
};

async function makeAdminAgent() {
  const username = uniqueUsername('mns');
  const phone = uniquePhone();
  const hash = await bcrypt.hash(PASSWORD, 10);
  const r = await pool.query(`INSERT INTO users (username, phone, password, role) VALUES ($1,$2,$3,'user') RETURNING id`, [username, phone, hash]);
  const { agent, token } = await getCsrfAgent('/login');
  await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ identifier: phone, password: PASSWORD, _csrf: token });
  // বিদ্যমান metricsAuthBanCheck-এর মতোই: সাধারণ লগইনের পর role উন্নীত (metricsAuth প্রতি অনুরোধে DB থেকে role দেখে)
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [r.rows[0].id]);
  return agent;
}

describe('Step 4E: /metrics — অ্যাক্সেস ও সিক্রেট', () => {
  const saved = {};
  beforeAll(() => {
    for (const k of ['METRICS_TOKEN', ...Object.keys(FAKE_ENV)]) saved[k] = process.env[k];
    process.env.METRICS_TOKEN = FAKE_TOKEN;
    Object.assign(process.env, FAKE_ENV);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('লগইন/টোকেন ছাড়া 401, কোনো মেট্রিক নেই', async () => {
    const res = await freshRequest().get('/metrics');
    expect(res.status).toBe(401);
    expect(res.text).not.toMatch(/bet420_|process_cpu|nodejs_/);
  });

  test('ভুল টোকেন (header ও query) 401', async () => {
    const h = await freshRequest().get('/metrics').set('x-metrics-token', 'wrong-token');
    expect(h.status).toBe(401);
    const q = await freshRequest().get('/metrics').query({ token: 'wrong-token' });
    expect(q.status).toBe(401);
  });

  test('অ্যাডমিন সেশন ও সঠিক টোকেন — 200, রেসপন্সে কোনো সিক্রেট নেই', async () => {
    const admin = await makeAdminAgent();
    const viaSession = await admin.get('/metrics');
    const viaToken = await freshRequest().get('/metrics').set('x-metrics-token', FAKE_TOKEN);
    expect(viaSession.status).toBe(200);
    expect(viaToken.status).toBe(200);

    const dbUrl = process.env.DATABASE_URL || '';
    let dbPassword = '';
    try { dbPassword = decodeURIComponent(new URL(dbUrl).password || ''); } catch (_) { /* ignore */ }

    const forbidden = [
      FAKE_TOKEN, ...Object.values(FAKE_ENV),
      process.env.SESSION_SECRET, dbPassword, process.env.REDIS_URL,
      process.env.FEED_API_KEY, process.env.SSLCZ_STORE_PASSWORD
    ].filter((v) => typeof v === 'string' && v.length >= 6);

    for (const res of [viaSession, viaToken]) {
      for (const secret of forbidden) expect(res.text.includes(secret)).toBe(false);
      expect(res.text).not.toMatch(/(postgres(ql)?|rediss?|mongodb):\/\//i); // কানেকশন স্ট্রিং
      expect(res.text).not.toMatch(/-----BEGIN [A-Z ]*(PRIVATE|PUBLIC) KEY-----/);
    }
  });

  test('প্রয়োজনীয় অপারেশনাল মেট্রিক আছে', async () => {
    const res = await freshRequest().get('/metrics').set('x-metrics-token', FAKE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/bet420_nodejs_eventloop_lag/);   // event loop lag
    expect(res.text).toMatch(/bet420_process_resident_memory_bytes/); // memory
    expect(res.text).toMatch(/bet420_db_pool_waiting/);        // DB pool অপেক্ষমাণ
    expect(res.text).toMatch(/bet420_db_pool_in_use/);         // DB pool ব্যবহৃত
    expect(res.text).toMatch(/bet420_queue_pending_jobs/);     // job_queue গভীরতা
    expect(res.text).toMatch(/bet420_http_requests_total/);    // 5xx হার এখান থেকে (status_code লেবেল)
  });
});
