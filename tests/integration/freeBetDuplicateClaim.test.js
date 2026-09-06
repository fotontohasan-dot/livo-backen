const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const freebet = require('../../services/freebet');

// ==================== Phase 8: free bet claim ====================
//
// claimFreeBet() একটা free bet-এর টাকা ব্যালেন্সে যোগ করে এবং সেটাকে
// 'used' চিহ্নিত করে। duplicate protection না থাকলে একই free bet বারবার
// claim করে টাকা তোলা যেত।
//
// services/freebet.js শর্তটা লক নেওয়ার সময়ই রাখে:
//   SELECT * FROM free_bets WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE
// এটা যথেষ্ট, কিন্তু চূড়ান্ত UPDATE-এ শর্ত ছিল না। Phase 8-এর অন্য চারটে
// service-এ (dailyReward, loyalty, cashback, missions) ঠিক এই জায়গাতেই
// ফাঁক ছিল, তাই এখানেও `AND status = 'active'` যোগ করা হয়েছে —
// defense-in-depth, লকের উপর একমাত্র নির্ভরতা নয়।
//
// user_id শর্তটাও গুরুত্বপূর্ণ: অন্যের free bet id দিয়ে claim করা যায় না।

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'services', 'freebet.js'), 'utf8'
);

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
     VALUES ($1, $2, 'x', 0) RETURNING id`,
    ['fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 9)]
  );
  return r.rows[0].id;
}

async function cleanup(id) {
  for (const { table_name, column_name } of await childTables()) {
    await pool.query(`DELETE FROM ${table_name} WHERE ${column_name} = $1`, [id]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

async function grant(userId, amount) {
  const r = await pool.query(
    `INSERT INTO free_bets (user_id, amount, reason, status)
     VALUES ($1, $2, 'test', 'active') RETURNING id`,
    [userId, amount]
  );
  return r.rows[0].id;
}

describe('Phase 8 — free bet claim duplicate protection', () => {
  jest.setTimeout(60000);

  test('claim শর্তসাপেক্ষ — লকের উপর একমাত্র নির্ভরতা নেই', () => {
    expect(SRC).toMatch(/status = 'used', used_at = NOW\(\) WHERE id = \$1 AND status = 'active'/);
    expect(SRC).toMatch(/AND user_id = \$2 AND status = 'active' FOR UPDATE/);
  });

  test('সমান্তরাল claim-এ ঠিক একবারই টাকা যোগ হয়', async () => {
    const id = await makeUser();
    try {
      const fbId = await grant(id, 250);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          freebet.claimFreeBet(id, fbId, 'bn').catch(() => ({ success: false })))
      );
      expect(results.filter((r) => r && r.success).length).toBe(1);

      // ব্যালেন্স ও ledger একই স্ন্যাপশটে — আলাদা query-তে পড়লে মাঝখানে
      // অন্য কাজ ঢুকে অমিল দেখাতে পারত (আগে দুবার এই ভুল হয়েছে)।
      const snap = await pool.query(
        `SELECT u.coins,
                (SELECT COALESCE(SUM(amount), 0) FROM coin_transactions WHERE user_id = u.id) AS ledger,
                (SELECT status FROM free_bets WHERE id = $2) AS fb_status
         FROM users u WHERE u.id = $1`,
        [id, fbId]
      );
      expect(Number(snap.rows[0].coins)).toBe(250);
      expect(Number(snap.rows[0].ledger)).toBe(250);
      expect(snap.rows[0].fb_status).toBe('used');
    } finally {
      await cleanup(id);
    }
  });

  test('অন্য ব্যবহারকারীর free bet claim করা যায় না', async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    try {
      const fbId = await grant(owner, 500);

      const res = await freebet.claimFreeBet(attacker, fbId, 'bn')
        .catch(() => ({ success: false }));
      expect(res.success).toBe(false);

      const r = await pool.query(
        'SELECT status FROM free_bets WHERE id = $1', [fbId]
      );
      expect(r.rows[0].status).toBe('active');

      const a = await pool.query('SELECT coins FROM users WHERE id = $1', [attacker]);
      expect(Number(a.rows[0].coins)).toBe(0);
    } finally {
      await cleanup(owner);
      await cleanup(attacker);
    }
  });

  test('used free bet আবার claim হয় না', async () => {
    const id = await makeUser();
    try {
      const fbId = await grant(id, 100);
      expect((await freebet.claimFreeBet(id, fbId, 'bn')).success).toBe(true);
      const second = await freebet.claimFreeBet(id, fbId, 'bn')
        .catch(() => ({ success: false }));
      expect(second.success).toBe(false);

      const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
      expect(Number(r.rows[0].coins)).toBe(100);
    } finally {
      await cleanup(id);
    }
  });
});
