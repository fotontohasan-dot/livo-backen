// tests/payment-wallet-integrity.test.js
// ---------------------------------------------------------------------------
// অভ্যন্তরীণ ওয়ালেট/পেমেন্ট রুটগুলোর ডাবল-ক্রেডিট গার্ড।
//
// একই ডিপোজিট রিকোয়েস্ট অনুমোদন করার একাধিক অভ্যন্তরীণ পথ আছে:
//   • POST /payment/admin/approve/:id            (একক, ফর্ম)
//   • POST /payment/admin/payments/bulk-approve  (বাল্ক, JSON)
//   • POST /admin/api/deposits/:id/approve       (ডিপোজিট কিউ, JSON)
// তিনটাই একই creditApprovedDeposit() ডাকে এবং SELECT ... FOR UPDATE + status
// চেকের উপর নির্ভর করে। এই ফাইল নিশ্চিত করে যে একটা পথে প্রসেস হয়ে যাওয়া রিকোয়েস্ট
// অন্য পথ দিয়ে দ্বিতীয়বার ক্রেডিট করা যায় না, এবং এক ইউজারের অনুমোদন অন্য ইউজারের
// ব্যালেন্স স্পর্শ করে না।
//
// এখানে ম্যানুয়াল approve/reject ওয়ার্কফ্লো বা গেটওয়ে ইন্টিগ্রেশনের কোনো আচরণ বদলানো
// হয়নি — শুধু বিদ্যমান আচরণের রিগ্রেশন গার্ড।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');
const cache = require('../services/cache');
const cacheKeys = require('../services/cacheKeys');

async function makeUser({ admin = false } = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  if (admin) await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, token, username, userId: row.id };
}

const coinsOf = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
const statusOf = async (id) => (await pool.query('SELECT status FROM payment_requests WHERE id=$1', [id])).rows[0].status;
const depositTxCount = async (uid) => Number((await pool.query(
  "SELECT COUNT(*) c FROM coin_transactions WHERE user_id=$1 AND type='deposit'", [uid])).rows[0].c);

async function pendingDeposit(userId, amount) {
  return (await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, status)
     VALUES ($1,'deposit','bkash',$2,'pending') RETURNING id`,
    [userId, amount]
  )).rows[0].id;
}

describe('ওয়ালেট ইন্টিগ্রিটি — অভ্যন্তরীণ রুট জুড়ে ডাবল-ক্রেডিট গার্ড', () => {
  test('একক approve-এর পর ডিপোজিট-API approve দ্বিতীয়বার ক্রেডিট করে না', async () => {
    const admin = await makeUser({ admin: true });
    const target = await makeUser();
    const id = await pendingDeposit(target.userId, 500);
    const before = await coinsOf(target.userId);

    await admin.agent.post(`/payment/admin/approve/${id}`).type('form').send({ _csrf: admin.token });
    expect(await statusOf(id)).toBe('approved');
    expect(await coinsOf(target.userId)).toBe(before + 500);

    const second = await admin.agent.post(`/admin/api/deposits/${id}/approve`)
      .set('X-CSRF-Token', admin.token).send({});
    expect(second.status).toBe(400);
    expect(await coinsOf(target.userId)).toBe(before + 500);
    expect(await depositTxCount(target.userId)).toBe(1);
  });

  test('ডিপোজিট-API approve-এর পর বাল্ক approve দ্বিতীয়বার ক্রেডিট করে না', async () => {
    const admin = await makeUser({ admin: true });
    const target = await makeUser();
    const id = await pendingDeposit(target.userId, 700);
    const before = await coinsOf(target.userId);

    const first = await admin.agent.post(`/admin/api/deposits/${id}/approve`)
      .set('X-CSRF-Token', admin.token).send({});
    expect(first.status).toBe(200);
    expect(await coinsOf(target.userId)).toBe(before + 700);

    const bulk = await admin.agent.post('/payment/admin/payments/bulk-approve')
      .set('X-CSRF-Token', admin.token).send({ ids: [id] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.succeeded).toBe(0);
    expect(await coinsOf(target.userId)).toBe(before + 700);
    expect(await depositTxCount(target.userId)).toBe(1);
  });

  test('reject করা রিকোয়েস্ট পরে approve করে ক্রেডিট নেওয়া যায় না', async () => {
    const admin = await makeUser({ admin: true });
    const target = await makeUser();
    const id = await pendingDeposit(target.userId, 400);
    const before = await coinsOf(target.userId);

    await admin.agent.post(`/payment/admin/reject/${id}`).type('form').send({ _csrf: admin.token });
    expect(await statusOf(id)).toBe('rejected');

    await admin.agent.post(`/payment/admin/approve/${id}`).type('form').send({ _csrf: admin.token });
    expect(await statusOf(id)).toBe('rejected');
    expect(await coinsOf(target.userId)).toBe(before);
    expect(await depositTxCount(target.userId)).toBe(0);
  });

  test('একই id বাল্ক লিস্টে দুইবার দিলেও একবারই ক্রেডিট হয়', async () => {
    const admin = await makeUser({ admin: true });
    const target = await makeUser();
    const id = await pendingDeposit(target.userId, 600);
    const before = await coinsOf(target.userId);

    const res = await admin.agent.post('/payment/admin/payments/bulk-approve')
      .set('X-CSRF-Token', admin.token).send({ ids: [id, id] });
    expect(res.status).toBe(200);
    expect(await coinsOf(target.userId)).toBe(before + 600);
    expect(await depositTxCount(target.userId)).toBe(1);
  });

  test('সমান্তরাল দুইটা approve রিকোয়েস্টেও একবারই ক্রেডিট হয় (FOR UPDATE লক)', async () => {
    const admin = await makeUser({ admin: true });
    const target = await makeUser();
    const id = await pendingDeposit(target.userId, 900);
    const before = await coinsOf(target.userId);

    await Promise.all([
      admin.agent.post(`/payment/admin/approve/${id}`).type('form').send({ _csrf: admin.token }),
      admin.agent.post(`/payment/admin/approve/${id}`).type('form').send({ _csrf: admin.token })
    ]);

    expect(await coinsOf(target.userId)).toBe(before + 900);
    expect(await depositTxCount(target.userId)).toBe(1);
  });

  test('এক ইউজারের অনুমোদন অন্য ইউজারের ব্যালেন্স স্পর্শ করে না', async () => {
    const admin = await makeUser({ admin: true });
    const a = await makeUser();
    const b = await makeUser();
    const idA = await pendingDeposit(a.userId, 500);
    const beforeA = await coinsOf(a.userId);
    const beforeB = await coinsOf(b.userId);

    await admin.agent.post(`/payment/admin/approve/${idA}`).type('form').send({ _csrf: admin.token });

    expect(await coinsOf(a.userId)).toBe(beforeA + 500);
    expect(await coinsOf(b.userId)).toBe(beforeB);
    expect(await depositTxCount(b.userId)).toBe(0);
  });

  test('উইথড্র reject-এ রিফান্ড একবারই হয়, দ্বিতীয় reject কিছু যোগ করে না', async () => {
    const admin = await makeUser({ admin: true });
    const target = await makeUser();
    await pool.query('UPDATE users SET coins = coins + 5000 WHERE id=$1', [target.userId]);
    const before = await coinsOf(target.userId);

    const id = (await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status)
       VALUES ($1,'withdraw','nagad',1000,'pending') RETURNING id`, [target.userId]
    )).rows[0].id;
    await pool.query('UPDATE users SET coins = coins - 1000 WHERE id=$1', [target.userId]);

    await admin.agent.post(`/payment/admin/reject/${id}`).type('form').send({ _csrf: admin.token });
    expect(await coinsOf(target.userId)).toBe(before);

    await admin.agent.post(`/payment/admin/reject/${id}`).type('form').send({ _csrf: admin.token });
    expect(await coinsOf(target.userId)).toBe(before);
  });

  test('ব্যান হওয়া ইউজারের পুরনো সেশন দিয়ে ওয়ালেট/ডিপোজিট/উইথড্র রুট আর অ্যাক্সেসযোগ্য থাকে না', async () => {
    const target = await makeUser();

    // ব্যান হওয়ার আগে অ্যাক্সেস স্বাভাবিক
    const before = await target.agent.get('/payment/wallet');
    expect(before.status).toBe(200);

    await pool.query('UPDATE users SET is_banned = true WHERE id=$1', [target.userId]);
    await cache.del(cacheKeys.userActiveStatus(target.userId)).catch(() => {});

    const wallet = await target.agent.get('/payment/wallet');
    expect(wallet.status).toBe(302);
    expect(wallet.headers.location).toMatch(/\/login/);

    const deposit = await target.agent.get('/payment/deposit');
    expect(deposit.status).toBe(302);
    expect(deposit.headers.location).toMatch(/\/login/);

    const withdraw = await target.agent.get('/payment/withdraw');
    expect(withdraw.status).toBe(302);
    expect(withdraw.headers.location).toMatch(/\/login/);
  });
});
