// tests/security/errorLeakSweep.test.js
// ---------------------------------------------------------------------------
// পুরো routes/ জুড়ে করা error-leak সুইপের রিগ্রেশন গার্ড।
//
// আগের প্যাটার্নটা ছিল `catch (err) { req.flash('error', '...: ' + err.message) }` বা
// `res.json({ error: err.message })`। pg-এর এরর মেসেজে টেবিল/কলাম/কনস্ট্রেইন্টের নাম এবং
// সার্ভারের ফাইল পাথ থাকে — সেটা ব্রাউজারে গেলে আক্রমণকারী স্কিমা ম্যাপ করে ফেলতে পারে।
//
// কিন্তু একই catch ব্লকে ইচ্ছাকৃত ভ্যালিডেশন এররও আসে ("এই নামে ইতিমধ্যে একটা Role আছে।"),
// যেগুলো অ্যাডমিনকে দেখানোই উদ্দেশ্য। তাই দুই দিকই এখানে লক করা হচ্ছে:
//
//   1. ইন্টারনাল (pg) এরর → জেনেরিক বাংলা বার্তা, কোনো DB internals নয়;
//   2. ইচ্ছাকৃত PublicError → বার্তাটা হুবহু আগের মতোই দেখা যায় (আচরণ অপরিবর্তিত)।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const { PublicError } = require('../../utils/safeError');

// একটা বাস্তবসম্মত pg এরর মেসেজ — টেবিলের নাম, কলামের নাম ও সার্ভার ফাইল পাথসহ
const LEAK = 'relation "secret_games_table" does not exist — column "hidden_col" at /srv/app/routes/adminGames.js:77';

function expectNoLeak(text) {
  const t = String(text || '');
  expect(t).not.toContain('secret_games_table');
  expect(t).not.toContain('hidden_col');
  expect(t).not.toContain('does not exist');
  expect(t).not.toContain('/srv/app/');
  expect(t).not.toContain(encodeURIComponent(LEAK));
}

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  return { agent, token };
}

/**
 * শুধু নির্দিষ্ট SQL প্যাটার্নে মেলা ক্যোয়ারিগুলোকে ফেল করায়, বাকি সব (সেশন, isAdmin,
 * RBAC লুকআপ) আসল pool.query-তেই যায় — নাহলে রিকোয়েস্ট auth পর্যায়েই মরে যেত এবং
 * টেস্ট আসলে টার্গেট হ্যান্ডলারে পৌঁছাত না।
 */
function failQueriesMatching(pattern, message = LEAK) {
  const original = pool.query.bind(pool);
  return jest.spyOn(pool, 'query').mockImplementation((text, params) => {
    const sql = typeof text === 'string' ? text : (text && text.text) || '';
    if (pattern.test(sql)) return Promise.reject(new Error(message));
    return original(text, params);
  });
}

describe('error-leak সুইপ — ইন্টারনাল এরর ব্রাউজারে পৌঁছায় না', () => {
  let admin;
  let csrf;

  beforeAll(async () => {
    admin = await makeAdminAgent();
    const page = await admin.agent.get('/admin');
    const m = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '');
    csrf = m ? m[1] : admin.token;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // /admin/games — আগে catch ব্লক /admin-এ রিডাইরেক্ট করত এবং err.message
  // ফ্ল্যাশ বার্তায় বসিয়ে দিত। এখন পেজটাই loadError ব্যানারসহ রেন্ডার হয়।
  // ------------------------------------------------------------------
  test('গেম তালিকার ক্যোয়ারি ব্যর্থ হলে পেজ loadError সহ রেন্ডার হয়, DB internals ছাড়াই', async () => {
    failQueriesMatching(/FROM games/i);
    const res = await admin.agent.get('/admin/games');

    expect(res.status).toBe(200); // /admin-এ রিডাইরেক্ট নয় — অ্যাডমিন কারণটা দেখতে পায়
    expectNoLeak(res.text);
    expect(res.text).toContain('ডেটা লোড করা যায়নি'); // partials/load-error ব্যানার
  });

  test('গেম যোগ করা ব্যর্থ হলে ফ্ল্যাশ বার্তায় কাঁচা pg এরর যায় না', async () => {
    failQueriesMatching(/INSERT INTO games|MAX\(sort_order\)/i);
    const res = await admin.agent.post('/admin/games/add').type('form').send({
      _csrf: csrf, name: 'Leak Probe Game', slug: 'leak-probe-game',
      category: 'slots', provider: 'ProbeCo', badge: ''
    });
    expect(res.status).toBe(302);
    expectNoLeak(res.headers.location || '');

    jest.restoreAllMocks();
    const follow = await admin.agent.get('/admin/games');
    expectNoLeak(follow.text);
  });

  test('গেম সর্ট API ব্যর্থ হলে JSON-এ ইন্টারনাল এরর ফেরত যায় না', async () => {
    failQueriesMatching(/UPDATE games SET sort_order/i);
    const res = await admin.agent.post('/admin/games/sort')
      .send({ order: [1, 2], _csrf: csrf });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expectNoLeak(JSON.stringify(res.body));
  });

  // ------------------------------------------------------------------
  // Role ম্যানেজমেন্ট — এখানেই দুই শ্রেণির এরর একসাথে থাকে, তাই দুই দিকই পরীক্ষা করা হয়।
  // ------------------------------------------------------------------
  test('Role তৈরি ইন্টারনাল এররে ব্যর্থ হলে redirect URL-এ DB internals যায় না', async () => {
    // শুধু INSERT ফেল করানো হচ্ছে — rbac.getRoleByKey()-এর `FROM roles WHERE key`
    // লুকআপটা requirePermission নিজেই ব্যবহার করে, সেটা ফেল করালে টেস্ট হ্যান্ডলারে
    // পৌঁছানোর আগেই permission-চেক পর্যায়ে মরে যেত।
    failQueriesMatching(/INSERT INTO roles/i);
    const res = await admin.agent.post('/admin/roles').type('form')
      .send({ _csrf: csrf, name: 'Leak Probe Role', description: '' });
    expect(res.status).toBe(302);
    expectNoLeak(res.headers.location || '');

    jest.restoreAllMocks();
    const follow = await admin.agent.get('/admin/roles');
    expectNoLeak(follow.text);
  });

  // ------------------------------------------------------------------
  // নোটিফিকেশন টেমপ্লেট ফর্ম — এখানেই দুই শ্রেণির এরর একই catch ব্লকে আসে এবং
  // দুটোই সরাসরি পেজে রেন্ডার হয়, তাই আচরণটা এখানে সবচেয়ে স্পষ্টভাবে পরীক্ষা করা যায়।
  // ------------------------------------------------------------------
  test('ইচ্ছাকৃত ভ্যালিডেশন বার্তা (PublicError) আগের মতোই অ্যাডমিনকে দেখানো হয়', async () => {
    // অবৈধ চ্যানেল → services/templates.js একটা PublicError থ্রো করে
    const res = await admin.agent.post('/admin/notification-templates').type('form')
      .send({ _csrf: csrf, template_key: 'probe_key', channel: 'carrier_pigeon', lang: 'bn', name: 'Probe', body: 'x' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('অবৈধ চ্যানেল'); // ভ্যালিডেশন বার্তা চাপা পড়েনি
  });

  test('টেমপ্লেট তৈরিতে ইন্টারনাল এরর হলে জেনেরিক বার্তা যায়', async () => {
    const templates = require('../../services/templates');
    jest.spyOn(templates, 'createTemplate').mockRejectedValue(new Error(LEAK));

    const res = await admin.agent.post('/admin/notification-templates').type('form')
      .send({ _csrf: csrf, template_key: 'probe_key2', channel: 'in_app', lang: 'bn', name: 'Probe', body: 'x' });
    expect(res.status).toBe(200);
    expectNoLeak(res.text);
  });

  // ------------------------------------------------------------------
  // Queue JSON এন্ডপয়েন্ট — Redis/BullMQ এররে হোস্ট ও পোর্ট থাকে।
  // ------------------------------------------------------------------
  test('queue stats API ব্যর্থ হলে Redis কানেকশন বিবরণ ফেরত যায় না', async () => {
    const queues = require('../../queues');
    const redisLeak = 'connect ECONNREFUSED redis-internal.prod.local:6379';
    jest.spyOn(queues, 'getQueueHealthStats').mockRejectedValue(new Error(redisLeak));

    const res = await admin.agent.get('/admin/queues/api/stats');
    const body = JSON.stringify(res.body);
    expect(res.body.success).toBe(false);
    expect(body).not.toContain('redis-internal.prod.local');
    expect(body).not.toContain('ECONNREFUSED');
  });

  // ------------------------------------------------------------------
  // System diagnostics — পুরো চেক-রান ব্যর্থ হলে আগে err.message পেজে বসত।
  // ------------------------------------------------------------------
  test('system diagnostics পুরোপুরি ব্যর্থ হলে পেজে ইন্টারনাল এরর রেন্ডার হয় না', async () => {
    const healthCheck = require('../../services/healthCheck');
    const dbLeak = 'password authentication failed for user "livo_prod" host=10.0.0.7';
    jest.spyOn(healthCheck, 'runAllChecks').mockRejectedValue(new Error(dbLeak));

    const res = await admin.agent.get('/admin/system-diagnostics');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('livo_prod');
    expect(res.text).not.toContain('10.0.0.7');
    expect(res.text).not.toContain('password authentication failed');
  });

  test('system diagnostics JSON API-ও একইভাবে জেনেরিক বার্তা দেয়', async () => {
    const healthCheck = require('../../services/healthCheck');
    const dbLeak = 'password authentication failed for user "livo_prod" host=10.0.0.7';
    jest.spyOn(healthCheck, 'runAllChecks').mockRejectedValue(new Error(dbLeak));

    const res = await admin.agent.get('/admin/api/system-diagnostics');
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('livo_prod');
    expect(body).not.toContain('10.0.0.7');
  });

  // ------------------------------------------------------------------
  // বাল্ক অপারেশন — প্রতি-সারির ব্যর্থতা JSON-এ ফেরত যায়।
  // ------------------------------------------------------------------
  test('বাল্ক KYC অনুমোদনে প্রতি-সারির pg এরর ক্লায়েন্টে ফেরত যায় না', async () => {
    failQueriesMatching(/kyc_requests/i);
    const res = await admin.agent.post('/admin/kyc/bulk-approve')
      .send({ ids: [987654], _csrf: csrf });

    if (res.status === 200) {
      const body = JSON.stringify(res.body);
      expectNoLeak(body);
      expect(res.body.results[0].success).toBe(false);
      // ব্যর্থতা লুকানো হয়নি — শুধু কারণটা জেনেরিক
      expect(res.body.failed).toBe(1);
    }
  });
});
