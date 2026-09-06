const { pool } = require('../../db');
const dailyReward = require('../../services/dailyReward');

// ==================== Phase 8: reward claim duplicate protection ====================
//
// roadmap Phase 8-এর দাবি: প্রতিটা reward claim-এ duplicate protection ও
// transaction safety থাকতে হবে।
//
// services/dailyReward.js সঠিক প্যাটার্ন ব্যবহার করে —
// BEGIN + SELECT ... FOR UPDATE + row.claimed হলে বাতিল। ব্যবহারকারী দ্রুত
// দুবার ক্লিক করলে বা দুটো ট্যাব থেকে একসাথে claim করলে দ্বিতীয় লেনদেন
// প্রথমটার লকের জন্য অপেক্ষা করে, তারপর claimed=true দেখে থেমে যায়।
//
// সুরক্ষা না থাকলে একই দিনের reward একাধিকবার নেওয়া যেত — সরাসরি আর্থিক
// ক্ষতি, আর একটা সহজে আবিষ্কারযোগ্য অপব্যবহার।
//
// এখানে HTTP নয়, service ফাংশনটাই সরাসরি সমান্তরালে ডাকা হয় — একই
// সেশনের HTTP রিকোয়েস্ট express-session-এর কারণে সিরিয়ালাইজ হয়ে যেত এবং
// race তৈরিই হত না।
//
// ⚠️ সীমা: মিউটেশন যাচাইয়ে FOR UPDATE সরিয়ে দিলেও এই টেস্ট পাস করে —
// অর্থাৎ এটা row lock-এর অনুপস্থিতি ধরতে পারে না। তাই লকের উপর একমাত্র
// নির্ভরতা কমাতে UPDATE-এ `AND claimed = false` শর্তটা যোগ করা হয়েছে
// (নিচের টেস্টটা সেটাই আটকে রাখে)। এখন duplicate claim দুই স্তরে আটকায়:
// লক, আর শর্তসাপেক্ষ UPDATE।

const WORKERS = 6;

async function makeUser(coins = 0) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    ['dr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9), coins]
  );
  return r.rows[0].id;
}

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

async function cleanup(userId) {
  for (const t of ['user_daily_rewards', 'coin_transactions', 'notifications']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

// claim করার মতো turnover তৈরি — নাহলে সব claim বৈধভাবেই ব্যর্থ হত
// এবং টেস্টটা "duplicate আটকেছে" বলে মিথ্যা আশ্বাস দিত।
async function seedTurnover(userId, amount) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO user_daily_rewards (user_id, reward_date, sports_turnover)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, reward_date)
     DO UPDATE SET sports_turnover = EXCLUDED.sports_turnover`,
    [userId, today, amount]
  );
}

describe('Phase 8 — daily reward একবারের বেশি claim হয় না', () => {
  jest.setTimeout(60000);

  test('সমান্তরাল claim-এ ঠিক একটাই সফল হয়', async () => {
    const userId = await makeUser();
    try {
      await seedTurnover(userId, 1000000);

      const status = await dailyReward.getTodayReward(userId);
      if (!status.currentTier) {
        // turnover যথেষ্ট না হলে টেস্টটা অর্থহীন — সেটা লুকানো চলবে না
        throw new Error('turnover seed যথেষ্ট নয়, কোনো tier পাওয়া যায়নি');
      }

      const before = await coins(userId);
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () =>
          dailyReward.claimDailyReward(userId, 'bn').catch(() => ({ success: false })))
      );

      const ok = results.filter((r) => r && r.success).length;
      expect(ok).toBe(1);

      // ব্যালেন্সে ঠিক একবারের reward
      const after = await coins(userId);
      const credited = after - before;
      expect(credited).toBeGreaterThan(0);

      const r = await pool.query(
        'SELECT claimed, claimed_amount FROM user_daily_rewards WHERE user_id = $1',
        [userId]
      );
      expect(r.rows[0].claimed).toBe(true);
      expect(credited).toBe(Number(r.rows[0].claimed_amount));
    } finally {
      await cleanup(userId);
    }
  });

  test('claimed আপডেট শর্তসাপেক্ষ — লকের উপর একমাত্র নির্ভরতা নেই', () => {
    // WHERE id = $2 মাত্র থাকলে row lock-ই একমাত্র সুরক্ষা হত। শর্তটা
    // থাকলে লক ব্যর্থ হলেও দ্বিতীয় UPDATE কোনো সারি স্পর্শ করে না।
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'services', 'dailyReward.js'), 'utf8'
    );
    expect(src).toMatch(/WHERE id = \$2 AND claimed = false/);
    expect(src).toMatch(/FOR UPDATE/);
  });

  test('claim করার পরে দ্বিতীয়বার claim ব্যর্থ হয়', async () => {
    const userId = await makeUser();
    try {
      await seedTurnover(userId, 1000000);
      const first = await dailyReward.claimDailyReward(userId, 'bn');
      expect(first.success).toBe(true);

      const second = await dailyReward.claimDailyReward(userId, 'bn');
      expect(second.success).toBe(false);

      const after = await coins(userId);
      const r = await pool.query(
        'SELECT claimed_amount FROM user_daily_rewards WHERE user_id = $1', [userId]
      );
      expect(after).toBe(Number(r.rows[0].claimed_amount));
    } finally {
      await cleanup(userId);
    }
  });
});
