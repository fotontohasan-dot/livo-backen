// tests/games-ledger.test.js
// ---------------------------------------------------------------------------
// routes/games.js POST /play — aviator/crash-game রিয়েল-মানি বেট বসানোর ধাপ।
// আগে ব্যালেন্স কর্তনের UPDATE একটা ট্রানজেকশনে COMMIT হতো, কিন্তু coin_transactions
// লেজার-ইনসার্ট হতো COMMIT-এর পরে, আলাদা অ-await করা pool.query(...).catch(...) হিসেবে।
// অর্থাৎ ব্যালেন্স কর্তন স্থায়ী হয়ে যাওয়ার পরও ওই ইনসার্ট ব্যর্থ হলে ব্যালেন্স-লেজার
// গরমিল স্থায়ীভাবে থেকে যেত। এই টেস্ট নিশ্চিত করে balance delta == ledger delta।
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
    const before = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [U.userId])).rows[0].coins);
    const beforeLedger = Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS sum FROM coin_transactions WHERE user_id=$1`, [U.userId]
    )).rows[0].sum);

    const res = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', amount: 100, demo: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [U.userId])).rows[0].coins);
    const afterLedger = Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS sum FROM coin_transactions WHERE user_id=$1`, [U.userId]
    )).rows[0].sum);

    const balanceDelta = after - before;
    const ledgerDelta = afterLedger - beforeLedger;
    expect(balanceDelta).toBe(-100);
    // লেজারে casino_bet এন্ট্রি positive amount(betAmount) হিসেবে লেখা হয় (staked amount রেকর্ড),
    // কিন্তু আসল ব্যালেন্স-ইফেক্ট নেগেটিভ — তাই এখানে abs তুলনা: এন্ট্রি সত্যিই লেখা হয়েছে কিনা যাচাই।
    expect(Math.abs(ledgerDelta)).toBe(Math.abs(balanceDelta));

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
