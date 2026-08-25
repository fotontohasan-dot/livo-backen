// tests/security/internalEndpointAuth.test.js
// ---------------------------------------------------------------------------
// অথরাইজেশন ও ইনফরমেশন-ডিসক্লোজার গার্ড, তিনটা আলাদা এন্ডপয়েন্ট-শ্রেণির জন্য।
//
// ১) /admin/queues* এর read এন্ডপয়েন্টগুলোতে requirePermission ছিল না, অথচ একই ফিচারের
//    সব mutation রুট 'cron_jobs_manage' চায়। ফলে সীমিত-অনুমতির স্টাফ অ্যাকাউন্ট
//    dead-letter জবের পে-লোড ও Redis হেলথ দেখে ফেলতে পারত।
//
// ২) /internal/reset-admin/status-এ কোনো টোকেন যাচাই ছিল না। ADMIN_RESET_TOKEN সেট
//    থাকলেই যে কেউ, লগইন ছাড়াই, NEW_ADMIN_EMAIL-এর পুরো মান ও "পাসওয়ার্ড DB-র হ্যাশের
//    সাথে মেলে কিনা" — একটা কার্যকর যাচাই-অরাকল — দেখে ফেলতে পারত।
//
// ৩) /ready পাবলিক প্রোব, কিন্তু ব্যর্থ হলে pg কানেকশন এরর (হোস্ট/পোর্ট/DB নাম) JSON-এ
//    ফেরত দিত।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');
const { pool } = require('../../db');

async function makeAdminAgent(roleKey) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query('UPDATE users SET role=$2, role_key=$3 WHERE username=$1', [username, 'admin', roleKey]);
  return { agent, token, username };
}

describe('ইন্টারনাল/অ্যাডমিন এন্ডপয়েন্টের অথরাইজেশন', () => {
  // cron_jobs_manage ছাড়া একটা বাস্তবসম্মত সীমিত Role — টেস্টের জন্য deterministic
  const LIMITED_ROLE_KEY = 'test_limited_queue_role';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO roles (key, name, description, is_system, permissions)
       VALUES ($1, 'Test Limited', 'queue RBAC regression', false, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [LIMITED_ROLE_KEY, JSON.stringify({ dashboard_view: true, users_view: true, cron_jobs_manage: false })]
    );
  });

  afterAll(async () => {
    await pool.query('UPDATE users SET role_key = NULL WHERE role_key = $1', [LIMITED_ROLE_KEY]);
    await pool.query('DELETE FROM roles WHERE key = $1', [LIMITED_ROLE_KEY]);
  });

  // ------------------------------------------------------------------
  // Queue read এন্ডপয়েন্ট — RBAC
  // ------------------------------------------------------------------
  test('cron_jobs_manage ছাড়া অ্যাডমিন queue ড্যাশবোর্ড দেখতে পারে না', async () => {
    const limited = await makeAdminAgent(LIMITED_ROLE_KEY);
    const res = await limited.agent.get('/admin/queues');
    expect([302, 403]).toContain(res.status);
    if (res.status === 302) {
      expect(res.headers.location || '').toMatch(/^\/admin(\/login)?$/);
    }
  });

  test('cron_jobs_manage ছাড়া অ্যাডমিন dead-letter job তালিকা API-তে পৌঁছাতে পারে না', async () => {
    const limited = await makeAdminAgent(LIMITED_ROLE_KEY);
    const res = await limited.agent.get('/admin/queues/api/jobs/notification');
    expect([302, 403]).toContain(res.status);
    // অনুমতি না থাকলে কোনো জব ডেটা ফেরত যায় না
    expect(res.body && res.body.jobs).toBeUndefined();
  });

  test('cron_jobs_manage থাকা অ্যাডমিন আগের মতোই queue ড্যাশবোর্ড দেখতে পায় (আচরণ অপরিবর্তিত)', async () => {
    const superAdmin = await makeAdminAgent('super_admin');
    const res = await superAdmin.agent.get('/admin/queues');
    expect(res.status).toBe(200);
  });

  // ------------------------------------------------------------------
  // /ready — পাবলিক প্রোব
  // ------------------------------------------------------------------
  test('/ready ব্যর্থ হলে DB কানেকশন বিবরণ ফাঁস করে না', async () => {
    const healthCheck = require('../../services/healthCheck');
    const dbLeak = 'DB not ready: connect ECONNREFUSED db-primary.internal:5432 database "livo_prod"';
    const spy = jest.spyOn(healthCheck, 'readiness').mockRejectedValue(new Error(dbLeak));
    try {
      const res = await freshRequest().get('/ready');
      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty('status', 'not_ready'); // প্রোবের কনট্র্যাক্ট অক্ষত
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('db-primary.internal');
      expect(body).not.toContain('livo_prod');
      expect(body).not.toContain('ECONNREFUSED');
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// /internal/reset-admin/status — রুটটা শুধু ADMIN_RESET_TOKEN সেট থাকলেই রেজিস্টার হয়,
// আর সেটা app.js লোড হওয়ার সময় একবারই পড়া হয়। তাই আলাদা module registry-তে env সেট
// করে অ্যাপটা নতুন করে লোড করা হয় — চলমান টেস্ট অ্যাপের কনফিগ অপরিবর্তিত থাকে।
// ---------------------------------------------------------------------------
// ==================== অ্যাডমিন-রিকভারি রুট অপসারণ (অডিট P1-04) ====================
// এই describe ব্লকটা আগে যাচাই করত যে /internal/reset-admin/status টোকেন ছাড়া 404 দেয়,
// কিন্তু সঠিক টোকেনে "আগের মতোই কাজ করে"। অডিটে ধরা পড়ে যে রুটটা নিজেই একটা স্থায়ী
// আনঅথেন্টিকেটেড অ্যাডমিন-টেকওভার দরজা ছিল:
//   • GET রিকোয়েস্টেই প্রতিটা অ্যাডমিনকে ডিমোট করে নতুন একজনকে বসিয়ে দিত
//   • পুরো ব্লকে একটাও অডিট-লগ কল ছিল না
//   • /status কার্যত একটা পাসওয়ার্ড অরাকল ছিল (bcrypt.compare-এর ফলাফল দেখাত)
//   • টোকেন query-string-এ যেত, তাই access log/Referer/error_logs-এ জমা হতে পারত
// রুট দুটো সম্পূর্ণ সরিয়ে দেওয়া হয়েছে। তাই টেস্টের প্রত্যাশাও উল্টে গেছে: এখন সঠিক
// টোকেন দিলেও ৪০৪ পাওয়াই কাঙ্ক্ষিত আচরণ। রিকভারি এখন `node reset-admin.js` দিয়ে,
// অর্থাৎ শেল/ডিপ্লয় অ্যাক্সেসের পেছনে।
describe('/internal/reset-admin — রুট সম্পূর্ণ অপসারিত (P1-04)', () => {
  const TOKEN = 'reset-token-for-regression-test-only';
  let isolatedApp;
  let request;

  beforeAll(() => {
    request = require('supertest');
    jest.resetModules();
    process.env.ADMIN_RESET_TOKEN = TOKEN;
    process.env.NEW_ADMIN_EMAIL = 'secret-admin@internal.example';
    process.env.NEW_ADMIN_PASSWORD = 'SuperSecretAdminPassword123';
    jest.isolateModules(() => {
      isolatedApp = require('../../app.js');
    });
  });

  afterAll(() => {
    delete process.env.ADMIN_RESET_TOKEN;
    delete process.env.NEW_ADMIN_EMAIL;
    delete process.env.NEW_ADMIN_PASSWORD;
    jest.resetModules();
  });

  test('সঠিক টোকেন দিয়েও status এন্ডপয়েন্ট আর নেই (404)', async () => {
    const res = await request(isolatedApp).get(`/internal/reset-admin/status?token=${encodeURIComponent(TOKEN)}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('secret-admin@internal.example');
    expect(res.text).not.toContain('ADMIN_RESET_TOKEN');
    expect(res.text).not.toContain('মিলছে');
  });

  test('সঠিক টোকেন দিয়েও ধ্বংসাত্মক রিসেট রুট আর নেই (404)', async () => {
    const res = await request(isolatedApp).get(`/internal/reset-admin?token=${encodeURIComponent(TOKEN)}`);
    expect(res.status).toBe(404);
  });

  test('টোকেন ছাড়া বা ভুল টোকেনেও 404 — কিছুই ফাঁস হয় না', async () => {
    for (const url of ['/internal/reset-admin/status', '/internal/reset-admin/status?token=wrong-token', '/internal/reset-admin']) {
      const res = await request(isolatedApp).get(url);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('secret-admin@internal.example');
    }
  });

  test('সোর্সে রুট হ্যান্ডলারটাই আর নেই (কমেন্ট বাদে)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/app\.(get|post)\(\s*['"`]\/internal\/reset-admin/);
  });
});
