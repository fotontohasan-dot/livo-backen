const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const loyalty = require('../../services/loyalty');

// ==================== Phase 8: loyalty redeem ====================
//
// redeemPoints() পয়েন্ট কেটে coins দেয়। সুরক্ষা না থাকলে দ্রুত দুবার
// redeem করে পয়েন্টের চেয়ে বেশি coins নেওয়া যেত — সরাসরি আর্থিক ক্ষতি।
//
// services/loyalty.js লক ব্যবহার করে (SELECT ... FOR UPDATE), কিন্তু
// চূড়ান্ত UPDATE-এর শর্ত ছিল শুধু `WHERE id = $3` — অর্থাৎ লকই একমাত্র
// সুরক্ষা। dailyReward-এর মতোই এখানে `AND loyalty_points >= $1` যোগ করা
// হয়েছে, যাতে লক ব্যর্থ হলেও নেগেটিভ পয়েন্ট তৈরি না হয়।

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'services', 'loyalty.js'), 'utf8'
);

async function makeUser(points) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins, loyalty_points)
     VALUES ($1, $2, 'x', 0, $3) RETURNING id`,
    ['ly_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9), points]
  );
  return r.rows[0].id;
}

async function state(id) {
  const r = await pool.query(
    'SELECT coins, loyalty_points FROM users WHERE id = $1', [id]
  );
  return { coins: Number(r.rows[0].coins), points: Number(r.rows[0].loyalty_points) };
}

async function cleanup(id) {
  for (const t of ['loyalty_ledger', 'coin_transactions', 'notifications']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

describe('Phase 8 — loyalty redeem', () => {
  jest.setTimeout(60000);

  test('redeem শর্তসাপেক্ষ — লকের উপর একমাত্র নির্ভরতা নেই', () => {
    expect(SRC).toMatch(/AND loyalty_points >= \$1/);
    expect(SRC).toMatch(/FOR UPDATE/);
  });

  test('পয়েন্টের চেয়ে বেশি redeem করা যায় না', async () => {
    const id = await makeUser(100);
    try {
      const res = await loyalty.redeemPoints(id, 500, 'bn');
      expect(res.success).toBe(false);
      expect(await state(id)).toEqual({ coins: 0, points: 100 });
    } finally {
      await cleanup(id);
    }
  });

  test('সমান্তরাল redeem-এ পয়েন্ট নেগেটিভ হয় না', async () => {
    const id = await makeUser(100);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          loyalty.redeemPoints(id, 100, 'bn').catch(() => ({ success: false })))
      );
      const ok = results.filter((r) => r && r.success).length;
      expect(ok).toBe(1);

      const after = await state(id);
      expect(after.points).toBe(0);
      expect(after.points).toBeGreaterThanOrEqual(0);
      expect(after.coins).toBeGreaterThan(0);
    } finally {
      await cleanup(id);
    }
  });

  test('redeem করা পয়েন্ট ledger-এ লেখা হয়', async () => {
    const id = await makeUser(100);
    try {
      const res = await loyalty.redeemPoints(id, 100, 'bn');
      expect(res.success).toBe(true);
      const r = await pool.query(
        "SELECT COALESCE(SUM(points), 0) AS total FROM loyalty_ledger WHERE user_id = $1 AND reason = 'redeem'",
        [id]
      );
      expect(Number(r.rows[0].total)).toBe(-100);
    } finally {
      await cleanup(id);
    }
  });
});
