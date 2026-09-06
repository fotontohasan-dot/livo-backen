const { pool } = require('../../db');

// ==================== Phase 4: প্রকৃত সমান্তরাল ডেবিট ====================
//
// আগের টেস্ট (concurrentBetBalance) HTTP স্তরে সমান্তরাল রিকোয়েস্ট পাঠাত,
// কিন্তু একই supertest agent-এর রিকোয়েস্টগুলো express-session-এর কারণে
// কার্যত সিরিয়ালাইজ হয়ে যেত — তাই `FOR UPDATE` সরিয়ে দিলেও ওটা পাস করত।
//
// এখানে HTTP স্তর বাদ দিয়ে সরাসরি একাধিক pool client নিয়ে সত্যিকারের
// সমান্তরাল ট্রানজেকশন চালানো হয়। দুটো প্যাটার্ন যাচাই হয়:
//
//   ক) শর্তসাপেক্ষ UPDATE — `SET coins = coins - $1 WHERE coins >= $1`
//      (services/accumulator.js যেটা ব্যবহার করে)
//   খ) SELECT ... FOR UPDATE তারপর UPDATE
//      (routes/games.js যেটা ব্যবহার করে)
//
// দুটোই ঠিকঠাক হলে সমান্তরাল ডেবিটে ব্যালেন্স কখনো নেগেটিভ হয় না।
// তুলনার জন্য অনিরাপদ প্যাটার্নটাও (lock ছাড়া read-then-write) চালানো হয়,
// যাতে টেস্টটা সত্যিই race ধরতে পারে কি না তার প্রমাণ থাকে।

const START = 100;
const DEBIT = 40;
const WORKERS = 10;

async function makeRow() {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    ['race_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9), START]
  );
  return r.rows[0].id;
}

async function drop(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

// ক) শর্তসাপেক্ষ UPDATE — একটাই statement, তাই atomic
async function conditionalDebit(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins',
      [DEBIT, id]
    );
    await client.query('COMMIT');
    return r.rowCount === 1;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

// খ) SELECT ... FOR UPDATE — সারিটা লক করে, তাই দ্বিতীয় লেনদেন অপেক্ষা করে
async function lockedDebit(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT coins FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (Number(r.rows[0].coins) < DEBIT) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [DEBIT, id]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

// গ) অনিরাপদ — লক ছাড়া পড়া, তারপর লেখা। তুলনার জন্য।
async function unsafeDebit(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT coins FROM users WHERE id = $1', [id]);
    if (Number(r.rows[0].coins) < DEBIT) {
      await client.query('ROLLBACK');
      return false;
    }
    // ইচ্ছাকৃত বিলম্ব — দুটো লেনদেন যেন একই স্ন্যাপশট পড়ার সুযোগ পায়
    await new Promise((res) => setTimeout(res, 30));
    await client.query('UPDATE users SET coins = $1 WHERE id = $2',
      [Number(r.rows[0].coins) - DEBIT, id]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

describe('Phase 4 — প্রকৃত সমান্তরাল ডেবিট', () => {
  jest.setTimeout(60000);

  test('শর্তসাপেক্ষ UPDATE: ব্যালেন্স নেগেটিভ হয় না, ঠিক ২টা সফল', async () => {
    const id = await makeRow();
    try {
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => conditionalDebit(id))
      );
      const ok = results.filter(Boolean).length;
      expect(await coins(id)).toBe(START - ok * DEBIT);
      expect(await coins(id)).toBeGreaterThanOrEqual(0);
      // ১০০ কয়েনে ৪০ করে ঠিক দুটোই সম্ভব
      expect(ok).toBe(2);
    } finally {
      await drop(id);
    }
  });

  test('SELECT ... FOR UPDATE: ব্যালেন্স নেগেটিভ হয় না, ঠিক ২টা সফল', async () => {
    const id = await makeRow();
    try {
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => lockedDebit(id))
      );
      const ok = results.filter(Boolean).length;
      expect(await coins(id)).toBe(START - ok * DEBIT);
      expect(await coins(id)).toBeGreaterThanOrEqual(0);
      expect(ok).toBe(2);
    } finally {
      await drop(id);
    }
  });

  test('লক ছাড়া read-then-write সত্যিই ভাঙে — টেস্টটা race ধরতে পারে', async () => {
    // এটাই প্রমাণ যে উপরের দুটো টেস্ট অর্থবহ। এই টেস্ট ফেল করা মানে
    // harness-টা সমান্তরালতা তৈরি করতে পারছে না, আর তখন উপরের সবুজ
    // ফলাফলও অর্থহীন।
    const id = await makeRow();
    try {
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => unsafeDebit(id))
      );
      const ok = results.filter(Boolean).length;
      const finalCoins = await coins(id);

      // অনিরাপদ পথে হয় নেগেটিভ ব্যালেন্স, নয় হিসাব মেলে না —
      // অন্তত একটা ঘটতেই হবে।
      const brokenAccounting = finalCoins !== START - ok * DEBIT;
      const overspent = ok > 2;
      expect(brokenAccounting || overspent).toBe(true);
    } finally {
      await drop(id);
    }
  });
});
