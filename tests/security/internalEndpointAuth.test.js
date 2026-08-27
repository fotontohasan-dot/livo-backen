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
// /internal/reset-admin — ব্রেক-গ্লাস admin রিকভারি।
//
// রুটটা শুধু ADMIN_RESET_TOKEN সেট থাকলেই রেজিস্টার হয়, আর সেটা app.js লোড হওয়ার সময়
// একবারই পড়া হয়। তাই আলাদা module registry-তে env সেট করে অ্যাপটা নতুন করে লোড করা হয় —
// চলমান টেস্ট অ্যাপের কনফিগ অপরিবর্তিত থাকে।
//
// এই ব্লকের রিগ্রেশনগুলো তিনটা আসল দুর্বলতা আটকে রাখে:
//   ১) GET রিকোয়েস্টই admin অ্যাকাউন্ট বদলে দিত (state-changing GET)।
//   ২) /internal/reset-admin/status টোকেনধারীকে NEW_ADMIN_EMAIL, পাসওয়ার্ডের দৈর্ঘ্য,
//      DB role এবং একটা কার্যকর bcrypt-compare অরাকল দিয়ে দিত।
//   ৩) মিউটেশন প্রথমেই সব বিদ্যমান admin-কে ডিমোট করত, তারপর নতুন admin বসাতে যেত —
//      দ্বিতীয় ধাপ ব্যর্থ হলে সিস্টেমে একজনও admin থাকত না।
// ---------------------------------------------------------------------------
describe('/internal/reset-admin ব্রেক-গ্লাস রিকভারি', () => {
  // বাস্তব প্রোডাকশন টোকেনের মতোই যথেষ্ট দীর্ঘ (>= 32 ক্যারেক্টার) — নাহলে প্রোডাকশনে
  // রুটটা fail-closed হয়ে নিষ্ক্রিয় থাকত।
  const TOKEN = 'reset-token-for-regression-test-only';
  let isolatedApp;      // আলাদা env নিয়ে বুট করা স্বতন্ত্র অ্যাপ ইনস্ট্যান্স
  let isolatedServer;   // তার নিজস্ব দীর্ঘস্থায়ী listening সার্ভার
  let request;

  beforeAll(async () => {
    request = require('supertest');
    jest.resetModules();
    process.env.ADMIN_RESET_TOKEN = TOKEN;
    process.env.NEW_ADMIN_EMAIL = 'secret-admin@internal.example';
    process.env.NEW_ADMIN_PASSWORD = 'SuperSecretAdminPassword123';
    jest.isolateModules(() => {
      isolatedApp = require('../../app.js');
    });
    // supertest-কে non-listening express অ্যাপ দিলে সে প্রতি রিকোয়েস্টে নিজে
    // listen/close করে — সমান্তরাল রিকোয়েস্টে সেটাই ECONNRESET তৈরি করত
    // (tests/testHarnessIntegrity.test.js-এর ব্যাখ্যা দেখো)। তাই এই স্বতন্ত্র
    // ইনস্ট্যান্সের জন্যও একটাই দীর্ঘস্থায়ী সার্ভার রাখা হচ্ছে।
    isolatedServer = require('http').createServer(isolatedApp);
    await new Promise((resolve) => isolatedServer.listen(0, resolve));
  });

  afterAll(async () => {
    if (isolatedServer && isolatedServer.listening) {
      if (typeof isolatedServer.closeAllConnections === 'function') isolatedServer.closeAllConnections();
      await new Promise((resolve) => isolatedServer.close(() => resolve()));
    }
    delete process.env.ADMIN_RESET_TOKEN;
    delete process.env.NEW_ADMIN_EMAIL;
    delete process.env.NEW_ADMIN_PASSWORD;
    jest.resetModules();
  });

  test('status ডায়াগনস্টিক রুটটা আর নেই — পাসওয়ার্ড অরাকল সরানো হয়েছে', async () => {
    // সঠিক টোকেন দিয়েও রুটটা আর থাকা উচিত না। আগে এটাই ইমেইল/দৈর্ঘ্য/role এবং
    // "পাসওয়ার্ড DB-র হ্যাশের সাথে মেলে কিনা" — সব ফাঁস করত।
    const res = await request(isolatedServer)
      .get('/internal/reset-admin/status')
      .set('x-admin-reset-token', TOKEN);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('secret-admin@internal.example');
    expect(res.text).not.toContain('মিলছে');
  });

  test('GET কোনো state বদলায় না — শুধু নিশ্চিতকরণ ফর্ম দেখায়', async () => {
    const res = await request(isolatedServer).get('/internal/reset-admin');
    expect(res.status).toBe(200);
    // ফর্মটা POST-এ সাবমিট হয় — অর্থাৎ GET নিজে কিছু করে না।
    expect(res.text).toContain('method="POST"');
    // ফর্মে কোনো গোপন কনফিগ মান থাকে না।
    expect(res.text).not.toContain(TOKEN);
    expect(res.text).not.toContain('secret-admin@internal.example');
    expect(res.text).not.toContain('SuperSecretAdminPassword123');
  });

  test('টোকেন ছাড়া POST 404 — রুটের অস্তিত্বই ফাঁস হয় না', async () => {
    const res = await request(isolatedServer)
      .post('/internal/reset-admin')
      .type('form')
      .send({ confirm: 'yes' });
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('secret-admin@internal.example');
  });

  test('ভুল টোকেনেও POST 404', async () => {
    const res = await request(isolatedServer)
      .post('/internal/reset-admin')
      .set('x-admin-reset-token', 'wrong-token-wrong-token-wrong-tok')
      .type('form')
      .send({ confirm: 'yes' });
    expect(res.status).toBe(404);
  });

  test('query string-এ টোকেন দিলে কাজ করে না — URL প্রক্সি লগ/Referer-এ ফাঁস হয়', async () => {
    const res = await request(isolatedServer)
      .post(`/internal/reset-admin?token=${encodeURIComponent(TOKEN)}`)
      .type('form')
      .send({ confirm: 'yes' });
    expect(res.status).toBe(404);
  });

  test('সঠিক টোকেন কিন্তু নিশ্চিতকরণ ছাড়া হলে কোনো পরিবর্তন হয় না', async () => {
    const res = await request(isolatedServer)
      .post('/internal/reset-admin')
      .set('x-admin-reset-token', TOKEN)
      .type('form')
      .send({});
    expect(res.status).toBe(400);
  });
});
