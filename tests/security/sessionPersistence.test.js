// ---------------------------------------------------------------------------
// tests/security/sessionPersistence.test.js
//
// অভিযোগ ছিল: অ্যাডমিন ও ইউজার — দুই প্যানেলেই কিছুক্ষণ পর নিজে থেকে লগআউট
// হয়ে যায়। কারণ ছিল middleware/auth.js-এর সেশন-ধ্বংসের শর্ত অতিরিক্ত ঢিলা:
// ক্যাশ/DB ব্যর্থ হলে বা ক্যাশ থেকে ভাঙা অবজেক্ট এলে `!status.exists` সত্য
// হয়ে যেত এবং নিরপরাধ ব্যবহারকারীর সেশন ধ্বংস হতো।
//
// এই ফাইলটা সেই ইনভেরিয়েন্টটাই লক করে:
//
//   সেশন ধ্বংস হবে **কেবল** নিশ্চিত প্রমাণে (ব্যান / সেল্ফ-এক্সক্লুশন /
//   অ্যাকাউন্ট নেই)। "যাচাই করা যায়নি" কখনোই ধ্বংসের কারণ নয় — তখন 503।
//
// উল্টো দিকটাও সমান জরুরি এবং এখানেই পরীক্ষা করা হয়: ব্যান করা ইউজারের
// সেশন এখনো ধ্বংসই হয়, নাহলে এই ফিক্স একটা নিরাপত্তা গর্ত হয়ে যেত।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const cache = require('../../services/cache');
const cacheKeys = require('../../services/cacheKeys');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const PASSWORD = 'SessionPersist123';

async function registerAndLogin() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('sp');
  const phone = uniquePhone();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone, password: PASSWORD, confirmPassword: PASSWORD, _csrf: token });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, username, phone, userId: r.rows[0].id };
}

// লগইন আছে কি না তার একমাত্র নির্ভরযোগ্য সংকেত: isAuth-সুরক্ষিত একটা পেজ
// রিডাইরেক্ট না করে রেন্ডার হয় কি না।
async function stillLoggedIn(agent) {
  const res = await agent.get('/profile');
  return res.status === 200;
}

describe('সেশন স্থায়িত্ব (middleware/auth.js)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('বহু রিকোয়েস্টের পরেও লগইন টিকে থাকে', async () => {
    const { agent } = await registerAndLogin();
    expect(await stillLoggedIn(agent)).toBe(true);

    // ৫০+ রিকোয়েস্ট — rolling সেশনে প্রতিবার কুকির মেয়াদ বাড়ে, কোথাও
    // নিঃশব্দে কাটা পড়ে না।
    for (let i = 0; i < 55; i++) {
      const res = await agent.get('/');
      expect(res.status).toBeLessThan(400);
    }

    expect(await stillLoggedIn(agent)).toBe(true);
  });

  test('ক্যাশ ও DB দুটোই ব্যর্থ হলেও সেশন ধ্বংস হয় না', async () => {
    const { agent, userId } = await registerAndLogin();

    // Redis ও DB — দুটোই ডাউন সিমুলেট। এটাই সেই "স্ট্যাটাস অজানা" অবস্থা।
    // আচরণ হওয়া উচিত fail-closed (ভেতরে ঢুকতে দেওয়া হবে না) কিন্তু সেশন অক্ষত।
    const spy = jest.spyOn(cache, 'getOrSet').mockRejectedValue(new Error('redis down'));
    const dbSpy = jest.spyOn(pool, 'query').mockRejectedValue(new Error('db down'));

    const during = await agent.get('/profile');

    // এখানে স্ট্যাটাস কোড নিয়ে কড়াকড়ি করা হচ্ছে না ইচ্ছাকৃতভাবে: DB পুরো
    // মক করা থাকায় 503 এরর-পেজটা রেন্ডার করতে গিয়েও DB লাগে, ফলে সেটা
    // 500-এ পরিণত হয়। যেটা আসলে গুরুত্বপূর্ণ তা হলো — এটা কখনো /login-এ
    // রিডাইরেক্ট নয়, অর্থাৎ সেশন ধ্বংস হয়নি।
    expect(during.status).toBeGreaterThanOrEqual(500);
    expect(during.status).not.toBe(302);

    spy.mockRestore();
    dbSpy.mockRestore();
    await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});

    // পরিষেবা ফিরলে ইউজার রিফ্রেশ করলেই আবার ভেতরে — নতুন করে লগইন লাগে না।
    // এটাই পুরো ফিক্সের মূল কথা।
    expect(await stillLoggedIn(agent)).toBe(true);
  });

  test('ক্যাশ থেকে ভাঙা/অসম্পূর্ণ অবজেক্ট এলে ইউজার ক্ষতিগ্রস্ত হয় না', async () => {
    const { agent, userId } = await registerAndLogin();

    // ঠিক এই কেসটাই আসল বাগ ছিল: `exists` ফিল্ড ছাড়া একটা অবজেক্ট ফিরলে
    // `!status.exists` সত্য হয়ে যেত এবং নিরপরাধ ব্যবহারকারীর সেশন ধ্বংস হতো।
    //
    // ফিক্সের পরে ভাঙা এন্ট্রিটা "অজানা" গণ্য হয়, মুছে ফেলা হয়, আর সরাসরি
    // DB থেকে আসল স্ট্যাটাস পড়া হয় — DB তো ঠিকই আছে। তাই ব্যবহারকারীর
    // কাছে কিছুই ঘটেনি: রিকোয়েস্ট স্বাভাবিকভাবেই ২০০ দেয়।
    jest.spyOn(cache, 'getOrSet').mockResolvedValue({});

    const during = await agent.get('/profile');
    expect(during.status).toBe(200);          // 302 → /login হলে সেটাই রিগ্রেশন

    jest.restoreAllMocks();
    await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});

    expect(await stillLoggedIn(agent)).toBe(true);
  });

  test('ব্যান করা ইউজারের সেশন এখনো ধ্বংস হয় (এই আচরণ অক্ষুণ্ন)', async () => {
    const { agent, userId } = await registerAndLogin();
    expect(await stillLoggedIn(agent)).toBe(true);

    await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [userId]);
    await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});

    const res = await agent.get('/profile');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('সেল্ফ-এক্সক্লুডেড ইউজারের সেশন এখনো ধ্বংস হয় (দায়িত্বশীল জুয়া)', async () => {
    const { agent, userId } = await registerAndLogin();

    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET self_exclude_until = $1 WHERE id = $2', [until, userId]);
    await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});

    const res = await agent.get('/profile');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
