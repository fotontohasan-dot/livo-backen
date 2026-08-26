// tests/render/adminLoadErrorPages.test.js
// ---------------------------------------------------------------------------
// tests/render/adminLoadError.test.js শুধু প্রথম দফায় ঠিক করা তিনটা পেজ (transactions,
// users, payment/admin) কভার করত। বাকি অ্যাডমিন তালিকা-পেজগুলোতেও একই সমস্যা ছিল —
// ক্যোয়ারি ব্যর্থ হলে catch ব্লক খালি অ্যারে দিয়ে পেজ রেন্ডার করত, ফলে "ডেটাবেস ডাউন"
// আর "সত্যিই কোনো রেকর্ড নেই" অ্যাডমিনের কাছে হুবহু একরকম দেখাত।
//
// এই টেস্ট প্রতিটা কভার করা পেজের জন্য চারটা জিনিস প্রমাণ করে:
//   1. স্বাভাবিক (শূন্য বা কিছু সারি) অবস্থায় পেজ আগের মতোই রেন্ডার হয়, কোনো এরর ব্যানার নেই।
//   2. ওই পেজের নিজস্ব ক্যোয়ারি ব্যর্থ হলে স্পষ্ট এরর-স্টেট দেখা যায়।
//   3. ব্যর্থতার রেসপন্সে কোনো SQL/ডেটাবেস internals (টেবিল/কলামের নাম, ড্রাইভার মেসেজ,
//      স্ট্যাক ট্রেস) ফাঁস হয় না।
//   4. RBAC ও CSRF আচরণ অপরিবর্তিত — নন-অ্যাডমিন এই পেজগুলো পায় না, এবং টোকেন ছাড়া
//      অ্যাডমিন mutation আগের মতোই আটকায়।
//
// গুরুত্বপূর্ণ: pool.query পুরোপুরি mock করা যায় না — auth/RBAC মিডলওয়্যারও DB পড়ে। তাই
// শুধু সংশ্লিষ্ট পেজের নিজস্ব ক্যোয়ারিটাই ব্যর্থ করা হয়, বাকি সব আসল DB-তে পাস-থ্রু করে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

const BANNER = 'ডেটা লোড করা যায়নি';

// ইচ্ছাকৃতভাবে এমন একটা মেসেজ যাতে SQL-এর মতো internals আছে — রেসপন্সে এর কোনো অংশ
// দেখা গেলেই বুঝতে হবে ডেটাবেস এরর ব্রাউজারে লিক করছে।
const LEAKY_DB_ERROR =
  'relation "secret_internal_table" does not exist — SELECT hash FROM api_keys WHERE token=$1';

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  return { agent, token, username };
}

async function makePlainAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  return { agent, token, username };
}

/** শুধু ওই ক্যোয়ারিগুলো ব্যর্থ করে যেগুলোতে `marker` আছে; বাকি সব আসল DB-তে যায়। */
function failQueriesMatching(marker) {
  const real = pool.query.bind(pool);
  return jest.spyOn(pool, 'query').mockImplementation((text, params) => {
    const sql = typeof text === 'string' ? text : (text && text.text) || '';
    if (sql.includes(marker)) return Promise.reject(new Error(LEAKY_DB_ERROR));
    return real(text, params);
  });
}

// [path, ওই পেজের নিজস্ব ক্যোয়ারির একটা ইউনিক অংশ]
const PAGES = [
  ['/admin/kyc', 'FROM kyc_requests'],
  ['/admin/bets', 'FROM bets b JOIN users u'],
  ['/admin/referrals', 'FROM referrals r'],
  ['/admin/activity', 'FROM admin_logs'],
  ['/admin/audit-logs', 'FROM audit_logs'],
  ['/admin/login-history', 'FROM login_logs l'],
  ['/admin/api-keys', 'FROM api_keys k'],
  ['/admin/bonuses', 'FROM bonuses'],
  ['/admin/fraud-logs', 'FROM fraud_flags'],
  ['/admin/news', 'FROM news ORDER BY'],
  ['/admin/promotions', 'FROM promotions ORDER BY'],
  ['/admin/announcements', 'FROM announcements ORDER BY'],
  ['/admin/tournaments', 'FROM tournaments'],
  ['/admin/support', 'cm.sender_id = u.id OR cm.receiver_id']
];

describe('অ্যাডমিন পেজ: লোড-ব্যর্থতা বনাম স্বাভাবিক খালি অবস্থা', () => {
  let admin;
  beforeAll(async () => { admin = await makeAdminAgent(); });

  test.each(PAGES)('%s — স্বাভাবিক অবস্থায় রেন্ডার হয়, এরর ব্যানার দেখায় না', async (path) => {
    const res = await admin.agent.get(path);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(BANNER);
  });

  test.each(PAGES)('%s — ক্যোয়ারি ব্যর্থ হলে এরর-স্টেট দেখায় (খালি তালিকা হিসেবে নয়)', async (path, marker) => {
    const spy = failQueriesMatching(marker);
    try {
      const res = await admin.agent.get(path);
      expect(res.status).toBe(200); // পেজ ক্র্যাশ করে না
      expect(res.text).toContain(BANNER);
    } finally {
      spy.mockRestore();
    }
  });

  test.each(PAGES)('%s — ব্যর্থতার রেসপন্সে কোনো SQL/ডেটাবেস internals ফাঁস হয় না', async (path, marker) => {
    const spy = failQueriesMatching(marker);
    try {
      const res = await admin.agent.get(path);
      expect(res.text).not.toContain('secret_internal_table');
      expect(res.text).not.toContain('does not exist');
      expect(res.text).not.toContain('SELECT hash FROM api_keys');
      expect(res.text).not.toContain(LEAKY_DB_ERROR);
      // স্ট্যাক ট্রেস/নোড ইন্টারনাল পাথও নয়
      expect(res.text).not.toContain('at Object.<anonymous>');
      expect(res.text).not.toMatch(/\/routes\/admin\.js:\d+/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('লোড-ব্যর্থতা RBAC/CSRF আচরণ বদলায় না', () => {
  let plain;
  let admin;
  beforeAll(async () => {
    plain = await makePlainAgent();
    admin = await makeAdminAgent();
  });

  test.each(PAGES)('%s — সাধারণ (নন-অ্যাডমিন) ইউজার পেজটা পায় না', async (path) => {
    const res = await plain.agent.get(path);
    expect(res.status).not.toBe(200);
    expect([302, 401, 403]).toContain(res.status);
  });

  test.each(PAGES)('%s — ক্যোয়ারি ব্যর্থ থাকা অবস্থাতেও নন-অ্যাডমিন ঢুকতে পারে না', async (path, marker) => {
    const spy = failQueriesMatching(marker);
    try {
      const res = await plain.agent.get(path);
      expect([302, 401, 403]).toContain(res.status);
      expect(res.text || '').not.toContain('secret_internal_table');
    } finally {
      spy.mockRestore();
    }
  });

  test('CSRF টোকেন ছাড়া অ্যাডমিন mutation আগের মতোই আটকায়', async () => {
    const res = await admin.agent.post('/admin/news/add').type('form')
      .send({ title: 'csrf probe', content: 'csrf probe' });
    expect(res.status).toBe(403);
  });
});
