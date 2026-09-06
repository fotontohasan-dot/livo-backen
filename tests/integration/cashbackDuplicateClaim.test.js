const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const cashback = require('../../services/cashback');

// ==================== Phase 8: cashback claim ====================
//
// claimCashback() হারানো টাকার একটা অংশ ফেরত দেয়। duplicate protection না
// থাকলে একই দিনের cashback বারবার নেওয়া যেত।
//
// services/cashback.js লক ব্যবহার করে (SELECT ... FOR UPDATE), কিন্তু
// চূড়ান্ত UPDATE-এর শর্ত ছিল শুধু `WHERE id = $1` — অর্থাৎ লকই একমাত্র
// সুরক্ষা। dailyReward ও loyalty-তে ঠিক একই ফাঁক ছিল; এখানেও
// `AND cashback_claimed = false` যোগ করা হয়েছে।

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'services', 'cashback.js'), 'utf8'
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
    ['cb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
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

// cashback পাওয়ার মতো ক্ষতি তৈরি — নাহলে সব claim বৈধভাবেই ব্যর্থ হত এবং
// টেস্টটা "duplicate আটকেছে" বলে মিথ্যা আশ্বাস দিত।
async function seedLoss(userId, category) {
  // claimCashback() গতকালের ক্ষতি দেখে, আজকের নয় — তাই seed-ও গতকালের।
  // আজকের তারিখে seed করলে প্রতিটা claim বৈধভাবেই ব্যর্থ হত এবং টেস্টটা
  // "duplicate আটকেছে" বলে মিথ্যা আশ্বাস দিত।
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const today = d.toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO daily_losses (user_id, loss_date, category, total_bet, total_win)
     VALUES ($1, $2, $3, 100000, 0)
     ON CONFLICT (user_id, loss_date, category)
     DO UPDATE SET total_bet = 100000, total_win = 0, cashback_claimed = false`,
    [userId, today, category]
  );
}

describe('Phase 8 — cashback claim duplicate protection', () => {
  jest.setTimeout(60000);

  const CATEGORY = cashback.CATEGORIES[0];

  test('claim শর্তসাপেক্ষ — লকের উপর একমাত্র নির্ভরতা নেই', () => {
    expect(SRC).toMatch(/cashback_claimed = true WHERE id = \$1 AND cashback_claimed = false/);
    expect(SRC).toMatch(/FOR UPDATE/);
  });

  test('সমান্তরাল claim-এ ঠিক একটাই সফল হয়', async () => {
    const id = await makeUser();
    try {
      await seedLoss(id, CATEGORY);
      const before = await coins(id);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          cashback.claimCashback(id, CATEGORY, 'bn').catch(() => ({ success: false })))
      );

      const ok = results.filter((r) => r && r.success).length;
      expect(ok).toBe(1);

      const after = await coins(id);
      expect(after).toBeGreaterThan(before);

      // ব্যালেন্স বৃদ্ধি ledger এন্ট্রির সমান
      const led = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM coin_transactions WHERE user_id = $1",
        [id]
      );
      expect(after - before).toBe(Number(led.rows[0].total));
    } finally {
      await cleanup(id);
    }
  });

  test('claim করার পরে দ্বিতীয়বার claim ব্যর্থ হয়', async () => {
    const id = await makeUser();
    try {
      await seedLoss(id, CATEGORY);
      const first = await cashback.claimCashback(id, CATEGORY, 'bn');
      expect(first.success).toBe(true);

      const mid = await coins(id);
      const second = await cashback.claimCashback(id, CATEGORY, 'bn');
      expect(second.success).toBe(false);
      expect(await coins(id)).toBe(mid);
    } finally {
      await cleanup(id);
    }
  });
});
