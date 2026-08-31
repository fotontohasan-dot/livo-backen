// tests/integration/adminDepositMethodCoverage.test.js
// ---------------------------------------------------------------------------
// PHASE 3 — অ্যাডমিন ডিপোজিট কিউ: মেথড কভারেজ।
//
// AUDIT FINDING (এখানে ঠিক করা হয়েছে): routes/payment.js-এর ডিপোজিট ফর্ম
// VALID_METHODS = ['bkash','nagad','rocket','upay','bank','crypto'] গ্রহণ করে,
// কিন্তু GET /payment/admin/deposits-এ তিন জায়গাতেই আলাদা করে
// ['bkash','nagad','rocket'] হার্ডকোড করা ছিল — ট্যাব ফিল্টার, টোটাল কোয়েরি ও
// error fallback। ফলে upay/bank/crypto দিয়ে করা ডিপোজিট এই পেজে কোথাও দেখা
// যেত না: ?method=upay দিলেও চুপচাপ bkash-এ ফিরে যেত, আর মেথড-ভিত্তিক আয়ের
// হিসাব নীরবে অসম্পূর্ণ থাকত। HTTP 200 আসায় ধরা পড়ত না।
//
// এই suite নিশ্চিত করে ট্যাব তালিকা VALID_METHODS-এর সাথে সিঙ্কে থাকে — ভবিষ্যতে
// নতুন মেথড যোগ করে ভিউ আপডেট করতে ভুলে গেলে এখানেই ফেল করবে।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

// রুট ফাইল থেকেই সত্যের উৎস নেওয়া হচ্ছে, টেস্টে আবার হার্ডকোড করা হচ্ছে না —
// নাহলে দুই জায়গায় দুই তালিকা রাখার সেই সমস্যাটাই ফিরে আসত।
const fs = require('fs');
const path = require('path');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'payment.js'), 'utf8');
const VALID_METHODS = JSON.parse(
  routeSrc.match(/const VALID_METHODS = (\[[^\]]+\])/)[1].replace(/'/g, '"')
);

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const res = await pool.query(
    'UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]
  );
  return { agent, userId: res.rows[0].id };
}

let adminAgent, adminUserId;

beforeAll(async () => {
  const a = await makeAdminAgent();
  adminAgent = a.agent; adminUserId = a.userId;
});

afterAll(async () => {
  await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [adminUserId]).catch(() => {});
  await pool.end().catch(() => {});
});

test('VALID_METHODS-এ ছয়টা মেথডই আছে (রেগ্রেশন গার্ড)', () => {
  expect(VALID_METHODS).toEqual(
    expect.arrayContaining(['bkash', 'nagad', 'rocket', 'upay', 'bank', 'crypto'])
  );
});

describe('GET /payment/admin/deposits — প্রতিটা বৈধ মেথডে', () => {
  test.each(VALID_METHODS)('?method=%s — 200 দেয় এবং ওই ট্যাবই সিলেক্টেড থাকে', async (m) => {
    const res = await adminAgent.get(`/payment/admin/deposits?method=${m}`);
    expect(res.status).toBe(200);
    // সিলেক্টেড ট্যাবের লিংকে active ক্লাস বসে — bkash-এ চুপচাপ ফিরে গেলে এটা ফেল করবে
    expect(res.text).toContain(`?method=${m}&quick=`);
    expect(res.text).toMatch(new RegExp(`method=${m}[^"]*"[^>]*class="dep-tab active"`));
  });

  test('ছয়টা মেথডের ট্যাবই পেজে রেন্ডার হয়', async () => {
    const res = await adminAgent.get('/payment/admin/deposits');
    expect(res.status).toBe(200);
    VALID_METHODS.forEach(m => expect(res.text).toContain(`?method=${m}&quick=`));
  });

  test('অজানা মেথড দিলে নিরাপদে ডিফল্ট bkash-এ ফেরে (SQL-এ পৌঁছায় না)', async () => {
    const res = await adminAgent.get("/payment/admin/deposits?method=' OR 1=1--");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/method=bkash[^"]*"[^>]*class="dep-tab active"/);
  });
});

describe('মেথড-ভিত্তিক টোটাল ও তালিকা', () => {
  test('upay/bank/crypto-র approved ডিপোজিট টোটালে গোনা হয় ও তালিকায় দেখা যায়', async () => {
    // আগে এই তিনটা মেথড টোটাল কোয়েরির ANY($1)-এ ছিলই না, তাই অঙ্ক সবসময় ০ থাকত
    const seeded = [['upay', 111], ['bank', 222], ['crypto', 333]];
    for (const [method, amount] of seeded) {
      await pool.query(
        `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status)
         VALUES ($1, 'deposit', $2, $3, $4, '01700000000', 'approved')`,
        [adminUserId, method, amount, `COV${method}${Date.now()}`]
      );
    }

    for (const [method, amount] of seeded) {
      const res = await adminAgent.get(`/payment/admin/deposits?method=${method}&quick=today`);
      expect(res.status).toBe(200);
      expect(res.text).toContain(amount.toLocaleString('en-US'));
    }
  });
});
