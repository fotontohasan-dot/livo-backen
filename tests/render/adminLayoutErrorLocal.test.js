// tests/render/adminLayoutErrorLocal.test.js
// ---------------------------------------------------------------------------
// views/admin/partials/admin-layout.ejs ধরে নিত `error`/`success` সবসময় connect-flash-এর
// অ্যারে। কিন্তু কয়েকটা অ্যাডমিন পেজ render locals-এ `error` নামে একটা স্ট্রিং পাঠায়
// (পেজের ভেতরে বার্তাটা দেখানোর জন্য), যা ফ্ল্যাশ অ্যারেটাকে shadow করত। স্ট্রিং-এরও
// .length থাকায় শর্তটা true হতো এবং error.forEach() → TypeError → পুরো পেজ 500।
//
// বাস্তব প্রভাবটা উল্টো ছিল: ব্যাকআপ রিস্টোর ব্যর্থ হলে অ্যাডমিনকে
// /admin/backups?error=... এ পাঠানো হতো, আর সেই পেজটাই 500 দিত — অর্থাৎ ব্যর্থতার
// বার্তাটা অ্যাডমিন কখনো দেখতেই পেত না।
//
// এই টেস্ট সেই রিগ্রেশনটা লক করে: ?error= সেট থাকা অবস্থায়ও পেজগুলো 200 রেন্ডার করে।
// ---------------------------------------------------------------------------

const { withScripts } = require('../helpers/viewScripts');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  return { agent, token };
}

// admin-layout ব্যবহার করে এমন পেজ, যেগুলো `error` লোকালটা স্ট্রিং হিসেবে পেতে পারে
const PAGES_WITH_ERROR_QUERY = [
  '/admin/backups?error=not_found',
  '/admin/backups?error=restore_failed',
  '/admin/feature-flags?error=create_failed',
  '/admin/feature-flags?error=not_found'
];

const PAGES_PLAIN = [
  '/admin/backups',
  '/admin/feature-flags',
  '/admin/roles',
  '/admin/sentry-status',
  '/admin/notification-templates'
];

describe('admin-layout: স্ট্রিং error লোকাল থাকলেও পেজ ক্র্যাশ করে না', () => {
  let admin;
  beforeAll(async () => { admin = await makeAdminAgent(); });

  test.each(PAGES_WITH_ERROR_QUERY)('%s — 200 রেন্ডার হয় (আগে 500 হতো)', async (path) => {
    const res = await admin.agent.get(path);
    expect(res.status).toBe(200);
  });

  test.each(PAGES_PLAIN)('%s — স্বাভাবিক অবস্থাতেও আগের মতোই রেন্ডার হয়', async (path) => {
    const res = await admin.agent.get(path);
    expect(res.status).toBe(200);
  });

  test('ফ্ল্যাশ মেসেজ (অ্যারে) টোস্ট হিসেবে দেখানো আগের মতোই কাজ করে', async () => {
    // পারমিশন-বিহীন অ্যাকশনে rbac ফ্ল্যাশ সেট করে /admin-এ রিডাইরেক্ট করে; পরের পেজ-লোডে
    // সেই অ্যারে-ফ্ল্যাশটা LivoToast.show(...) হিসেবে রেন্ডার হওয়ার কথা।
    const res = await admin.agent.get('/admin');
    expect(res.status).toBe(200);
    // docs/CSP.md ধাপ ৩-এ টোস্ট কোডটা public/js/views/-এ সরানো হয়েছে;
    // পেজ + তার লোড করা স্ক্রিপ্ট একসাথে দেখা হয়।
    expect(withScripts(res.text)).toContain('LivoToast');
    // ফ্ল্যাশ বার্তাগুলো এখন JSON ডেটা ব্লকে যায়
    expect(res.text).toMatch(/id="admin-partials-flashConfig"/);
  });
});
