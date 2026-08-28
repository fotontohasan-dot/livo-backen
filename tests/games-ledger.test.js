// tests/games-ledger.test.js
// ---------------------------------------------------------------------------
// routes/games.js POST /play — aviator/crash-game রিয়েল-মানি বেট বসানোর ধাপ।
// আগে ব্যালেন্স কর্তনের UPDATE একটা ট্রানজেকশনে COMMIT হতো, কিন্তু coin_transactions
// লেজার-ইনসার্ট হতো COMMIT-এর পরে, আলাদা অ-await করা pool.query(...).catch(...) হিসেবে।
// অর্থাৎ ব্যালেন্স কর্তন স্থায়ী হয়ে যাওয়ার পরও ওই ইনসার্ট ব্যর্থ হলে ব্যালেন্স-লেজার
// গরমিল স্থায়ীভাবে থেকে যেত। এই টেস্ট নিশ্চিত করে balance delta == ledger delta।
//
// মাস্টার অডিট BUG-002: এই casino_bet এন্ট্রি আগে ধনাত্মক betAmount হিসেবে লেখা হতো,
// অথচ aviator বাজি বসানোর মুহূর্তে এটাই ওই ব্যালেন্স-কর্তনের একমাত্র লেজার রেকর্ড —
// codebase-এর বাকি সব ফ্লো-র মতোই (withdraw, admin add/remove — দেখুন
// tests/integration/financialLedgerIntegrity.test.js) এখানেও debit নেগেটিভ হওয়া উচিত।
// এখন সাইন ঠিক করা হয়েছে বলে আর abs() লাগে না — সরাসরি সমতা যাচাই করা হচ্ছে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  await pool.query('UPDATE users SET coins = 1000 WHERE id=$1', [row.id]);
  return { agent, token, userId: row.id };
}

describe('POST /games/play — aviator বাজি বসানোর লেজার সঙ্গতি', () => {
  test('রিয়েল-মানি aviator বাজিতে balance delta == coin_transactions ledger delta', async () => {
    const U = await makeUser();
    // FLAKE FIX (root cause): routes/games.js এর checkBadges()/missions/streak
    // fire-and-forget promise গুলো response return করার পরেও coin_transactions-এ
    // row যোগ করতে পারে (যেমন first_bet badge = +20)। balance ও ledger আলাদা
    // দুটি query-তে পড়লে সেই row একটিতে ধরা পড়ে, অন্যটিতে নয় (read skew) —
    // ফলে assertion পরিবেশভেদে random fail করে। তাই দুটোই একটিই snapshot
    // query-তে পড়া হয়, যাতে assertion-এর অর্থ অপরিবর্তিত থাকে।
    const snapshot = async (userId) => {
      const r = await pool.query(
        `SELECT (SELECT coins FROM users WHERE id = $1) AS coins,
                (SELECT COALESCE(SUM(amount),0) FROM coin_transactions WHERE user_id = $1) AS ledger`,
        [userId]
      );
      return { coins: Number(r.rows[0].coins), ledger: Number(r.rows[0].ledger) };
    };

    const start = await snapshot(U.userId);
    const before = start.coins;
    const beforeLedger = start.ledger;

    const res = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', amount: 100, demo: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const end = await snapshot(U.userId);
    const after = end.coins;
    const afterLedger = end.ledger;

    const balanceDelta = after - before;
    const ledgerDelta = afterLedger - beforeLedger;
    // badge/mission reward async ভাবে যোগ হতে পারে, তাই মোট delta-র উপর
    // hardcoded -100 assert করা race-prone। প্রকৃত invariant দুটি:
    //   (১) bet ledger row ঠিক -100
    //   (২) balance delta == ledger delta (নিচে)
    const betRow = await pool.query(
      `SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='casino_bet' ORDER BY id DESC LIMIT 1`,
      [U.userId]
    );
    expect(Number(betRow.rows[0].amount)).toBe(-100);
    // casino_bet এখন সঠিক সাইনে (নেগেটিভ) লেখা হয় — ledger delta সরাসরি balance delta-র
    // সমান হওয়া উচিত, abs() workaround ছাড়াই।
    expect(ledgerDelta).toBe(balanceDelta);

    const txCount = await pool.query(
      `SELECT COUNT(*) c FROM coin_transactions WHERE user_id=$1 AND type='casino_bet'`, [U.userId]
    );
    expect(Number(txCount.rows[0].c)).toBe(1);
  });

  test('ledger-ইনসার্ট ব্যর্থ হলে ব্যালেন্স কর্তনও রোলব্যাক হয় (atomicity — আলাদা fire-and-forget নয়)', async () => {
    // আগে balance UPDATE একটা ট্রানজেকশনে COMMIT হয়ে যেত, তারপর coin_transactions ইনসার্ট
    // হতো COMMIT-এর *পরে* আলাদা, অ-await করা pool.query(...).catch(...) দিয়ে — অর্থাৎ সেই
    // ইনসার্ট ব্যর্থ হলেও ব্যালেন্স কর্তন ইতিমধ্যে স্থায়ী, রোলব্যাক অসম্ভব। এই টেস্ট একটা প্রকৃত
    // DB-স্তরের ব্যর্থতা (trigger দিয়ে, শুধু এই টেস্টের ইউজারের জন্য) ইনজেক্ট করে coin_transactions
    // ইনসার্টে, প্রমাণ করতে যে এখন সেটা একই ট্রানজেকশনে (COMMIT-এর আগে) হয় — ব্যর্থ হলে
    // গোটা বাজি-বসানো (balance কর্তনসহ) রোলব্যাক হয়ে যায়, আংশিক-প্রয়োগ সম্ভব না।
    const U = await makeUser();
    const before = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [U.userId])).rows[0].coins);

    await pool.query(`
      CREATE OR REPLACE FUNCTION zz_fail_coin_tx_for_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.user_id = ${U.userId} THEN
          RAISE EXCEPTION 'injected coin_transactions failure (test)';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER zz_fail_coin_tx_trigger BEFORE INSERT ON coin_transactions
      FOR EACH ROW EXECUTE FUNCTION zz_fail_coin_tx_for_test();
    `);

    try {
      const res = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
        .send({ gameSlug: 'aviator', amount: 100, demo: false });
      expect(res.status).toBe(500);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS zz_fail_coin_tx_trigger ON coin_transactions');
      await pool.query('DROP FUNCTION IF EXISTS zz_fail_coin_tx_for_test()');
    }

    const after = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [U.userId])).rows[0].coins);
    expect(after).toBe(before); // রোলব্যাক — ব্যালেন্স অপরিবর্তিত
  });
});

describe('migrations.js Phase 08 — পুরনো ধনাত্মক casino_bet সারি ব্যাকফিল (BUG-002 historical impact)', () => {
  test('ধনাত্মক casino_bet সারি নেগেটিভে ব্যাকফিল হয়, users.coins স্পর্শ করে না, এবং idempotent', async () => {
    const runMigrations = require('../migrations');
    const U = await makeUser();
    const before = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [U.userId])).rows[0].coins);

    // পুরনো (fixed-এর আগের) ধরনে একটা ইচ্ছাকৃত ধনাত্মক casino_bet সারি ইনসার্ট
    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, 250, 'casino_bet', 'legacy positive row')`,
      [U.userId]
    );

    await runMigrations();

    let row = (await pool.query(
      `SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='casino_bet' ORDER BY id DESC LIMIT 1`, [U.userId]
    )).rows[0];
    expect(Number(row.amount)).toBe(-250);

    // দ্বিতীয়বার চালালে আর কিছু বদলায় না (idempotent — শুধু amount > 0 সারি টার্গেট করে)
    await runMigrations();
    row = (await pool.query(
      `SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='casino_bet' ORDER BY id DESC LIMIT 1`, [U.userId]
    )).rows[0];
    expect(Number(row.amount)).toBe(-250);

    // users.coins ব্যাকফিলের কারণে বদলায়নি — এটা শুধু লেজার রিপোর্টিং ঠিক করে, বাস্তব ব্যালেন্স নয়
    const after = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [U.userId])).rows[0].coins);
    expect(after).toBe(before);
  }, 30000);
});
