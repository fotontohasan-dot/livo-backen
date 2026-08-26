// tests/integration/performanceIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 06 — পারফরম্যান্স ও রিসোর্স দক্ষতা।
//
// এখানে যে বাস্তব সমস্যাগুলো লক করা হচ্ছে (প্রতিটাই EXPLAIN/সোর্স দিয়ে যাচাই করা,
// অনুমান নয়):
//
//   ১. users.last_ip-এ কোনো ইনডেক্স ছিল না, অথচ services/fraudDetection.js
//      প্রতিটা লগইনে `WHERE last_ip = $1 AND created_at > ...` চালায়
//      (rapid-registration যাচাই)। EXPLAIN দেখাত `Seq Scan on users` —
//      অর্থাৎ প্রতি লগইনে পুরো users টেবিল স্ক্যান।
//
//   ২. bank_cards টেবিলে প্রাইমারি কী ছাড়া কোনো ইনডেক্সই ছিল না, অথচ প্রতিটা
//      কোয়েরি user_id দিয়ে ফিল্টার করে (ডিপোজিট/উইথড্র/প্রোফাইল কার্ড পেজ),
//      আর duplicateDetection account_number দিয়ে লুকআপ করে।
//
//   ৩. services/backup.js-এর scheduleDailyBackup() একাধিকবার কল করলে প্রতিবার
//      নতুন setInterval তৈরি করত এবং টাইমারে .unref() ছিল না — ইভেন্ট লুপ
//      জীবিত থাকত। সহোদর scheduleAutoBackup()-এ দুটোই আগে থেকেই ঠিক ছিল।
//
// আসল PostgreSQL-এর বিরুদ্ধে চলে, কোনো mock নেই।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');

const ROOT = path.join(__dirname, '..', '..');

async function planFor(sql, params = []) {
  const r = await pool.query(`EXPLAIN ${sql}`, params);
  return r.rows.map((x) => x['QUERY PLAN']).join('\n');
}

describe('হট-পাথ ইনডেক্স — সিকুয়েনশিয়াল স্ক্যান দূর হয়েছে', () => {
  test('প্রত্যাশিত ইনডেক্সগুলো সত্যিই তৈরি হয়েছে', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE indexname = ANY($1::text[])`,
      [['idx_users_last_ip', 'idx_bank_cards_user', 'idx_bank_cards_account']]
    );
    const found = r.rows.map((x) => x.indexname).sort();
    expect(found).toEqual(['idx_bank_cards_account', 'idx_bank_cards_user', 'idx_users_last_ip']);
  });

  test('প্রতি-লগইন last_ip কোয়েরি আর পুরো users টেবিল স্ক্যান করে না', async () => {
    // fraudDetection.js-এর কোয়েরির হুবহু আকার
    const plan = await planFor(
      `SELECT COUNT(*) FROM users WHERE last_ip = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
      ['203.0.113.9']
    );
    expect(plan).toMatch(/idx_users_last_ip/);
    expect(plan).not.toMatch(/Seq Scan on users/);
  });

  test('bank_cards user_id লুকআপ ইনডেক্স ব্যবহার করে', async () => {
    const plan = await planFor('SELECT id FROM bank_cards WHERE user_id = $1', [1]);
    expect(plan).toMatch(/idx_bank_cards_user/);
    expect(plan).not.toMatch(/Seq Scan on bank_cards/);
  });

  test('last_ip ইনডেক্স partial — NULL সারি অপ্রয়োজনে ইনডেক্সে নেই', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_users_last_ip'`
    );
    expect(r.rows[0].indexdef).toMatch(/WHERE \(last_ip IS NOT NULL\)/);
  });

  test('ইনডেক্স যোগ করেও কোয়েরির ফলাফল অপরিবর্তিত', async () => {
    const u = await pool.query(
      `INSERT INTO users (username, phone, password, last_ip)
       VALUES ('perf_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x', '198.51.100.7')
       RETURNING id`
    );
    const userId = u.rows[0].id;

    const byIp = await pool.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE last_ip = '198.51.100.7'`
    );
    expect(byIp.rows[0].c).toBeGreaterThanOrEqual(1);

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });
});

describe('মাইগ্রেশন idempotency (Phase 06 ইনডেক্সসহ)', () => {
  test('দুইবার চালালেও ডুপ্লিকেট ইনডেক্স তৈরি হয় না', async () => {
    const runMigrations = require('../../migrations');
    await runMigrations();

    const r = await pool.query(
      `SELECT indexname, COUNT(*)::int AS c FROM pg_indexes
        WHERE indexname = ANY($1::text[]) GROUP BY indexname`,
      [['idx_users_last_ip', 'idx_bank_cards_user', 'idx_bank_cards_account']]
    );
    expect(r.rows.length).toBe(3);
    for (const row of r.rows) expect(row.c).toBe(1);
  }, 300000);
});

describe('টাইমার/রিসোর্স লিক — scheduleDailyBackup', () => {
  test('একাধিকবার কল করলেও একটাই ইন্টারভাল তৈরি হয়', () => {
    const { scheduleDailyBackup } = require('../../services/backup');

    const realSetInterval = global.setInterval;
    const realSetTimeout = global.setTimeout;
    let intervals = 0;
    global.setInterval = (...args) => { intervals += 1; return realSetInterval(...args); };
    global.setTimeout = (...args) => realSetTimeout(...args);

    try {
      scheduleDailyBackup();
      scheduleDailyBackup();
      scheduleDailyBackup();
    } finally {
      global.setInterval = realSetInterval;
      global.setTimeout = realSetTimeout;
    }

    expect(intervals).toBeLessThanOrEqual(1); // গার্ড কাজ করেছে
  });

  test('টাইমার unref করা — ইভেন্ট লুপ আটকে রাখে না (রিগ্রেশন গার্ড)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'backup.js'), 'utf8');
    const block = src.slice(
      src.indexOf('function scheduleDailyBackup'),
      src.indexOf('function scheduleDailyBackup') + 900
    );
    expect(block).toMatch(/dailyBackupHandle/);
    expect(block).toMatch(/\.unref\(\)/);
    // গার্ড ছাড়া পুরনো প্যাটার্নটা ফিরে আসেনি
    expect(block).toMatch(/if \(dailyBackupHandle\) return/);
  });

  test('সহোদর scheduleAutoBackup-ও আগের মতোই গার্ডেড ও unref করা', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'backupManager.js'), 'utf8');
    expect(src).toMatch(/if \(scheduleHandle\) return/);
    expect(src).toMatch(/scheduleHandle\.unref/);
  });
});

describe('আনবাউন্ডেড কোয়েরি — গুরুত্বপূর্ণ তালিকাগুলোতে LIMIT আছে', () => {
  test('ইউজারের পেমেন্ট হিস্ট্রি বাউন্ডেড', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'payment.js'), 'utf8');
    const idx = src.indexOf("router.get('/history'");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 3000);
    expect(block).toMatch(/LIMIT/i);
  });

  test('অ্যাডমিন ইউজার-ডিটেইলের পেমেন্ট তালিকা বাউন্ডেড', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');
    expect(src).toMatch(/FROM payment_requests WHERE user_id = \$1 ORDER BY created_at DESC LIMIT \d+/);
  });
});
