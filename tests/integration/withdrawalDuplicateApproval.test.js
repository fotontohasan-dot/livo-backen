const { pool } = require('../../db');

// ==================== Phase 4: withdrawal ডুপ্লিকেট অনুমোদন ====================
//
// roadmap Phase 4/6-এর দাবি: একই withdrawal যেন দুবার process না হয়।
//
// routes/admin.js-এর অনুমোদন পথ সঠিক প্যাটার্ন ব্যবহার করে —
// BEGIN + SELECT ... FOR UPDATE + status !== 'pending' হলে বাতিল।
// দুটো অ্যাডমিন একই সময়ে Approve চাপলে দ্বিতীয়টার লেনদেন প্রথমটার লকের
// জন্য অপেক্ষা করে, তারপর status ততক্ষণে 'approved' দেখে থেমে যায়।
//
// কিন্তু কোনো টেস্ট এটা সমান্তরালে যাচাই করত না। FOR UPDATE সরিয়ে দিলে
// দুটো লেনদেনই 'pending' দেখত এবং একই উত্তোলন দুবার অনুমোদিত হত —
// অর্থাৎ দুবার টাকা বেরোত। বাগটা কেবল ভিড়ের সময় দেখা দিত।
//
// HTTP স্তর ব্যবহার করা হয়নি: একই সেশনের রিকোয়েস্ট express-session-এর
// কারণে সিরিয়ালাইজ হয়ে যায়, তাই race তৈরিই হত না। তাই সরাসরি pool
// client দিয়ে রুটের ট্রানজেকশন প্যাটার্নটাই চালানো হয়।

const WORKERS = 6;

async function makeUser() {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', 1000) RETURNING id`,
    ['wd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9)]
  );
  return r.rows[0].id;
}

async function makePendingWithdrawal(userId, amount) {
  const r = await pool.query(
    `INSERT INTO payment_requests (user_id, type, amount, status, method)
     VALUES ($1, 'withdraw', $2, 'pending', 'bkash') RETURNING id`,
    [userId, amount]
  );
  return r.rows[0].id;
}

// routes/admin.js-এর অনুমোদন প্যাটার্ন
async function approve(requestId, { withLock = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = withLock
      ? 'SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE'
      : 'SELECT * FROM payment_requests WHERE id = $1';
    const r = await client.query(q, [requestId]);
    const req = r.rows[0];
    if (!req || req.type !== 'withdraw' || req.status !== 'pending') {
      await client.query('ROLLBACK');
      return false;
    }
    if (!withLock) await new Promise((res) => setTimeout(res, 30));
    await client.query(
      "UPDATE payment_requests SET status = 'approved' WHERE id = $1", [requestId]
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

async function cleanup(userId) {
  await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

describe('Phase 4 — একই withdrawal দুবার অনুমোদিত হয় না', () => {
  jest.setTimeout(60000);

  test('সমান্তরাল অনুমোদনে ঠিক একটাই সফল হয়', async () => {
    const userId = await makeUser();
    try {
      const reqId = await makePendingWithdrawal(userId, 500);

      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => approve(reqId))
      );

      expect(results.filter(Boolean).length).toBe(1);

      const r = await pool.query(
        'SELECT status FROM payment_requests WHERE id = $1', [reqId]
      );
      expect(r.rows[0].status).toBe('approved');
    } finally {
      await cleanup(userId);
    }
  });

  test('ইতিমধ্যে অনুমোদিত request আবার অনুমোদিত হয় না', async () => {
    const userId = await makeUser();
    try {
      const reqId = await makePendingWithdrawal(userId, 500);
      expect(await approve(reqId)).toBe(true);
      expect(await approve(reqId)).toBe(false);
    } finally {
      await cleanup(userId);
    }
  });

  test('লক ছাড়া প্যাটার্ন সত্যিই ভাঙে — টেস্টটা race ধরতে পারে', async () => {
    // এটাই প্রমাণ যে harness সমান্তরালতা তৈরি করছে। এই টেস্ট পাস না
    // করলে উপরের সবুজ ফলাফলও অর্থহীন।
    const userId = await makeUser();
    try {
      const reqId = await makePendingWithdrawal(userId, 500);
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => approve(reqId, { withLock: false }))
      );
      expect(results.filter(Boolean).length).toBeGreaterThan(1);
    } finally {
      await cleanup(userId);
    }
  });
});
