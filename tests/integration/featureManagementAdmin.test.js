// tests/integration/featureManagementAdmin.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন Feature Management কনসোল — অ্যাক্সেস কন্ট্রোল, টগল, অডিট লগ।
//
// স্পেসিফিকেশনের দাবিগুলো যা এখানে যাচাই হয়:
//   • প্রতিটা ON/OFF পরিবর্তন অডিট রেকর্ড তৈরি করে (কে, কোন ফিচার, আগে কী ছিল,
//     এখন কী, কোন IP, কখন);
//   • ফিচার বন্ধ থাকলেও অ্যাডমিন সেটা ম্যানেজ করতে পারেন;
//   • রেজিস্ট্রি-ম্যানেজড ফিচার ডিলিট করা যায় না (ডিলিট করলে গেট নীরবে
//     ডিফল্টে ফিরে গিয়ে বন্ধ ফিচার আবার খুলে যেত)।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, freshRequest, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const featureFlags = require('../../services/featureFlags');
const { cleanupUsers } = require('../helpers/cleanup');

// তৈরি করা অ্যাডমিন ইউজার রেখে গেলে পরে চলা অ্যাডমিন-গণনা নির্ভর suite
// ভুল সংখ্যা দেখে ফেল করত (CI-এর একটানা ১০৮-suite রানে)।
const createdUserIds = [];
afterAll(async () => { await cleanupUsers(createdUserIds); });

// tests/admin.test.js-এর প্রতিষ্ঠিত প্যাটার্ন: সাধারণ ইউজার হিসেবে রেজিস্টার করে
// সেশন প্রতিষ্ঠা করা হয়, তারপর DB-তে role='admin' করা হয়। এতে অ্যাডমিন লগইনের
// বাধ্যতামূলক 2FA এনরোলমেন্ট ফ্লো এড়ানো যায় — সেটা আলাদাভাবে admin.test.js-এ
// কভার করা আছে, এখানে যাচাইয়ের বিষয় Feature Management নিজেই।
async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('ffadm');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123',
            confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query('UPDATE users SET role=$1 WHERE username=$2', ['admin', username]);
  const r = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  if (r.rows[0]) createdUserIds.push(r.rows[0].id);
  return { agent, token, username };
}

describe('Admin Feature Management', () => {
  let admin;

  beforeAll(async () => { admin = await makeAdminAgent(); });

  afterEach(async () => {
    await pool.query('UPDATE feature_flags SET enabled=true');
    await featureFlags.invalidateCache();
  });

  // afterEach ছাড়াও afterAll — কোনো টেস্ট মাঝপথে throw করলে (বা beforeAll
  // ব্যর্থ হলে) afterEach চলে না, আর feature_flags টেবিলটা পুরো টেস্ট DB-তে
  // শেয়ার্ড। ফ্ল্যাগ বন্ধ অবস্থায় ছেড়ে গেলে পরের suite-গুলোর (/games,
  // /matches, /coins) রুট 403 পেত — অর্থাৎ সম্পূর্ণ অসম্পর্কিত টেস্ট ফেল করত।
  afterAll(async () => {
    await pool.query('UPDATE feature_flags SET enabled=true');
    await featureFlags.invalidateCache();
  });

  // দ্রষ্টব্য: টেস্ট অ্যাডমিনকে হার্ড-ডিলিট করা হয় না — admin_logs.admin_id-তে
  // FK আছে (অডিট ট্রেইল ইচ্ছাকৃতভাবে সুরক্ষিত, users মুছলে RESTRICT করে)।
  // এটাই কাঙ্ক্ষিত আচরণ, তাই টেস্ট সেটার বিরুদ্ধে না গিয়ে সারিটা রেখে দেয়।

  test('লগইন ছাড়া Feature Management-এ ঢোকা যায় না', async () => {
    const res = await freshRequest().get('/admin/features');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });

  test('সাধারণ ইউজার Feature Management-এ ঢুকতে পারে না', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    await agent.post('/register').type('form').send({
      username: uniqueUsername('nrm'), phone: uniquePhone(),
      password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
    });
    const res = await agent.get('/admin/features');
    expect(res.status).not.toBe(200);
  });

  test('অ্যাডমিন পেজটি খুলতে পারেন এবং আসল ফিচারগুলো দেখতে পান', async () => {
    const res = await admin.agent.get('/admin/features');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Feature Management/);
    expect(res.text).toMatch(/lucky_wheel/);
    expect(res.text).toMatch(/deposit/);
  });

  test('পুরনো /admin/feature-flags পাথ এখনো কাজ করে (ব্যাকওয়ার্ড কম্প্যাটিবল)', async () => {
    const res = await admin.agent.get('/admin/feature-flags');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Feature Management/);
  });

  test('টগল করলে DB-তে persist হয় এবং পরিবর্তন সাথে সাথে কার্যকর হয়', async () => {
    const r = await pool.query("SELECT id, enabled FROM feature_flags WHERE key='missions'");
    const { id, enabled } = r.rows[0];
    await admin.agent.post(`/admin/feature-flags/${id}/toggle`).type('form').send({ _csrf: admin.token });

    const after = await pool.query("SELECT enabled FROM feature_flags WHERE key='missions'");
    expect(after.rows[0].enabled).toBe(!enabled);
    await featureFlags.invalidateCache();
    expect(await featureFlags.isEnabled('missions')).toBe(!enabled);
  });

  test('প্রতিটা টগল অডিট লগে আগের ও নতুন অবস্থাসহ রেকর্ড হয়', async () => {
    const r = await pool.query("SELECT id FROM feature_flags WHERE key='cashback'");
    const id = r.rows[0].id;
    await admin.agent.post(`/admin/feature-flags/${id}/toggle`).type('form').send({ _csrf: admin.token });

    const log = await pool.query(
      `SELECT admin_username, details, ip_address, created_at FROM admin_logs
       WHERE action_type='FEATURE_FLAG_TOGGLED' ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows.length).toBe(1);
    const row = log.rows[0];
    expect(row.admin_username).toBe(admin.username);
    expect(row.details).toMatch(/cashback/);
    expect(row.details).toMatch(/ON|OFF/);
    expect(row.details).toMatch(/→/);          // আগের → নতুন অবস্থা
    expect(row.ip_address).toBeTruthy();
    expect(row.created_at).toBeTruthy();
  });

  test('ফিচার বন্ধ থাকলেও অ্যাডমিন কনসোল খোলা থাকে (নিজের পায়ে কুড়াল নয়)', async () => {
    await pool.query('UPDATE feature_flags SET enabled=false');
    await featureFlags.invalidateCache();
    const res = await admin.agent.get('/admin/features');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/lucky_wheel/);
  });

  test('রেজিস্ট্রি-ম্যানেজড ফিচার ডিলিট করা যায় না — সারি টিকে থাকে', async () => {
    const r = await pool.query("SELECT id FROM feature_flags WHERE key='lucky_wheel'");
    const id = r.rows[0].id;
    const res = await admin.agent.post(`/admin/feature-flags/${id}/delete`).type('form').send({ _csrf: admin.token });
    expect(res.headers.location).toMatch(/feature_protected/);

    const still = await pool.query("SELECT id FROM feature_flags WHERE key='lucky_wheel'");
    expect(still.rows.length).toBe(1);
  });

  test('এরর রেসপন্সে কাঁচা DB/ইন্টারনাল বিবরণ যায় না', async () => {
    const res = await admin.agent.get('/admin/features?error=feature_protected');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/SELECT \* FROM|relation "|pg_|ECONNREFUSED|syntax error at/i);
  });
});
