// tests/integration/dbQueryPerformance.test.js
// ---------------------------------------------------------------------------
// পোস্ট-মাস্টার-অডিট — Task 3: DB/Query পারফরম্যান্স যাচাই (migrations.js-এর Phase 07)।
//
// প্রতিটা কেসে বাস্তবসম্মত আকারের ডেটা (হাজার হাজার সারি, বহু ভিন্ন created_at/account_number/
// device_signature) সিড করে আসল PostgreSQL-এর বিরুদ্ধে EXPLAIN ANALYZE চালানো হয় — কোনো mock নেই।
// প্রতিটা ইনডেক্সের প্রয়োজনীয়তা প্রমাণ করতে: (১) ইনডেক্স-সহ EXPLAIN ANALYZE Seq Scan দেখায় না,
// (২) ইনডেক্সটা সাময়িকভাবে DROP করে একই কোয়েরি আবার চালালে Seq Scan-এ ফিরে যায় (অর্থাৎ
// ইনডেক্সটাই আসল কারণ, কাকতালীয় নয়), (৩) migrations.js-এর সংজ্ঞা অনুযায়ী ইনডেক্স আবার
// তৈরি করে দেওয়া হয় যাতে বাকি টেস্ট স্যুট প্রভাবিত না হয়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

async function planFor(sql, params = []) {
  const r = await pool.query(`EXPLAIN ANALYZE ${sql}`, params);
  return r.rows.map((x) => x['QUERY PLAN']).join('\n');
}

const SEED_ROWS = 12000;

describe('DB কোয়েরি পারফরম্যান্স — বাস্তবসম্মত ডেটাসহ EXPLAIN ANALYZE', () => {
  let seedUserId;

  beforeAll(async () => {
    // ডুপ্লিকেট-ডিটেকশন কোয়েরির জন্য device_sessions/payment_requests.user_id-এ একটা
    // বৈধ FK দরকার — একটা throwaway ইউজার তৈরি করে তার সাথে সব সিড-করা রো লিংক করা হচ্ছে।
    const u = await pool.query(
      `INSERT INTO users (username, phone, password)
       VALUES ('perfseed_'||floor(random()*1e9), '018'||floor(random()*1e8), 'x')
       RETURNING id`
    );
    seedUserId = u.rows[0].id;

    // users: ~SEED_ROWS সারি, created_at বিগত ২ বছরে ছড়ানো (আজকের তারিখে কোনোটাই নয়,
    // যাতে created_at::date = CURRENT_DATE কোয়েরিটা তুলনামূলকভাবে সিলেক্টিভ থাকে)।
    await pool.query(
      `INSERT INTO users (username, phone, password, created_at)
       SELECT 'perfu_'||g, '017'||lpad(g::text, 8, '0'), 'x',
              NOW() - ((1 + floor(random()*729))::int || ' days')::interval
       FROM generate_series(1, $1) g`,
      [SEED_ROWS]
    );

    // bets: ~SEED_ROWS সারি, একই প্যাটার্নে created_at ছড়ানো।
    await pool.query(
      `INSERT INTO bets (stake, status, created_at)
       SELECT (10 + floor(random()*990))::int,
              (ARRAY['pending','won','lost'])[1 + floor(random()*3)],
              NOW() - ((1 + floor(random()*729))::int || ' days')::interval
       FROM generate_series(1, $1) g`,
      [SEED_ROWS]
    );

    // payment_requests: ~SEED_ROWS সারি, প্রতিটার account_number আলাদা — শুধু একটাতেই
    // 'PERF-TARGET-ACC' বসানো হচ্ছে, যাতে লুকআপটা সিলেক্টিভ থাকে।
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status, created_at)
       SELECT $1, 'deposit', 'manual', 500, 'ACC-'||g, 'pending',
              NOW() - ((1 + floor(random()*29))::int || ' days')::interval
       FROM generate_series(1, $2) g`,
      [seedUserId, SEED_ROWS]
    );
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status)
       VALUES ($1, 'deposit', 'manual', 500, 'PERF-TARGET-ACC', 'pending')`,
      [seedUserId]
    );

    // device_sessions: ~SEED_ROWS সারি, প্রতিটার device_signature/browser+os আলাদা —
    // একটাতেই টার্গেট signature ও ব্রাউজার/OS কম্বিনেশন বসানো হচ্ছে।
    await pool.query(
      `INSERT INTO device_sessions (user_id, sid, device_signature, browser, os)
       SELECT $1, 'perf-sid-'||g, 'sig-'||g, 'Browser'||(g%50), 'OS'||(g%50)
       FROM generate_series(1, $2) g`,
      [seedUserId, SEED_ROWS]
    );
    await pool.query(
      `INSERT INTO device_sessions (user_id, sid, device_signature, browser, os)
       VALUES ($1, 'perf-sid-target', 'PERF-TARGET-SIG', 'PerfTargetBrowser', 'PerfTargetOS')`,
      [seedUserId]
    );

    await pool.query('ANALYZE users');
    await pool.query('ANALYZE bets');
    await pool.query('ANALYZE payment_requests');
    await pool.query('ANALYZE device_sessions');
  }, 120000);

  afterAll(async () => {
    // সিড করা টেস্ট ডেটা পরিষ্কার — বাকি টেস্ট স্যুটের রো-কাউন্ট-নির্ভর অ্যাসারশন
    // (যদি থাকে) প্রভাবিত না হয় তা নিশ্চিত করতে।
    await pool.query(`DELETE FROM device_sessions WHERE sid LIKE 'perf-sid-%'`);
    await pool.query(`DELETE FROM payment_requests WHERE account_number LIKE 'ACC-%' OR account_number = 'PERF-TARGET-ACC'`);
    await pool.query(`DELETE FROM bets WHERE user_id IS NULL AND stake BETWEEN 10 AND 999`);
    await pool.query(`DELETE FROM users WHERE username LIKE 'perfu_%' OR username LIKE 'perfseed_%'`);
  }, 120000);

  describe('users.created_at::date — অ্যাডমিন ড্যাশবোর্ডের "আজকের নতুন ইউজার" কাউন্ট', () => {
    const QUERY = `SELECT COUNT(*) FROM users WHERE created_at::date = CURRENT_DATE`;

    test('idx_users_created_date থাকা অবস্থায় Seq Scan হয় না', async () => {
      const plan = await planFor(QUERY);
      expect(plan).toMatch(/idx_users_created_date/);
      expect(plan).not.toMatch(/Seq Scan on users/);
    });

    test('ইনডেক্স সরালে Seq Scan-এ ফিরে যায় (প্রমাণ করে ইনডেক্সটাই কারণ) — পুনরায় তৈরি করলে ঠিক হয়', async () => {
      await pool.query('DROP INDEX IF EXISTS idx_users_created_date');
      await pool.query('ANALYZE users');
      const withoutIndex = await planFor(QUERY);
      expect(withoutIndex).toMatch(/Seq Scan on users/);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_users_created_date ON users((created_at::date))');
      await pool.query('ANALYZE users');
      const withIndex = await planFor(QUERY);
      expect(withIndex).toMatch(/idx_users_created_date/);
      expect(withIndex).not.toMatch(/Seq Scan on users/);
    });
  });

  describe('bets.created_at::date — অ্যাডমিন ড্যাশবোর্ডের "আজকের স্টেক" যোগফল', () => {
    const QUERY = `SELECT COALESCE(SUM(stake),0) FROM bets WHERE created_at::date = CURRENT_DATE`;

    test('idx_bets_created_date থাকা অবস্থায় Seq Scan হয় না', async () => {
      const plan = await planFor(QUERY);
      expect(plan).toMatch(/idx_bets_created_date/);
      expect(plan).not.toMatch(/Seq Scan on bets/);
    });

    test('ইনডেক্স সরালে Seq Scan-এ ফিরে যায় — পুনরায় তৈরি করলে ঠিক হয়', async () => {
      await pool.query('DROP INDEX IF EXISTS idx_bets_created_date');
      await pool.query('ANALYZE bets');
      const withoutIndex = await planFor(QUERY);
      expect(withoutIndex).toMatch(/Seq Scan on bets/);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_bets_created_date ON bets((created_at::date))');
      await pool.query('ANALYZE bets');
      const withIndex = await planFor(QUERY);
      expect(withIndex).toMatch(/idx_bets_created_date/);
      expect(withIndex).not.toMatch(/Seq Scan on bets/);
    });
  });

  describe('payment_requests.account_number — ডুপ্লিকেট-অ্যাকাউন্ট ডিটেকশন লুকআপ', () => {
    const QUERY = `SELECT user_id FROM payment_requests WHERE account_number = $1`;

    test('idx_pr_account_number থাকা অবস্থায় Seq Scan হয় না', async () => {
      const plan = await planFor(QUERY, ['PERF-TARGET-ACC']);
      expect(plan).toMatch(/idx_pr_account_number/);
      expect(plan).not.toMatch(/Seq Scan on payment_requests/);
    });

    test('ইনডেক্স সরালে Seq Scan-এ ফিরে যায় — পুনরায় তৈরি করলে ঠিক হয়', async () => {
      await pool.query('DROP INDEX IF EXISTS idx_pr_account_number');
      await pool.query('ANALYZE payment_requests');
      const withoutIndex = await planFor(QUERY, ['PERF-TARGET-ACC']);
      expect(withoutIndex).toMatch(/Seq Scan on payment_requests/);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_pr_account_number ON payment_requests(account_number)');
      await pool.query('ANALYZE payment_requests');
      const withIndex = await planFor(QUERY, ['PERF-TARGET-ACC']);
      expect(withIndex).toMatch(/idx_pr_account_number/);
      expect(withIndex).not.toMatch(/Seq Scan on payment_requests/);
    });
  });

  describe('payment_requests.created_at — /admin/transactions আনফিল্টার্ড সর্ট', () => {
    const QUERY = `SELECT id FROM payment_requests ORDER BY created_at DESC LIMIT 20`;

    test('idx_pr_created_at থাকা অবস্থায় ফুল-টেবিল সর্ট এড়ানো যায়', async () => {
      const plan = await planFor(QUERY);
      expect(plan).toMatch(/idx_pr_created_at/);
    });

    test('ইনডেক্স সরালে সিকুয়েনশিয়াল স্ক্যান+সর্ট লাগে — পুনরায় তৈরি করলে ঠিক হয়', async () => {
      await pool.query('DROP INDEX IF EXISTS idx_pr_created_at');
      await pool.query('ANALYZE payment_requests');
      const withoutIndex = await planFor(QUERY);
      expect(withoutIndex).not.toMatch(/idx_pr_created_at/);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_pr_created_at ON payment_requests(created_at DESC)');
      await pool.query('ANALYZE payment_requests');
      const withIndex = await planFor(QUERY);
      expect(withIndex).toMatch(/idx_pr_created_at/);
    });
  });

  describe('device_sessions.device_signature — একই ডিভাইসে অন্য অ্যাকাউন্ট আছে কিনা', () => {
    const QUERY = `SELECT DISTINCT user_id FROM device_sessions WHERE device_signature = $1 AND user_id IS NOT NULL AND user_id != $2`;

    test('idx_device_sessions_signature থাকা অবস্থায় Seq Scan হয় না', async () => {
      const plan = await planFor(QUERY, ['PERF-TARGET-SIG', -1]);
      expect(plan).toMatch(/idx_device_sessions_signature/);
      expect(plan).not.toMatch(/Seq Scan on device_sessions/);
    });

    test('ইনডেক্স সরালে Seq Scan-এ ফিরে যায় — পুনরায় তৈরি করলে ঠিক হয়', async () => {
      await pool.query('DROP INDEX IF EXISTS idx_device_sessions_signature');
      await pool.query('ANALYZE device_sessions');
      const withoutIndex = await planFor(QUERY, ['PERF-TARGET-SIG', -1]);
      expect(withoutIndex).toMatch(/Seq Scan on device_sessions/);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_device_sessions_signature ON device_sessions(device_signature)');
      await pool.query('ANALYZE device_sessions');
      const withIndex = await planFor(QUERY, ['PERF-TARGET-SIG', -1]);
      expect(withIndex).toMatch(/idx_device_sessions_signature/);
      expect(withIndex).not.toMatch(/Seq Scan on device_sessions/);
    });
  });

  describe('device_sessions(browser, os) — একই ব্রাউজার/OS-এ অন্য অ্যাকাউন্ট আছে কিনা', () => {
    const QUERY = `SELECT DISTINCT user_id FROM device_sessions WHERE browser = $1 AND os = $2 AND user_id IS NOT NULL AND user_id != $3`;

    test('idx_device_sessions_browser_os থাকা অবস্থায় Seq Scan হয় না', async () => {
      const plan = await planFor(QUERY, ['PerfTargetBrowser', 'PerfTargetOS', -1]);
      expect(plan).toMatch(/idx_device_sessions_browser_os/);
      expect(plan).not.toMatch(/Seq Scan on device_sessions/);
    });

    test('ইনডেক্স সরালে Seq Scan-এ ফিরে যায় — পুনরায় তৈরি করলে ঠিক হয়', async () => {
      await pool.query('DROP INDEX IF EXISTS idx_device_sessions_browser_os');
      await pool.query('ANALYZE device_sessions');
      const withoutIndex = await planFor(QUERY, ['PerfTargetBrowser', 'PerfTargetOS', -1]);
      expect(withoutIndex).toMatch(/Seq Scan on device_sessions/);

      await pool.query('CREATE INDEX IF NOT EXISTS idx_device_sessions_browser_os ON device_sessions(browser, os)');
      await pool.query('ANALYZE device_sessions');
      const withIndex = await planFor(QUERY, ['PerfTargetBrowser', 'PerfTargetOS', -1]);
      expect(withIndex).toMatch(/idx_device_sessions_browser_os/);
      expect(withIndex).not.toMatch(/Seq Scan on device_sessions/);
    });
  });

  describe('মাইগ্রেশন idempotency — Phase 07 ইনডেক্সসহ দ্বিতীয়বার চালালেও ডুপ্লিকেট হয় না', () => {
    test('সব Phase 07 ইনডেক্স দ্বিতীয়বার migrate করলেও একবারই থাকে', async () => {
      const runMigrations = require('../../migrations');
      await runMigrations();

      const names = [
        'idx_users_created_date', 'idx_bets_created_date', 'idx_pr_account_number',
        'idx_pr_created_at', 'idx_device_sessions_signature', 'idx_device_sessions_browser_os'
      ];
      const r = await pool.query(
        `SELECT indexname, COUNT(*)::int AS c FROM pg_indexes WHERE indexname = ANY($1::text[]) GROUP BY indexname`,
        [names]
      );
      expect(r.rows.length).toBe(names.length);
      for (const row of r.rows) expect(row.c).toBe(1);
    }, 300000);
  });

  describe('আনবাউন্ডেড কোয়েরি — /payment/admin/payments এখন LIMIT সহ', () => {
    test('routes/payment.js-এর admin/payments লিস্টিং কোয়েরি বাউন্ডেড', () => {
      const src = fs.readFileSync(path.join(ROOT, 'routes', 'payment.js'), 'utf8');
      const idx = src.indexOf("router.get('/admin/payments'");
      expect(idx).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 500);
      expect(block).toMatch(/LIMIT/i);
    });
  });
});
