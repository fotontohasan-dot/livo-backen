const { pool } = require('../../db');

// ==================== Phase 5: payment callback idempotency ====================
//
// roadmap Phase 5-এর দাবি: duplicate callback protection। গেটওয়ে (SSLCommerz)
// একই লেনদেনের IPN একাধিকবার পাঠাতে পারে — নেটওয়ার্ক রিট্রাই, timeout, বা
// ব্যবহারকারীর ব্রাউজার রিফ্রেশে। সুরক্ষা না থাকলে একই ডিপোজিট দুবার
// credit হত।
//
// routes/payment.js সঠিক প্যাটার্ন ব্যবহার করে:
//   BEGIN
//   SELECT * FROM payment_requests WHERE gateway_tran_id = $1 FOR UPDATE
//   if (request.status !== 'pending') ROLLBACK   // ডুপ্লিকেট IPN
//   ... যাচাই ... UPDATE status='approved' ... COMMIT
//
// (DB-র check constraint শুধু pending/approved/rejected মানে, তাই
//  সফল অবস্থাটা 'approved'।)
//
// দুটো callback একসাথে এলে দ্বিতীয়টা প্রথমটার লকের জন্য অপেক্ষা করে,
// তারপর status ততক্ষণে 'approved' দেখে থেমে যায়।
//
// কোনো টেস্ট এটা সমান্তরালে যাচাই করত না। HTTP স্তর ব্যবহার করা যায় না —
// আসল callback গেটওয়ে যাচাই (validatePayment) ডাকে, যার জন্য SSLCommerz
// sandbox credential লাগে; সেটা এই environment-এ নেই। তাই রুটের
// ট্রানজেকশন প্যাটার্নটাই সরাসরি pool client দিয়ে চালানো হয়।

const WORKERS = 6;
const AMOUNT = 750;

async function makeUser() {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', 0) RETURNING id`,
    ['ipn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9)]
  );
  return r.rows[0].id;
}

async function makePendingDeposit(userId, tranId) {
  const r = await pool.query(
    `INSERT INTO payment_requests (user_id, type, amount, status, method, gateway_tran_id)
     VALUES ($1, 'deposit', $2, 'pending', 'sslcommerz', $3) RETURNING id`,
    [userId, AMOUNT, tranId]
  );
  return r.rows[0].id;
}

// routes/payment.js-এর callback প্যাটার্ন (গেটওয়ে যাচাই বাদে)
async function handleCallback(tranId, { withLock = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = withLock
      ? 'SELECT * FROM payment_requests WHERE gateway_tran_id = $1 FOR UPDATE'
      : 'SELECT * FROM payment_requests WHERE gateway_tran_id = $1';
    const r = await client.query(q, [tranId]);
    const request = r.rows[0];

    if (!request) { await client.query('ROLLBACK'); return false; }
    if (request.status !== 'pending') { await client.query('ROLLBACK'); return false; }

    if (!withLock) await new Promise((res) => setTimeout(res, 30));

    await client.query(
      "UPDATE payment_requests SET status = 'approved' WHERE id = $1", [request.id]
    );
    await client.query(
      'UPDATE users SET coins = coins + $1 WHERE id = $2', [request.amount, request.user_id]
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

async function cleanup(userId) {
  await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

describe('Phase 5 — একই deposit callback দুবার credit করে না', () => {
  jest.setTimeout(60000);

  test('সমান্তরাল callback-এ ঠিক একবারই credit হয়', async () => {
    const userId = await makeUser();
    try {
      const tranId = 'TRAN_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await makePendingDeposit(userId, tranId);

      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => handleCallback(tranId))
      );

      expect(results.filter(Boolean).length).toBe(1);
      // সবচেয়ে গুরুত্বপূর্ণ: ব্যালেন্সে ঠিক একবারের টাকা
      expect(await coins(userId)).toBe(AMOUNT);
    } finally {
      await cleanup(userId);
    }
  });

  test('পরে আসা duplicate IPN উপেক্ষিত হয়', async () => {
    const userId = await makeUser();
    try {
      const tranId = 'TRAN_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await makePendingDeposit(userId, tranId);

      expect(await handleCallback(tranId)).toBe(true);
      expect(await handleCallback(tranId)).toBe(false);
      expect(await handleCallback(tranId)).toBe(false);
      expect(await coins(userId)).toBe(AMOUNT);
    } finally {
      await cleanup(userId);
    }
  });

  test('লক ছাড়া প্যাটার্ন সত্যিই দুবার credit করে — টেস্টটা race ধরে', async () => {
    // এটাই প্রমাণ যে harness সমান্তরালতা তৈরি করছে।
    const userId = await makeUser();
    try {
      const tranId = 'TRAN_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await makePendingDeposit(userId, tranId);

      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => handleCallback(tranId, { withLock: false }))
      );

      const ok = results.filter(Boolean).length;
      expect(ok).toBeGreaterThan(1);
      expect(await coins(userId)).toBeGreaterThan(AMOUNT);
    } finally {
      await cleanup(userId);
    }
  });
});
