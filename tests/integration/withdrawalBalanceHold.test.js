const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');

// ==================== Phase 6: withdrawal balance hold ====================
//
// roadmap Phase 6-এর দাবি: ব্যালেন্স hold ও concurrent withdrawal protection।
//
// /payment/withdraw ব্যালেন্স থেকে টাকা কেটে একটা pending payment_request
// তৈরি করে। সুরক্ষা না থাকলে দুটো সমান্তরাল রিকোয়েস্ট একই টাকা দুবার
// hold করতে পারত — ব্যালেন্স নেগেটিভ হয়ে যেত, আর অ্যাডমিন দুটোই approve
// করলে প্রাপ্যের দ্বিগুণ টাকা বেরোত।
//
// routes/payment.js সঠিক প্যাটার্ন ব্যবহার করে — একটাই atomic শর্তসাপেক্ষ
// UPDATE:
//   UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins
// rowCount 0 পেলে অপর্যাপ্ত ব্যালেন্স ধরে বাতিল হয়। কোনো টেস্ট এটা
// সমান্তরালে যাচাই করত না।
//
// HTTP স্তর ব্যবহার করা হয়নি: রুটটা withdraw PIN, KYC, withdrawal window ও
// verified email দাবি করে; সেগুলো সাজানো এই টেস্টের বিষয় নয়। তাই hold-এর
// ট্রানজেকশন প্যাটার্নটাই সরাসরি pool client দিয়ে চালানো হয়।

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'routes', 'payment.js'), 'utf8'
);

const START = 1000;
const AMOUNT = 400;
const WORKERS = 8;

async function childTables() {
  const r = await pool.query(`
    SELECT DISTINCT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users' AND ccu.column_name = 'id'
  `);
  return r.rows;
}

async function makeUser() {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    ['wh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 9), START]
  );
  return r.rows[0].id;
}

async function cleanup(id) {
  for (const { table_name, column_name } of await childTables()) {
    await pool.query(`DELETE FROM ${table_name} WHERE ${column_name} = $1`, [id]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

// routes/payment.js-এর hold প্যাটার্ন
async function holdWithdrawal(userId, amount, { conditional = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let ok;
    if (conditional) {
      const r = await client.query(
        'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins',
        [amount, userId]
      );
      ok = r.rowCount === 1;
    } else {
      // তুলনার জন্য অনিরাপদ পথ: লক ছাড়া পড়া, তারপর লেখা
      const r = await client.query('SELECT coins FROM users WHERE id = $1', [userId]);
      if (Number(r.rows[0].coins) < amount) ok = false;
      else {
        await new Promise((res) => setTimeout(res, 30));
        await client.query('UPDATE users SET coins = $1 WHERE id = $2',
          [Number(r.rows[0].coins) - amount, userId]);
        ok = true;
      }
    }
    if (!ok) { await client.query('ROLLBACK'); return false; }

    await client.query(
      `INSERT INTO payment_requests (user_id, type, amount, status, method)
       VALUES ($1, 'withdraw', $2, 'pending', 'bkash')`,
      [userId, amount]
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

describe('Phase 6 — withdrawal balance hold', () => {
  jest.setTimeout(60000);

  test('রুটে শর্তসাপেক্ষ atomic ডেবিট ব্যবহার হয়', () => {
    expect(SRC).toMatch(/UPDATE users SET coins = coins - \$1 WHERE id = \$2 AND coins >= \$1/);
  });

  test('রুটে withdraw PIN যাচাই ডেবিটের আগেই হয়', () => {
    // PIN যাচাই ডেবিটের পরে হলে ভুল PIN দিয়েও টাকা hold হয়ে যেত।
    const pinIdx = SRC.indexOf('verifyPin(userId');
    const debitIdx = SRC.indexOf('UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1');
    expect(pinIdx).toBeGreaterThan(-1);
    expect(debitIdx).toBeGreaterThan(-1);
    expect(pinIdx).toBeLessThan(debitIdx);
  });

  test('সমান্তরাল withdrawal-এ ব্যালেন্স নেগেটিভ হয় না', async () => {
    const id = await makeUser();
    try {
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => holdWithdrawal(id, AMOUNT))
      );
      const ok = results.filter(Boolean).length;

      // ১০০০ কয়েনে ৪০০ করে ঠিক দুটোই সম্ভব
      expect(ok).toBe(2);

      const snap = await pool.query(
        `SELECT u.coins,
                (SELECT COALESCE(SUM(amount), 0) FROM payment_requests
                  WHERE user_id = u.id AND type = 'withdraw' AND status = 'pending') AS held
         FROM users u WHERE u.id = $1`,
        [id]
      );
      const coins = Number(snap.rows[0].coins);
      const held = Number(snap.rows[0].held);

      expect(coins).toBeGreaterThanOrEqual(0);
      // কাটা টাকা আর hold করা টাকা মিলতে হবে
      expect(START - coins).toBe(held);
    } finally {
      await cleanup(id);
    }
  });

  test('লক/শর্ত ছাড়া প্যাটার্ন সত্যিই ভাঙে — টেস্টটা race ধরে', async () => {
    const id = await makeUser();
    try {
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () =>
          holdWithdrawal(id, AMOUNT, { conditional: false }))
      );
      const ok = results.filter(Boolean).length;
      const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
      const coins = Number(r.rows[0].coins);

      // হয় প্রাপ্যের বেশি hold, নয় হিসাব মেলে না — অন্তত একটা ঘটবেই
      expect(ok > 2 || START - coins !== ok * AMOUNT).toBe(true);
    } finally {
      await cleanup(id);
    }
  });
});
