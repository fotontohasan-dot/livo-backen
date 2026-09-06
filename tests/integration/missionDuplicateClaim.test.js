const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const missions = require('../../services/missions');

// ==================== Phase 8: mission claim ====================
//
// claimMission() একটা mission-এর পুরস্কার দেয় এবং mission id-টা
// user_missions.claimed_ids অ্যারেতে যোগ করে।
//
// লক ছিল (SELECT ... FOR UPDATE), কিন্তু চূড়ান্ত UPDATE-এর শর্ত ছিল শুধু
// `WHERE id = $2` — অর্থাৎ লকই একমাত্র সুরক্ষা, আর array_append নিজে
// idempotent নয়: একই id দুবার যোগ হলে দুবার পুরস্কারও যেত।
//
// এটা Phase 8-এর চতুর্থ service যেখানে ঠিক একই ফাঁক পাওয়া গেল
// (dailyReward, loyalty, cashback-এর পরে)। শর্তটা এখন UPDATE-এই:
//   AND NOT ($1 = ANY(COALESCE(claimed_ids, ARRAY[]::int[])))

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'services', 'missions.js'), 'utf8'
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
    ['ms_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
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

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

async function dailyMission() {
  const r = await pool.query(
    "SELECT * FROM mission_defs WHERE period = 'daily' AND active = true ORDER BY id LIMIT 1"
  );
  return r.rows[0];
}

// mission পূরণ করার মতো progress বসানো — নাহলে claim বৈধভাবেই ব্যর্থ হত
// এবং টেস্টটা "duplicate আটকেছে" বলে মিথ্যা আশ্বাস দিত।
async function seedProgress(userId, def) {
  const today = new Date().toISOString().slice(0, 10);
  const betCount = def.target_type === 'bet_count' ? Number(def.target_value) + 10 : 0;
  const turnover = def.target_type === 'bet_count' ? 0 : Number(def.target_value) + 1000;
  await pool.query(
    `INSERT INTO user_missions (user_id, mission_date, bet_count, turnover, claimed_ids)
     VALUES ($1, $2, $3, $4, ARRAY[]::int[])
     ON CONFLICT (user_id, mission_date)
     DO UPDATE SET bet_count = $3, turnover = $4, claimed_ids = ARRAY[]::int[]`,
    [userId, today, betCount, turnover]
  );
}

describe('Phase 8 — mission claim duplicate protection', () => {
  jest.setTimeout(60000);

  test('claim শর্তসাপেক্ষ — array_append লকের উপর একা নির্ভর করে না', () => {
    expect(SRC).toMatch(/NOT \(\$1 = ANY\(COALESCE\(claimed_ids/);
    expect(SRC).toMatch(/FOR UPDATE/);
  });

  test('সমান্তরাল claim-এ ঠিক একটাই সফল হয়', async () => {
    const def = await dailyMission();
    if (!def) return; // কোনো daily mission না থাকলে যাচাইয়ের কিছু নেই
    const id = await makeUser();
    try {
      await seedProgress(id, def);
      const before = await coins(id);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          missions.claimMission(id, def.id, 'bn').catch(() => ({ success: false })))
      );

      expect(results.filter((r) => r && r.success).length).toBe(1);

      // claimed_ids-এ id ঠিক একবার
      const um = await pool.query(
        'SELECT claimed_ids FROM user_missions WHERE user_id = $1', [id]
      );
      const ids = um.rows[0].claimed_ids || [];
      expect(ids.filter((x) => Number(x) === Number(def.id)).length).toBe(1);

      // ব্যালেন্স বৃদ্ধি ledger-এর সমান
      const led = await pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM coin_transactions WHERE user_id = $1', [id]
      );
      expect(await coins(id) - before).toBe(Number(led.rows[0].total));
    } finally {
      await cleanup(id);
    }
  });

  test('claim করার পরে দ্বিতীয়বার claim ব্যর্থ হয়', async () => {
    const def = await dailyMission();
    if (!def) return;
    const id = await makeUser();
    try {
      await seedProgress(id, def);
      const first = await missions.claimMission(id, def.id, 'bn');
      expect(first.success).toBe(true);

      const mid = await coins(id);
      const second = await missions.claimMission(id, def.id, 'bn');
      expect(second.success).toBe(false);
      expect(await coins(id)).toBe(mid);
    } finally {
      await cleanup(id);
    }
  });
});
