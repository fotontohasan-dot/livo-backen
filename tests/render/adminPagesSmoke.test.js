// tests/render/adminPagesSmoke.test.js
// ---------------------------------------------------------------------------
// গুরুত্বপূর্ণ অ্যাডমিন পেজগুলোর EJS রেন্ডার রিগ্রেশন গার্ড।
//
// tests/render/viewSmoke.test.js ইতিমধ্যে leaderboard ও backups কভার করে। কিন্তু আগের
// অডিটে ধরা পড়া বাগগুলোর ধরনটা ছিল *ডেটা-নির্ভর*: তালিকা খালি থাকলে লুপ চলত না, তাই পেজ
// 200 দিত; একটাও সারি থাকলেই টেমপ্লেটের undefined ভ্যারিয়েবল/টাইপ এরর 500 করত।
//
// তাই এখানে প্রতিটা পেজের জন্য আসল সারি সিড করা হয় (ইউজার, ডিপোজিট, উইথড্র, KYC,
// রেফারেল, কয়েন ট্রানজেকশন) এবং তারপর পেজ রেন্ডার করা হয়। EJS-এ undefined ভ্যারিয়েবল
// রেফারেন্স করলে res.render() next(err)-এ যায় → 500, তাই এই চেকেই সেটা ধরা পড়ে।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin' WHERE username=$1", [username]);
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, token, username, userId: row.id };
}

describe('অ্যাডমিন পেজ রেন্ডার স্মোক (ডেটা থাকা অবস্থায়)', () => {
  let admin;
  let subjectId;
  let referrerId;

  beforeAll(async () => {
    admin = await makeAdminAgent();

    // যাকে নিয়ে সব রেকর্ড তৈরি হবে
    const referrer = await makeAdminAgent();
    referrerId = referrer.userId;
    const subject = (await pool.query(
      `INSERT INTO users (username, phone, password, coins, role, referred_by_id)
       VALUES ($1,$2,$3,2500,'user',$4) RETURNING id`,
      [uniqueUsername('sub'), uniquePhone(), 'x'.repeat(20), referrerId]
    )).rows[0];
    subjectId = subject.id;

    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status)
       VALUES ($1,'deposit','bkash',1500,'pending'), ($1,'withdraw','nagad',800,'pending'),
              ($1,'deposit','bkash',300,'approved')`,
      [subjectId]
    );
    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, 300, 'deposit', 'render smoke seed')`,
      [subjectId]
    );
    await pool.query(
      `INSERT INTO kyc_requests (user_id, status) VALUES ($1,'pending')`,
      [subjectId]
    ).catch(async () => {
      // স্কিমা ভিন্ন হলে (অতিরিক্ত NOT NULL কলাম) KYC সিড ছাড়াই চলবে — পেজ তবু রেন্ডার হতে হবে
    });
    await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [referrerId, subjectId]
    ).catch(() => {});
  });

  const PAGES = [
    ['/admin', 'ড্যাশবোর্ড'],
    ['/admin/users', 'ইউজার তালিকা'],
    ['/admin/transactions', 'ট্রানজেকশন'],
    ['/admin/referrals', 'রেফারেল'],
    ['/admin/kyc', 'KYC'],
    ['/admin/backups', 'ব্যাকআপ'],
    ['/admin/leaderboard', 'লিডারবোর্ড'],
    ['/payment/admin/payments', 'পেমেন্ট তালিকা'],
    ['/payment/admin/deposits', 'ডিপোজিট তালিকা'],
    ['/payment/admin/summary', 'পেমেন্ট সামারি']
  ];

  test.each(PAGES)('%s (%s) — ডেটা থাকা অবস্থায় 500 দেয় না', async (path) => {
    const res = await admin.agent.get(path);
    expect(res.status).toBeLessThan(500);
  });

  test('/admin/users — সিড করা ইউজার তালিকায় দেখা যায়', async () => {
    const res = await admin.agent.get('/admin/users');
    expect(res.status).toBe(200);
    const username = (await pool.query('SELECT username FROM users WHERE id=$1', [subjectId])).rows[0].username;
    expect(res.text).toContain(username);
  });

  test('/admin/transactions — সিড করা পেমেন্ট রিকোয়েস্ট রেন্ডার হয়', async () => {
    const res = await admin.agent.get('/admin/transactions');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/1500|1,500/);
  });

  test('পেজিনেশন/ফিল্টার প্যারামিটার দিয়েও কোনো পেজ 500 দেয় না', async () => {
    const paths = [
      '/admin/users?page=2&search=zzz&status=active',
      '/admin/transactions?page=2',
      '/admin/referrals?page=1&search=zzz',
      '/payment/admin/deposits?status=pending',
      '/payment/admin/summary?quick=today'
    ];
    const failures = [];
    for (const p of paths) {
      const res = await admin.agent.get(p);
      if (res.status >= 500) failures.push(`${p} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });
});
