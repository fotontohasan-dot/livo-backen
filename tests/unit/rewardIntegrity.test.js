// রিওয়ার্ড ইন্টিগ্রিটি — একই রিওয়ার্ড concurrent কলে দুইবার ক্রেডিট হয় কিনা।
// routes/games.js ও routes/matches.js প্রতিটা বাজিতে checkBadges()/addVipTurnover()
// await ছাড়া ডাকে, তাই একই ইউজারের একাধিক কল বাস্তবে সহজেই ওভারল্যাপ করে।
const { pool } = require('../../db');
const { checkBadges } = require('../../services/badges');
const { addVipTurnover } = require('../../services/vip');
const { recordGameResult } = require('../../services/streak');
const { uniqueUsername } = require('../helpers/app');

// coin_transactions-এ ইনসার্ট হওয়ার সাথে সাথে ব্যর্থ করে দেয় (শুধু নির্দিষ্ট userId-এর জন্য) —
// balance UPDATE ও ledger INSERT একই ট্রানজেকশনে কিনা যাচাই করতে ব্যবহৃত হয়।
async function withFailingLedgerInsert(userId, fn) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION zz_fail_coin_tx_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW.user_id = ${userId} THEN
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
    return await fn();
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS zz_fail_coin_tx_trigger ON coin_transactions');
    await pool.query('DROP FUNCTION IF EXISTS zz_fail_coin_tx_for_test()');
  }
}

async function createUser() {
  const name = uniqueUsername('ri');
  const r = await pool.query(
    `INSERT INTO users (username, password, role, coins, referral_code, created_at)
     VALUES ($1, 'x', 'user', 0, $2, NOW()) RETURNING id`,
    [name, `RI${name}`.slice(0, 20)]
  );
  return r.rows[0].id;
}

async function coinsOf(userId) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].coins);
}

// পুল ঠান্ডা থাকলে (কোনো আইডল কানেকশন নেই) pg নতুন কানেকশন খোলার সময় কলগুলোকে কার্যত
// সিরিয়ালাইজ করে ফেলে, ফলে রেসটা লুকিয়ে যায় এবং টেস্ট মিথ্যা পাস করে। প্রোডাকশনে পুল
// সবসময় গরম থাকে, তাই কনকারেন্সি টেস্টের আগে ইচ্ছে করে কয়েকটা কানেকশন খুলে রাখা হয়।
async function warmPool(n = 10) {
  await Promise.all(Array.from({ length: n }, () => pool.query('SELECT pg_sleep(0.05)')));
}

describe('Reward integrity — badges', () => {
  // রিগ্রেশন: INSERT ... ON CONFLICT DO NOTHING এর রিটার্ন ভ্যালু দেখা হতো না, তাই দুইটা
  // concurrent কলের একটার INSERT নীরবে skip হয়ে যেত কিন্তু দুটোই coins ক্রেডিট করত।
  test('একই ব্যাজের রিওয়ার্ড concurrent কলেও ঠিক একবারই ক্রেডিট হয়', async () => {
    const userId = await createUser();
    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, -10, 'bet', 'test bet')`,
      [userId]
    );

    await warmPool();
    await Promise.all([
      checkBadges(userId), checkBadges(userId), checkBadges(userId),
      checkBadges(userId), checkBadges(userId)
    ]);

    const badgeRows = await pool.query(
      `SELECT COUNT(*)::int AS c FROM user_badges WHERE user_id = $1 AND badge_code = 'first_bet'`,
      [userId]
    );
    expect(badgeRows.rows[0].c).toBe(1);

    const credits = await pool.query(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(amount),0)::int AS total
       FROM coin_transactions WHERE user_id = $1 AND type = 'badge'`,
      [userId]
    );
    expect(credits.rows[0].c).toBe(1);
    expect(credits.rows[0].total).toBe(20); // first_bet reward
    expect(await coinsOf(userId)).toBe(20);
  });

  test('দ্বিতীয়বার checkBadges ডাকলে আগের ব্যাজে আর কোনো কয়েন যোগ হয় না', async () => {
    const userId = await createUser();
    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, -10, 'bet', 'test bet')`,
      [userId]
    );

    const first = await checkBadges(userId);
    expect(first.map(b => b.code)).toContain('first_bet');
    const afterFirst = await coinsOf(userId);

    const second = await checkBadges(userId);
    expect(second).toEqual([]);
    expect(await coinsOf(userId)).toBe(afterFirst);
  });
});

describe('Reward integrity — VIP upgrade bonus', () => {
  // রিগ্রেশন: লেভেল চেক আর লেভেল আপডেট আলাদা ছিল, তাই একই থ্রেশহোল্ড পার করা দুইটা
  // concurrent বাজি দুটোই upgrade_bonus ক্রেডিট করে ফেলত।
  test('একই VIP আপগ্রেডের বোনাস concurrent টার্নওভারেও ঠিক একবারই দেওয়া হয়', async () => {
    const userId = await createUser();

    const silver = await pool.query(`SELECT min_turnover, upgrade_bonus FROM vip_levels WHERE level = 1`);
    expect(silver.rows.length).toBe(1);
    const threshold = Number(silver.rows[0].min_turnover);
    const bonus = Number(silver.rows[0].upgrade_bonus);
    expect(bonus).toBeGreaterThan(0);

    // থ্রেশহোল্ডের ঠিক নিচে বসিয়ে দেওয়া হয়, যাতে নিচের প্রতিটা concurrent কলই লেভেল-আপ
    // ট্রিগার করে — রেস উইন্ডোটা (লেভেল পড়া ↔ লেভেল লেখা) এতে সবচেয়ে সরু ও নির্ভরযোগ্যভাবে হিট হয়
    await pool.query('UPDATE users SET total_turnover = $1 WHERE id = $2', [threshold - 10, userId]);

    await warmPool();
    await Promise.all(Array.from({ length: 5 }, () => addVipTurnover(userId, 10)));

    const u = await pool.query('SELECT vip_level, total_turnover, coins FROM users WHERE id = $1', [userId]);
    expect(u.rows[0].vip_level).toBe(1);
    // টার্নওভার প্রতিটা কলেরই গণনা হয়েছে (আপগ্রেড গার্ড টার্নওভারকে প্রভাবিত করে না)
    expect(Number(u.rows[0].total_turnover)).toBe(threshold - 10 + 50);

    const credits = await pool.query(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(amount),0)::int AS total
       FROM coin_transactions WHERE user_id = $1 AND type = 'vip_upgrade'`,
      [userId]
    );
    expect(credits.rows[0].c).toBe(1);
    expect(credits.rows[0].total).toBe(bonus);
    expect(Number(u.rows[0].coins)).toBe(bonus);
  });

  test('একই লেভেলে থাকা অবস্থায় আরও টার্নওভার হলে বোনাস আবার দেওয়া হয় না', async () => {
    const userId = await createUser();
    const silver = await pool.query(`SELECT min_turnover, upgrade_bonus FROM vip_levels WHERE level = 1`);
    const threshold = Number(silver.rows[0].min_turnover);
    const bonus = Number(silver.rows[0].upgrade_bonus);

    await addVipTurnover(userId, threshold);
    expect(await coinsOf(userId)).toBe(bonus);

    await addVipTurnover(userId, 100);
    expect(await coinsOf(userId)).toBe(bonus);

    const credits = await pool.query(
      `SELECT COUNT(*)::int AS c FROM coin_transactions WHERE user_id = $1 AND type = 'vip_upgrade'`,
      [userId]
    );
    expect(credits.rows[0].c).toBe(1);
  });
});

describe('Reward integrity — ব্যালেন্স ↔ লেজার atomicity (fire-and-forget নয়)', () => {
  // এই তিনটা রিওয়ার্ড পাথে আগে balance UPDATE ও coin_transactions INSERT দুটো আলাদা,
  // কোনো ট্রানজেকশন ছাড়া pool.query() কল ছিল — মাঝপথে ব্যর্থ হলে ব্যালেন্স বেড়ে যেত
  // কিন্তু লেজার এন্ট্রি স্থায়ীভাবে হারিয়ে যেত। এখন একই ট্রানজেকশনে, তাই লেজার-ইনসার্ট
  // ব্যর্থ হলে পুরো রিওয়ার্ডই (balance-সহ) রোলব্যাক হয়ে যাওয়া উচিত।

  test('badge রিওয়ার্ডে ledger-ইনসার্ট ব্যর্থ হলে coins বৃদ্ধিও রোলব্যাক হয়', async () => {
    const userId = await createUser();
    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, -10, 'bet', 'test bet')`,
      [userId]
    );

    await withFailingLedgerInsert(userId, () => checkBadges(userId));

    expect(await coinsOf(userId)).toBe(0); // রোলব্যাক — কয়েন বাড়েনি
    // ব্যাজ-ইনসার্টও একই ট্রানজেকশনে থাকায় রোলব্যাক হয়ে গেছে — earned হিসেবে "আটকে" থাকেনি
    const badgeRows = await pool.query(
      `SELECT COUNT(*)::int AS c FROM user_badges WHERE user_id = $1 AND badge_code = 'first_bet'`,
      [userId]
    );
    expect(badgeRows.rows[0].c).toBe(0);

    // ট্রিগার সরানোর পর পরের কলে ঠিকমতো ব্যাজ + reward দুটোই পাওয়া যায়
    const retry = await checkBadges(userId);
    expect(retry.map(x => x.code)).toContain('first_bet');
    expect(await coinsOf(userId)).toBe(20);
  });

  test('VIP আপগ্রেড বোনাসে ledger-ইনসার্ট ব্যর্থ হলে coins বৃদ্ধিও রোলব্যাক হয়', async () => {
    const userId = await createUser();
    const silver = await pool.query(`SELECT min_turnover FROM vip_levels WHERE level = 1`);
    const threshold = Number(silver.rows[0].min_turnover);

    await withFailingLedgerInsert(userId, () => addVipTurnover(userId, threshold));

    expect(await coinsOf(userId)).toBe(0); // রোলব্যাক — বোনাস কয়েন যোগ হয়নি
  });

  test('উইন স্ট্রিক বোনাসে ledger-ইনসার্ট ব্যর্থ হলে coins বৃদ্ধিও রোলব্যাক হয়', async () => {
    const userId = await createUser();
    // স্ট্রিক ৩-এ পৌঁছাতে ৩ বার জয় রেকর্ড করা (৩ = প্রথম মাইলস্টোন)
    await recordGameResult(userId, true, 100);
    await recordGameResult(userId, true, 100);

    await withFailingLedgerInsert(userId, () => recordGameResult(userId, true, 100));

    expect(await coinsOf(userId)).toBe(0); // রোলব্যাক — বোনাস কয়েন যোগ হয়নি
  });
});
