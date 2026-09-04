// tests/render/adminLanguageSwitch.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন প্যানেলের ভাষা পরিবর্তন ও সংরক্ষণের কার্যকরী (functional) টেস্ট।
//
// যে সমস্যাগুলো এখানে লক করা হচ্ছে:
//   • ভাষা পরিবর্তনের পরে অ্যাডমিন যে পেজে ছিলেন সেখানেই থাকা উচিত। আগে
//     `/lang/:code` Referer সরাসরি res.redirect()-এ বসাত (open redirect); এখন
//     utils/redirectBack.js-এর backUrl() same-host যাচাই করে। বাইরের হোস্টে
//     রিডাইরেক্ট আর হওয়া উচিত নয়, কিন্তু সাইট-অভ্যন্তরীণ ফেরত কাজ করা উচিত।
//   • নির্বাচিত ভাষা আগে শুধু express-session-এ থাকত। সেশন শেষ হলে বা অন্য
//     ডিভাইস থেকে লগইন করলে ভাষা ডিফল্টে ফিরে যেত। এখন লগইন করা ইউজারের
//     পছন্দ users.preferred_language-এ লেখা হয় এবং পরের সেশনে ফিরে আসে।
//   • সাইডবারের লেবেল আগে হার্ডকোড বাংলা ছিল, তাই English মোডেও বাংলা দেখাত।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');
const en = require('../../locales/en.json');
const bn = require('../../locales/bn.json');

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  await pool.query("UPDATE users SET role='admin' WHERE username=$1", [username]);
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, username, userId: row.id };
}

describe('অ্যাডমিন ভাষা পরিবর্তন', () => {
  let admin;
  beforeAll(async () => { admin = await makeAdminAgent(); });

  test('ডিফল্টে অ্যাডমিন ড্যাশবোর্ড বাংলায় রেন্ডার হয়', async () => {
    const res = await admin.agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain(bn.admin_nav_item_all_users);
  });

  test('English-এ সুইচ করলে সাইডবারের লেবেল ইংরেজি হয়', async () => {
    await admin.agent.get('/lang/en');
    const res = await admin.agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain(en.admin_nav_item_all_users);
    expect(res.text).toContain(en.admin_nav_item_payment_approval);
  });

  test('English মোড রিফ্রেশের পরেও থাকে (সেশন persistence)', async () => {
    const res = await admin.agent.get('/admin');
    expect(res.text).toContain(en.admin_nav_item_all_users);
  });

  test('পুরনো লেআউটের পেজেও (sidebar.ejs) ভাষা প্রযোজ্য হয়', async () => {
    // /admin/kyc পুরনো partials/sidebar.ejs ব্যবহার করে — আগে এই পেজের
    // নেভিগেশন English মোডেও বাংলাতেই থাকত।
    const res = await admin.agent.get('/admin/kyc');
    expect(res.status).toBe(200);
    expect(res.text).toContain(en.admin_nav_item_kyc);
    expect(res.text).toContain(en.admin_ui_language);
  });

  test('বাংলায় ফিরে গেলে আবার বাংলা লেবেল দেখায়', async () => {
    await admin.agent.get('/lang/bn');
    const res = await admin.agent.get('/admin');
    expect(res.text).toContain(bn.admin_nav_item_all_users);
  });
});

describe('ভাষা পছন্দ ডেটাবেসে সংরক্ষিত হয়', () => {
  let admin;
  beforeAll(async () => { admin = await makeAdminAgent(); });

  test('নতুন অ্যাকাউন্টে preferred_language শুরুতে NULL (বিদ্যমান row বদলায় না)', async () => {
    const r = await pool.query('SELECT preferred_language FROM users WHERE id=$1', [admin.userId]);
    expect(r.rows[0].preferred_language).toBeNull();
  });

  test('/lang/en কল করলে পছন্দ ডেটাবেসে লেখা হয়', async () => {
    await admin.agent.get('/lang/en');
    // লেখাটা fire-and-forget, তাই একটু সময় দিয়ে যাচাই
    await new Promise((r) => setTimeout(r, 300));
    const res = await pool.query('SELECT preferred_language FROM users WHERE id=$1', [admin.userId]);
    expect(res.rows[0].preferred_language).toBe('en');
  });

  test('/lang/bn কল করলে পছন্দ আপডেট হয়', async () => {
    await admin.agent.get('/lang/bn');
    await new Promise((r) => setTimeout(r, 300));
    const res = await pool.query('SELECT preferred_language FROM users WHERE id=$1', [admin.userId]);
    expect(res.rows[0].preferred_language).toBe('bn');
  });

  test('কলামে শুধু bn/en লেখা যায় — অন্য মান CHECK constraint আটকায়', async () => {
    await expect(
      pool.query("UPDATE users SET preferred_language='xx' WHERE id=$1", [admin.userId])
    ).rejects.toThrow();
  });

  test('নতুন সেশনে লগইন করলে সেভ করা ভাষা ফিরে আসে', async () => {
    // অ্যাডমিন অ্যাকাউন্টে 2FA বাধ্যতামূলক, তাই লগইন সরাসরি ড্যাশবোর্ডে যায় না।
    // restore মিডলওয়্যার ভূমিকা/পারমিশন দেখে না — এটা যেকোনো লগইন করা ইউজারের
    // জন্য একই, তাই এখানে সাধারণ ইউজার দিয়েই আচরণটা যাচাই করা হচ্ছে।
    const { agent: regAgent, token: regToken } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await regAgent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
      username, phone: uniquePhone(), password: 'SecurePass123',
      confirmPassword: 'SecurePass123', _csrf: regToken
    });
    await pool.query("UPDATE users SET preferred_language='en' WHERE username=$1", [username]);

    // সম্পূর্ণ নতুন এজেন্ট = নতুন সেশন কুকি, কোনো session.lang নেই
    const { agent, token } = await getCsrfAgent('/login');
    await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, password: 'SecurePass123', _csrf: token });
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    // ভাষা-নির্ভর একটা key দিয়ে যাচাই — bn ও en মান আলাদা হতে হবে,
    // নাহলে টেস্টটা কিছুই প্রমাণ করে না।
    expect(en.deposit).not.toBe(bn.deposit);
    expect(res.text).toContain(en.deposit);
  });
});

describe('ভাষা পরিবর্তনে নিরাপত্তা সীমানা বদলায় না', () => {
  test('লগইন ছাড়া /lang/en কল করলে ক্র্যাশ করে না এবং সেশনেই সীমাবদ্ধ থাকে', async () => {
    const res = await freshRequest().get('/lang/en').redirects(0);
    expect([301, 302, 303, 307]).toContain(res.status);
  });

  test('বাইরের Referer দিয়ে ভাষা বদলালে সাইটের বাইরে রিডাইরেক্ট হয় না', async () => {
    const res = await freshRequest()
      .get('/lang/en')
      .set('Referer', 'https://evil.example.com/steal')
      .redirects(0);
    expect(res.headers.location).not.toMatch(/evil\.example\.com/);
  });
});
