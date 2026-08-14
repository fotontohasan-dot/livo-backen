// tests/render/adminLoadError.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন তালিকা-পেজগুলোর ক্যোয়ারি ব্যর্থ হলে catch ব্লক খালি অ্যারে দিয়ে পেজ রেন্ডার করে।
// আগে সেই "ব্যর্থ" পেজ আর "সত্যিই কোনো সারি নেই" পেজ হুবহু একরকম দেখাত — ডেটাবেস ডাউন
// থাকা অবস্থায় অ্যাডমিন "০টি পেন্ডিং রিকোয়েস্ট" দেখে ধরে নিতে পারত অনুমোদনের কিছু নেই।
//
// এখন ব্যর্থ হলে loadError সেট হয় এবং শেয়ার্ড ব্যানার পার্শিয়াল সতর্কতা দেখায়। এই টেস্ট
// দুটো দিকই যাচাই করে: (ক) ব্যর্থতায় ব্যানার আসে, (খ) স্বাভাবিক অবস্থায় আসে না।
//
// গুরুত্বপূর্ণ: pool.query পুরোপুরি mock করা যায় না — auth/RBAC মিডলওয়্যারও DB পড়ে, সব
// ক্যোয়ারি ব্যর্থ করলে রিকোয়েস্ট হ্যান্ডলারে পৌঁছানোর আগেই আটকে যায়। তাই শুধু সংশ্লিষ্ট
// পেজের নিজস্ব ক্যোয়ারিটাই ব্যর্থ করা হয়, বাকিগুলো আসল ইমপ্লিমেন্টেশনে পাস-থ্রু করে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

const BANNER = 'ডেটা লোড করা যায়নি';

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  return { agent, token };
}

/** শুধু ওই ক্যোয়ারিগুলো ব্যর্থ করে যেগুলোতে `marker` আছে; বাকি সব আসল DB-তে যায়। */
function failQueriesMatching(marker) {
  const real = pool.query.bind(pool);
  return jest.spyOn(pool, 'query').mockImplementation((text, params) => {
    const sql = typeof text === 'string' ? text : (text && text.text) || '';
    if (sql.includes(marker)) return Promise.reject(new Error('simulated database failure'));
    return real(text, params);
  });
}

const PAGES = [
  ['/admin/transactions', 'FROM payment_requests pr'],
  ['/admin/users', 'SELECT COUNT(*) FROM users'],
  ['/payment/admin/payments', 'FROM payment_requests pr JOIN users u']
];

describe('অ্যাডমিন লোড-ব্যর্থতা বনাম স্বাভাবিক খালি অবস্থা', () => {
  let admin;
  beforeAll(async () => { admin = await makeAdminAgent(); });

  test.each(PAGES)('%s — স্বাভাবিক অবস্থায় কোনো এরর ব্যানার দেখায় না', async (path) => {
    const res = await admin.agent.get(path);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(BANNER);
  });

  test.each(PAGES)('%s — ক্যোয়ারি ব্যর্থ হলে এরর ব্যানার দেখায় (খালি তালিকা হিসেবে নয়)', async (path, marker) => {
    const spy = failQueriesMatching(marker);
    try {
      const res = await admin.agent.get(path);
      expect(res.status).toBe(200); // পেজ ক্র্যাশ করে না
      expect(res.text).toContain(BANNER);
    } finally {
      spy.mockRestore();
    }
  });
});
