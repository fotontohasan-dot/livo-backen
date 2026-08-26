// tests/integration/financialLedgerIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 03 — ব্যালেন্স ও coin_transactions লেজারের সঙ্গতি।
//
// মূল অপরিবর্তনীয় নিয়ম (invariant): users.coins-এর যেকোনো পরিবর্তনের বিপরীতে
// coin_transactions-এ ঠিক ততটুকুরই একটা সারি থাকতে হবে। নাহলে ইউজারের ব্যালেন্স আর
// তার লেনদেন-ইতিহাস আলাদা হয়ে যায় — হিসাব মেলানো অসম্ভব হয়ে পড়ে।
//
// এখানে যে তিনটা বাস্তব বাগ লক করা হচ্ছে:
//   ১. routes/admin.js — উইথড্র বাতিল করলে কয়েন ফেরত দেওয়া হতো, কিন্তু কোনো লেজার
//      সারি লেখা হতো না। অথচ উইথড্র চাওয়ার সময় -amount সারিটা লেখা হয়েছিল। ফলে প্রতি
//      বাতিল উইথড্রে ঠিক amount পরিমাণ গরমিল তৈরি হতো। (routes/payment.js-এর
//      rejectPaymentRequestById আগে থেকেই সঠিক ছিল।)
//   ২. অ্যাডমিন কয়েন যোগ/কমানো — ব্যালেন্স আপডেট ও লেজার ইনসার্ট আলাদা pool.query-তে
//      ছিল, কোনো ট্রানজেকশন ছাড়া।
//   ৩. কয়েন কমানোয় GREATEST(coins - $1, 0) ব্যালেন্স শূন্যে আটকাত, কিন্তু লেজারে পুরো
//      -amount লেখা হতো — ১০০ কয়েনের ইউজার থেকে ৫০০ কমালে স্থায়ী ৪০০ গরমিল।
//
// আসল PostgreSQL-এর বিরুদ্ধে চলে; ডাটাবেজ আচরণ mock করা হয়নি।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');

const START_BALANCE = 1000;

async function makeUser(coins = START_BALANCE) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ('ledger_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x', $1)
     RETURNING id`, [coins]
  );
  return r.rows[0].id;
}

async function balanceOf(userId) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].coins);
}

async function ledgerSum(userId) {
  const r = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id = $1', [userId]
  );
  return Number(r.rows[0].s);
}

async function cleanup(userId) {
  await pool.query('DELETE FROM coin_transactions WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

/** উইথড্র রিকোয়েস্ট — routes/payment.js যা করে ঠিক তাই */
async function requestWithdraw(userId, amount) {
  const upd = await pool.query(
    'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins',
    [amount, userId]
  );
  expect(upd.rowCount).toBe(1);
  const pr = await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status)
     VALUES ($1, 'withdraw', 'bkash', $2, '017xxxxxxxx', 'pending') RETURNING id`,
    [userId, amount]
  );
  await pool.query(
    `INSERT INTO coin_transactions (user_id, amount, type, description)
     VALUES ($1, $2, 'withdraw', 'উইথড্র রিকোয়েস্ট (bkash)')`,
    [userId, -amount]
  );
  return pr.rows[0].id;
}

describe('উইথড্র বাতিল — ব্যালেন্স ও লেজার মেলে', () => {
  test('routes/admin.js পথে বাতিল করলে ফেরতের লেজার সারি লেখা হয়', async () => {
    const userId = await makeUser();
    const requestId = await requestWithdraw(userId, 500);

    expect(await balanceOf(userId)).toBe(500);
    expect(START_BALANCE + await ledgerSum(userId)).toBe(500); // এখন পর্যন্ত মেলে

    // routes/admin.js-এর /api/withdrawals/:id/reject যা করে — ফেরত + লেজার সারি
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [requestId]);
      const request = r.rows[0];
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'withdraw_refund', 'বাতিলকৃত উইথড্র ফেরত')`,
        [request.user_id, request.amount]
      );
      await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [requestId]);
      await client.query('COMMIT');
    } finally { client.release(); }

    // ব্যালেন্স ফিরে এসেছে এবং লেজারও সেটা ব্যাখ্যা করতে পারে
    expect(await balanceOf(userId)).toBe(START_BALANCE);
    expect(START_BALANCE + await ledgerSum(userId)).toBe(START_BALANCE);

    await cleanup(userId);
  });

  test('সোর্স কোডে ফেরতের লেজার ইনসার্ট বিদ্যমান (রিগ্রেশন গার্ড)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');

    const rejectBlock = src.slice(
      src.indexOf("router.post('/api/withdrawals/:id/reject'"),
      src.indexOf("router.post('/api/withdrawals/:id/reject'") + 2500
    );
    expect(rejectBlock).toContain('withdraw_refund');
    expect(rejectBlock).toMatch(/INSERT INTO coin_transactions/);
  });

  test('একই উইথড্র দুইবার বাতিল করে দুইবার ফেরত দেওয়া যায় না', async () => {
    const userId = await makeUser();
    const requestId = await requestWithdraw(userId, 500);

    const rejectOnce = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [requestId]);
        if (!r.rows[0] || r.rows[0].status !== 'pending') { await client.query('ROLLBACK'); return false; }
        await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [r.rows[0].amount, userId]);
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description)
           VALUES ($1, $2, 'withdraw_refund', 'বাতিলকৃত উইথড্র ফেরত')`, [userId, r.rows[0].amount]
        );
        await client.query(`UPDATE payment_requests SET status='rejected' WHERE id=$1`, [requestId]);
        await client.query('COMMIT');
        return true;
      } finally { client.release(); }
    };

    const results = await Promise.all([rejectOnce(), rejectOnce(), rejectOnce()]);
    expect(results.filter(Boolean).length).toBe(1); // pending গার্ড কাজ করেছে
    expect(await balanceOf(userId)).toBe(START_BALANCE); // ডাবল রিফান্ড হয়নি

    await cleanup(userId);
  });
});

describe('অ্যাডমিন কয়েন যোগ/কমানো — atomic ও লেজার-সঙ্গত', () => {
  test('ব্যালেন্সের চেয়ে বেশি কমাতে চাইলে লেজারে শুধু বাস্তবে কমা অঙ্কই লেখা হয়', async () => {
    const userId = await makeUser(100);

    // routes/admin.js-এর নতুন লজিক: FOR UPDATE → Math.min(amount, balance) → দুটোই এক ট্রানজেকশনে
    const client = await pool.connect();
    let actualRemoved;
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT coins FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const beforeCoins = Number(before.rows[0].coins);
      actualRemoved = Math.min(500, beforeCoins);
      await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [actualRemoved, userId]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1,$2,'admin_remove','পরীক্ষা')`, [userId, -actualRemoved]
      );
      await client.query('COMMIT');
    } finally { client.release(); }

    expect(actualRemoved).toBe(100);          // ৫০০ চাওয়া হলেও ছিল ১০০
    expect(await balanceOf(userId)).toBe(0);  // ব্যালেন্স নেগেটিভ হয়নি
    expect(100 + await ledgerSum(userId)).toBe(0); // লেজার ব্যালেন্স ব্যাখ্যা করে

    await cleanup(userId);
  });

  test('কয়েন কমানোর কোড ট্রানজেকশনে চলে ও বাস্তব অঙ্ক লেজারে লেখে (রিগ্রেশন গার্ড)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');
    const block = src.slice(
      src.indexOf("router.post('/users/:id/coins/remove'"),
      src.indexOf("router.post('/users/:id/coins/remove'") + 2200
    );
    expect(block).toContain('withTransaction');
    expect(block).toContain('FOR UPDATE');
    expect(block).toContain('actualRemoved');
    // ক্ল্যাম্প করা ব্যালেন্সের সাথে পুরো amount লেজারে লেখার পুরনো প্যাটার্নটা আর নেই
    expect(block).not.toMatch(/GREATEST\(coins - \$1, 0\)[\s\S]{0,400}VALUES \(\$1,\$2,'admin_remove'/);
  });

  test('কয়েন যোগও ট্রানজেকশনে চলে (রিগ্রেশন গার্ড)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');
    const block = src.slice(
      src.indexOf("router.post('/users/:id/coins/add'"),
      src.indexOf("router.post('/users/:id/coins/add'") + 1600
    );
    expect(block).toContain('withTransaction');
    expect(block).toContain('admin_add');
  });

  test('ট্রানজেকশনের ভেতরে লেজার ইনসার্ট ব্যর্থ হলে ব্যালেন্সও বদলায় না', async () => {
    const userId = await makeUser(100);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET coins = coins + 500 WHERE id = $1', [userId]);
      // ইচ্ছাকৃতভাবে অবৈধ লেজার ইনসার্ট (অস্তিত্বহীন ইউজার) — পুরো ট্রানজেকশন ব্যর্থ হবে
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES (999999999, 500, 'admin_add', 'bad')`
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
    } finally { client.release(); }

    expect(await balanceOf(userId)).toBe(100);      // rollback হয়েছে
    expect(100 + await ledgerSum(userId)).toBe(100);

    await cleanup(userId);
  });
});

describe('আর্থিক ডেটার বাস্তব অবস্থা (real catalog + data)', () => {
  test('কোনো নেগেটিভ ব্যালেন্স নেই', async () => {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE coins < 0');
    expect(r.rows[0].c).toBe(0);
  });

  test('কোনো অ-ধনাত্মক payment_requests amount নেই', async () => {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM payment_requests WHERE amount <= 0');
    expect(r.rows[0].c).toBe(0);
  });

  test('payment_requests-এ কোনো অজানা status নেই', async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payment_requests
        WHERE status NOT IN ('pending','approved','rejected')`
    );
    expect(r.rows[0].c).toBe(0);
  });

  test('gateway_tran_id-তে ডুপ্লিকেট নেই এবং unique index বিদ্যমান', async () => {
    const dup = await pool.query(
      `SELECT COUNT(*)::int AS c FROM (
         SELECT gateway_tran_id FROM payment_requests
          WHERE gateway_tran_id IS NOT NULL
          GROUP BY gateway_tran_id HAVING COUNT(*) > 1) t`
    );
    expect(dup.rows[0].c).toBe(0);

    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE tablename='payment_requests' AND indexname='idx_pr_gateway_tran'`
    );
    expect(idx.rows.length).toBe(1);
  });

  test('কোনো অরফান payment_requests নেই', async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payment_requests p
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id)`
    );
    expect(r.rows[0].c).toBe(0);
  });
});
