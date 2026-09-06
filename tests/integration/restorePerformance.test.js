// tests/integration/restorePerformance.test.js
// ---------------------------------------------------------------------------
// রিস্টোর পারফরম্যান্স — ব্যাচড multi-row INSERT।
//
// Measured (আগে): 10,000 users + 20,000 coin_transactions রিস্টোর করতে ৩০,৭৭৫টা
// কোয়েরি ও ১৭.১ সেকেন্ড লাগত (row-by-row, প্রতি row-এ এক round-trip)।
// এখন (ব্যাচপ্রতি ৫০০ সারির multi-row INSERT): একই ডেটাসেটে ৮৬টা কোয়েরি, ~১.৪ সেকেন্ড।
//
// এই টেস্ট নিশ্চিত করে:
//   ১) বাস্তব স্কেলে কোয়েরি সংখ্যা row-count-এর সাথে লিনিয়ারভাবে বাড়ে না।
//   ২) ব্যাচড রিস্টোরের পরেও row-লেভেল ডেটা ইন্টিগ্রিটি অক্ষত (সব সারি ফিরে আসে)।
//   ৩) কোনো ব্যাচে সমস্যা হলে (batch INSERT ব্যর্থ) সেই ব্যাচ পুরোপুরি হারায় না —
//      row-by-row fallback দিয়ে সুস্থ সারিগুলো আলাদাভাবে ইনসার্ট হয় (আগের মতোই)।
//
// আসল PostgreSQL ব্যবহার করা হয়েছে।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const backupManager = require('../../services/backupManager');

const ROOT = path.join(__dirname, '..', '..');

describe('রিস্টোর পারফরম্যান্স — ব্যাচড INSERT', () => {
  test('সোর্সে ব্যাচিং প্রয়োগ করা আছে (regression guard)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'backupManager.js'), 'utf8');
    expect(src).toMatch(/BATCH_SIZE\s*=\s*500/);
    expect(src).toMatch(/VALUES \$\{tuples\.join/);
  });

  test('৩,০০০ সারির রিস্টোরে কোয়েরি সংখ্যা row-count-এর তুলনায় অনেক কম, ও সব ডেটা অক্ষত ফিরে আসে', async () => {
    const N = 3000;
    await pool.query(`DELETE FROM users WHERE username LIKE 'restperf_%'`); // পূর্ববর্তী ব্যর্থ রানের অবশিষ্টাংশ থাকলে সাফ করা হয়
    await pool.query(`
      INSERT INTO users (username, phone, password, coins, created_at)
      SELECT 'restperf_' || g, '18' || lpad(g::text, 9, '0'), 'x', 50, NOW()
      FROM generate_series(1, $1) g
    `, [N]);

    const record = await backupManager.createDatabaseBackup({ source: 'manual' });
    expect(record.status).toBe('completed');

    await pool.query(`DELETE FROM users WHERE username LIKE 'restperf_%'`);

    const original = pool.query.bind(pool);
    let queries = 0;
    pool.query = (...args) => { queries += 1; return original(...args); };
    let results;
    try {
      results = await backupManager.restoreBackup(record);
    } finally {
      pool.query = original;
    }

    // আগে হতো N (৩০০০) + অন্যান্য টেবিল ইটারেশন; ব্যাচিং-এ ৬টা ব্যাচ (৫০০/ব্যাচ) + সামান্য
    // ওভারহেড — উদারভাবে ১০০-এর নিচে থাকা উচিত (row-by-row হলে হাজারের বেশি হতো)
    // আসল দাবি: কোয়েরি সংখ্যা সারির সংখ্যার সাথে লিনিয়ার নয় (ব্যাচড
    // INSERT ব্যবহার হয়, row-by-row নয়)।
    //
    // আগে এটা `queries < 100` দিয়ে যাচাই হত, কিন্তু restoreBackup() সব
    // টেবিল ঘোরে — তাই সংখ্যাটা ডেটাবেসে কতগুলো টেবিলে সারি আছে তার সাথেও
    // বাড়ে। টেস্ট-DB পুনর্ব্যবহার করলে (CI-তে যেমন হয়) সংখ্যাটা ১০০ ছাড়িয়ে
    // যেত এবং টেস্ট ফ্লেক করত, যদিও restore কোডে কোনো সমস্যা নেই।
    //
    // এখন সীমাটা N-সাপেক্ষ: row-by-row হলে কোয়েরি সংখ্যা N-এর কাছাকাছি
    // হত (৩০০০+); ব্যাচড হলে N/BATCH_SIZE + টেবিল-প্রতি ধ্রুবক ওভারহেড।
    // N/10 সীমাটা দুটোর মাঝে অনেক দূরে, তাই টেবিল জমলেও ভাঙে না কিন্তু
    // row-by-row-এ ফিরে গেলে সাথে সাথে ধরা পড়ে।
    expect(queries).toBeLessThan(N / 10);
    expect(results.users).toBe(N);

    const check = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE username LIKE 'restperf_%'`);
    expect(check.rows[0].c).toBe(N);

    await pool.query(`DELETE FROM users WHERE username LIKE 'restperf_%'`);
    await pool.query('DELETE FROM backup_history WHERE id = $1', [record.id]);
    fs.unlinkSync(backupManager.getBackupFilePath(record));
  }, 60000);

  test('ব্যাচ INSERT ব্যর্থ হলে row-by-row fallback দিয়ে সুস্থ সারিগুলো হারায় না', async () => {
    const N = 5;
    await pool.query(`DELETE FROM users WHERE username LIKE 'restfb_%'`); // পূর্ববর্তী ব্যর্থ রানের অবশিষ্টাংশ থাকলে সাফ করা হয়
    await pool.query(`
      INSERT INTO users (username, phone, password, coins, created_at)
      SELECT 'restfb_' || g, '17' || lpad(g::text, 9, '0'), 'x', 50, NOW()
      FROM generate_series(1, $1) g
    `, [N]);

    let record;
    try {
      record = await backupManager.createDatabaseBackup({ source: 'manual' });
      expect(record.status).toBe('completed');

      await pool.query(`DELETE FROM users WHERE username LIKE 'restfb_%'`);

      const original = pool.query.bind(pool);
      let batchAttempted = false;
      pool.query = (sql, ...rest) => {
        // multi-row ব্যাচ INSERT শনাক্ত করে (একাধিক tuple), একবার কৃত্রিমভাবে ব্যর্থ করা হয়
        if (typeof sql === 'string' && sql.includes('INSERT INTO "users"') && sql.includes('), (') && !batchAttempted) {
          batchAttempted = true;
          return Promise.reject(new Error('simulated batch insert failure'));
        }
        return original(sql, ...rest);
      };
      let results;
      try {
        results = await backupManager.restoreBackup(record);
      } finally {
        pool.query = original;
      }

      expect(batchAttempted).toBe(true); // নিশ্চিত হওয়া যে fallback পথটাই পরীক্ষিত হয়েছে
      expect(results.users).toBe(N); // ব্যাচ ব্যর্থ হলেও row-by-row fallback সব সারি উদ্ধার করেছে

      const check = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE username LIKE 'restfb_%'`);
      expect(check.rows[0].c).toBe(N);
    } finally {
      await pool.query(`DELETE FROM users WHERE username LIKE 'restfb_%'`);
      if (record) {
        await pool.query('DELETE FROM backup_history WHERE id = $1', [record.id]);
        try { fs.unlinkSync(backupManager.getBackupFilePath(record)); } catch (e) {}
      }
    }
  });
});
