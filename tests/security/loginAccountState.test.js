// tests/security/loginAccountState.test.js
// ---------------------------------------------------------------------------
// পাসওয়ার্ড লগইনে অ্যাকাউন্ট-স্টেট এনফোর্সমেন্ট।
//
// routes/auth.js-এর POST /login হ্যান্ডলারে চেকগুলো লেখা ছিল ঠিকঠাক —
//
//     if (user.is_banned) { ... }
//     if (user.self_exclude_until && new Date(user.self_exclude_until) > new Date()) { ... }
//
// কিন্তু ঠিক উপরের ক্যোয়ারিটা ছিল:
//
//     SELECT id, username, email, phone, password, role FROM users WHERE ...
//
// অর্থাৎ is_banned / self_exclude_until / email_verified কলামগুলো কখনো লোডই হতো না।
// JavaScript-এ অনুপস্থিত প্রপার্টি undefined, আর undefined falsy — তাই দুটো if-ব্লকই
// নীরবে সবসময় skip হতো। ফলাফল: ব্যান করা অ্যাকাউন্ট এবং সেল্ফ-এক্সক্লুশনে থাকা
// অ্যাকাউন্ট দুটোই স্বাভাবিকভাবে লগইন করতে পারত, আর VPN/Tor স্টেপ-আপ ভেরিফিকেশনও
// (যেটা `user.email_verified`-এর উপর নির্ভর করে) কখনো ট্রিগার হতো না।
//
// এটা কোনো "নিয়ম বদলানোর" বাগ নয় — নিয়ম ঠিকই ছিল, শুধু ইনপুট ডেটা অনুপস্থিত ছিল।
//
// পরিধি সম্পর্কে সৎ থাকা জরুরি: middleware/auth.js-এর isAuth() প্রতিটা সুরক্ষিত
// রিকোয়েস্টে DB থেকে is_banned/self_exclude_until আবার যাচাই করে এবং সেশন ধ্বংস
// করে দেয়। অর্থাৎ ব্যানড ইউজার লগইনের পর কার্যত কোনো সুরক্ষিত পেজে পৌঁছাতে পারত না —
// এটা সম্পূর্ণ authentication bypass ছিল না, ছিল defense-in-depth-এর বাইরের স্তরটার
// নীরব ব্যর্থতা (ব্লকড অ্যাকাউন্টও একটা বৈধ সেশন কুকি পেয়ে যেত, এবং লগইন-মুহূর্তের
// ব্যাখ্যামূলক বার্তা কখনো দেখানো হতো না)।
//
// ব্যতিক্রম এবং সবচেয়ে গুরুত্বপূর্ণ অংশ: email_verified-এর অনুপস্থিতির কোনো
// ক্ষতিপূরণকারী স্তর নেই। VPN/Tor/উচ্চ-ঝুঁকির লগইনে স্টেপ-আপ ভেরিফিকেশন
// `needsStepUp && user.email && user.email_verified` শর্তে চলে — কলামটা লোড না
// হওয়ায় সেটা কখনোই ট্রিগার হয়নি, অর্থাৎ ঝুঁকিপূর্ণ লগইন নিঃশব্দে স্টেপ-আপ ছাড়াই
// পাস করে যেত।
//
// তাই টেস্টগুলো লগইন *রুটের* সিদ্ধান্তে (POST-এর রিডাইরেক্ট গন্তব্য) দাঁড়ানো,
// শুধু "শেষ পর্যন্ত ঢুকতে পারল কিনা"-তে নয় — নাহলে isAuth-এর ক্ষতিপূরণ টেস্টটাকে
// নিরর্থকভাবে সবুজ করে দিত।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

const PASSWORD = 'SecurePass123';

// একটা বৈধ, লগইনযোগ্য অ্যাকাউন্ট তৈরি করে তার username/phone ফেরত দেয়।
async function registerUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone, password: PASSWORD, confirmPassword: PASSWORD, _csrf: token
  });
  return { username, phone };
}

// লগইন চেষ্টা করে দুটো আলাদা জিনিস ফেরত দেয়:
//   acceptedByLoginRoute — /login হ্যান্ডলার নিজে ক্রেডেনশিয়াল গ্রহণ করেছে কিনা
//     (ব্যর্থ হলে সে সবসময় /login-এ ফেরত পাঠায়)। ব্লকড অ্যাকাউন্টের ক্ষেত্রে
//     এটাই আসল পরীক্ষা।
//   reachesProtectedPage — isAuth-সুরক্ষিত পেজে সত্যিই পৌঁছানো যায় কিনা।
async function tryLogin(phone) {
  const { agent, token } = await getCsrfAgent('/login');
  const res = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ identifier: phone, password: PASSWORD, _csrf: token });
  const location = res.headers.location || '';
  const acceptedByLoginRoute = res.status === 302 && !/^\/login/.test(location);

  const profile = await agent.get('/profile');
  const reachesProtectedPage = profile.status === 200;

  return { acceptedByLoginRoute, reachesProtectedPage, location };
}

describe('লগইনে অ্যাকাউন্ট-স্টেট এনফোর্সমেন্ট', () => {
  test('সাধারণ ইউজার আগের মতোই লগইন করতে পারে (আচরণ অপরিবর্তিত)', async () => {
    const { phone } = await registerUser();
    const { acceptedByLoginRoute, reachesProtectedPage } = await tryLogin(phone);
    expect(acceptedByLoginRoute).toBe(true);
    expect(reachesProtectedPage).toBe(true);
  });

  test('ব্যান করা অ্যাকাউন্ট সঠিক পাসওয়ার্ড দিয়েও লগইন করতে পারে না', async () => {
    const { username, phone } = await registerUser();
    await pool.query('UPDATE users SET is_banned = true WHERE username = $1', [username]);

    const { acceptedByLoginRoute, reachesProtectedPage, location } = await tryLogin(phone);
    // লগইন রুট নিজেই প্রত্যাখ্যান করে — শুধু পরের রিকোয়েস্টে isAuth ধরে ফেলে না।
    expect(acceptedByLoginRoute).toBe(false);
    expect(location).toMatch(/^\/login/);
    expect(reachesProtectedPage).toBe(false);
  });

  test('সেল্ফ-এক্সক্লুশন চলাকালীন লগইন আটকে যায়', async () => {
    const { username, phone } = await registerUser();
    await pool.query(
      "UPDATE users SET self_exclude_until = NOW() + INTERVAL '7 days' WHERE username = $1",
      [username]
    );

    const { acceptedByLoginRoute, location, reachesProtectedPage } = await tryLogin(phone);
    expect(acceptedByLoginRoute).toBe(false);
    expect(location).toMatch(/^\/login/);
    expect(reachesProtectedPage).toBe(false);
  });

  test('সেল্ফ-এক্সক্লুশনের মেয়াদ শেষ হলে আবার লগইন করা যায়', async () => {
    // এটাই প্রমাণ করে যে ফিক্সটা "সবাইকে ব্লক করে" সমাধান করেনি — সময়সীমার
    // তুলনাটা সত্যিই কাজ করছে, অতীতের তারিখ আর কাউকে আটকায় না।
    const { username, phone } = await registerUser();
    await pool.query(
      "UPDATE users SET self_exclude_until = NOW() - INTERVAL '1 day' WHERE username = $1",
      [username]
    );

    const { acceptedByLoginRoute, reachesProtectedPage } = await tryLogin(phone);
    expect(acceptedByLoginRoute).toBe(true);
    expect(reachesProtectedPage).toBe(true);
  });

  test('লগইন ক্যোয়ারি নিরাপত্তা-স্টেট কলামগুলো সত্যিই লোড করে', async () => {
    // উপরের আচরণ-টেস্টগুলোর পরিপূরক সাদা-বাক্স গার্ড: কেউ ভবিষ্যতে ক্যোয়ারি
    // "পরিষ্কার" করতে গিয়ে কলামগুলো আবার বাদ দিলে সেটা এখানেই ধরা পড়বে,
    // কারণ কলাম বাদ পড়লে চেকগুলো নীরবে অকার্যকর হয়ে যায় — কোনো এরর হয় না।
    const source = require('fs').readFileSync(require.resolve('../../routes/auth.js'), 'utf8');
    const loginQuery = /SELECT[^;]*?FROM users WHERE LOWER\(email\) = \$1 OR phone = \$1/s.exec(source);
    expect(loginQuery).not.toBeNull();
    expect(loginQuery[0]).toMatch(/is_banned/);
    expect(loginQuery[0]).toMatch(/self_exclude_until/);
    expect(loginQuery[0]).toMatch(/email_verified/);
  });
});
