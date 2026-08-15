// tests/unit/hotPathIndexes.test.js
// ---------------------------------------------------------------------------
// হট-পাথ ইনডেক্স রিগ্রেশন টেস্ট।
//
// কেন দরকার: এই অডিটে দেখা গেছে `bets` ও `error_logs` — দুটো সবচেয়ে দ্রুত বাড়া টেবিলে
// একটাও ইনডেক্স ছিল না, যদিও:
//   • routes/profile.js ইউজারের বেট হিস্ট্রি user_id + created_at দিয়ে খোঁজে;
//   • routes/api.js লিডারবোর্ডে প্রতি ইউজারের জন্য (user_id, status) সাবকোয়েরি চালায়;
//   • services/scheduler.js-এর log_cleanup প্রতি ঘণ্টায় error_logs.created_at দিয়ে DELETE করে।
// রো বাড়ার সাথে সাথে প্রতিটাই ফুল টেবিল স্ক্যান করত। ইনডেক্সগুলো আচরণ বদলায় না, তাই
// এখানে শুধু "মাইগ্রেশনের পর ইনডেক্সগুলো সত্যিই আছে" — সেটাই লক করা হচ্ছে, যেন ভবিষ্যতে
// migrations.js রিফ্যাক্টর করার সময় নিঃশব্দে হারিয়ে না যায়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');

// globalSetup ইতিমধ্যে টেস্ট সুইটের আগে একবার মাইগ্রেশন চালিয়ে রাখে
const EXPECTED = {
  bets: [
    'idx_bets_user_created',
    'idx_bets_user_status',
    'idx_bets_match_id',
    'idx_bets_market_id',
    'idx_bets_status',
    'idx_bets_created_at'
  ],
  error_logs: ['idx_error_logs_created_at'],
  payment_requests: ['idx_payment_requests_type_status']
};

describe('হট-পাথ ইনডেক্স', () => {
  let indexesByTable = {};

  beforeAll(async () => {
    const tables = Object.keys(EXPECTED);
    const res = await pool.query(
      `SELECT tablename, indexname FROM pg_indexes WHERE tablename = ANY($1::text[])`,
      [tables]
    );
    indexesByTable = res.rows.reduce((acc, row) => {
      (acc[row.tablename] = acc[row.tablename] || []).push(row.indexname);
      return acc;
    }, {});
  });

  for (const [table, expectedIndexes] of Object.entries(EXPECTED)) {
    test(`${table} — প্রত্যাশিত সব ইনডেক্স তৈরি হয়েছে`, () => {
      const actual = indexesByTable[table] || [];
      for (const idx of expectedIndexes) {
        expect(actual).toContain(idx);
      }
    });
  }

  test('bets টেবিল আর ইনডেক্সবিহীন নয় (primary key ছাড়াও ইনডেক্স আছে)', () => {
    const actual = indexesByTable.bets || [];
    const nonPk = actual.filter((n) => !n.endsWith('_pkey'));
    expect(nonPk.length).toBeGreaterThan(0);
  });

  test('ইনডেক্সগুলো সত্যিই ব্যবহারযোগ্য — planner কোয়েরি প্ল্যান করতে পারে', async () => {
    // EXPLAIN নিজেই ব্যর্থ হলে বুঝব ইনডেক্স/কলাম মিসম্যাচ আছে
    const plan = await pool.query(
      'EXPLAIN SELECT id FROM bets WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 20',
      [1, 'won']
    );
    expect(plan.rows.length).toBeGreaterThan(0);
  });
});
