const { pool } = require('../../db');
const accumulator = require('../../services/accumulator');

// ==================== Phase 7: accumulator settlement ====================
//
// roadmap Phase 7-এর দাবি: duplicate settlement হওয়া চলবে না। settlement
// দুবার চললে জেতা accumulator-এর payout দুবার যেত।
//
// settleSelectionsForMarket() একই market-এর জন্য একাধিকবার ডাকা হতে পারে —
// অ্যাডমিন দুবার ক্লিক করলে, বা sports API থেকে একই ফলাফল দুবার এলে।
//
// services/accumulator.js সঠিক প্যাটার্ন ব্যবহার করে: লক নেওয়ার সময়ই শর্ত —
//   SELECT * FROM accumulators WHERE id = $1 AND status = 'pending' FOR UPDATE
// PostgreSQL READ COMMITTED-এ দ্বিতীয় লেনদেন লক পাওয়ার পরে শর্তটা পুনরায়
// যাচাই করে, তাই ততক্ষণে settled সারি বাদ পড়ে যায়।
//
// কোনো টেস্ট এটা সমান্তরালে যাচাই করত না।

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

async function makeUser(coins) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    ['ac_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 9), coins]
  );
  return r.rows[0].id;
}

async function cleanup(id) {
  await pool.query(
    'DELETE FROM accumulator_selections WHERE acca_id IN (SELECT id FROM accumulators WHERE user_id = $1)',
    [id]
  ).catch(() => {});
  for (const { table_name, column_name } of await childTables()) {
    await pool.query(`DELETE FROM ${table_name} WHERE ${column_name} = $1`, [id]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

// accumulator_selections.market_id-তে foreign key আছে, তাই আগে একটা
// সত্যিকারের market (ও তার match) তৈরি করতে হয়।
async function seedMarket() {
  const m = await pool.query(
    `INSERT INTO matches (sport, status) VALUES ('football', 'live') RETURNING id`
  );
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, status)
     VALUES ($1, 'match_odds', 'Match Winner', 'open') RETURNING id`,
    [m.rows[0].id]
  );
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}

// একটাই selection-এর accumulator সরাসরি বসানো — placeAccumulator() খোলা
// market দাবি করে, যা এই টেস্টে তৈরি করা জটিল।
async function seedAcca(userId, marketId, runner) {
  const acca = await pool.query(
    `INSERT INTO accumulators (user_id, stake, total_odd, boost_percent, potential_win, selection_count, status)
     VALUES ($1, 100, 2.0, 0, 200, 1, 'pending') RETURNING id`,
    [userId]
  );
  const accaId = acca.rows[0].id;
  await pool.query(
    `INSERT INTO accumulator_selections (acca_id, market_id, runner, odd, status)
     VALUES ($1, $2, $3, 2.0, 'pending')`,
    [accaId, marketId, runner]
  );
  return accaId;
}

async function settleOnce(marketId, winner) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await accumulator.settleSelectionsForMarket(client, marketId, winner);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

describe('Phase 7 — accumulator settlement একবারের বেশি হয় না', () => {
  jest.setTimeout(60000);

  test('লক নেওয়ার সময়ই status শর্ত আছে', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'services', 'accumulator.js'), 'utf8'
    );
    expect(src).toMatch(/WHERE id = \$1 AND status = 'pending' FOR UPDATE/);
  });

  test('সমান্তরাল settlement-এ payout একবারই যায়', async () => {
    const userId = await makeUser(0);
    try {
      const { marketId } = await seedMarket();
      await seedAcca(userId, marketId, 'HOME');
      const before = await coins(userId);

      await Promise.all(
        Array.from({ length: 5 }, () => settleOnce(marketId, 'HOME'))
      );

      const acc = await pool.query(
        'SELECT status FROM accumulators WHERE user_id = $1', [userId]
      );
      expect(acc.rows[0].status).toBe('won');

      // ব্যালেন্স বৃদ্ধি ledger-এর সমান — দুবার payout হলে মিলত না
      const led = await pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM coin_transactions WHERE user_id = $1',
        [userId]
      );
      expect(await coins(userId) - before).toBe(Number(led.rows[0].total));
    } finally {
      await cleanup(userId);
    }
  });

  test('settled accumulator আবার settle হয় না', async () => {
    const userId = await makeUser(0);
    try {
      const { marketId } = await seedMarket();
      await seedAcca(userId, marketId, 'HOME');

      await settleOnce(marketId, 'HOME');
      const mid = await coins(userId);

      await settleOnce(marketId, 'HOME');
      expect(await coins(userId)).toBe(mid);
    } finally {
      await cleanup(userId);
    }
  });
});
