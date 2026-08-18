// tests/integration/rewardLedgerIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 10 — রিওয়ার্ড সার্ভিসগুলোর ব্যালেন্স ↔ লেজার সঙ্গতি।
//
// অপরিবর্তনীয় নিয়ম: users.coins-এর যেকোনো পরিবর্তনের বিপরীতে coin_transactions-এ
// ঠিক ততটুকুরই একটা সারি থাকতে হবে। নাহলে ব্যালেন্স আর লেনদেন-ইতিহাস আলাদা হয়ে যায়
// এবং হিসাব মেলানো অসম্ভব হয়ে পড়ে।
//
// এখানে যে বাস্তব বাগ লক করা হচ্ছে: services/redpacket.js-এর claimRedPacket() ও
// claimGoldenEgg() ইউজারের ব্যালেন্স বাড়াত এবং daily_rewards ও bonuses টেবিলে লিখত,
// কিন্তু coin_transactions-এ কিছুই লিখত না। ফিক্সের আগে মাপা হয়েছিল:
// ব্যালেন্স +63, লেজার 0 — প্রতিটা ক্লেইমে স্থায়ী গরমিল।
//
// আসল PostgreSQL ব্যবহার করা হয়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const redpacket = require('../../services/redpacket');

async function makeQualifiedUser(coins = 1000) {
  const u = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ('rpledger_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x', $1)
     RETURNING id`, [coins]
  );
  const userId = u.rows[0].id;
  // claim-এর শর্ত: আজ কোনো যোগ্য কার্যক্রম (ডিপোজিট) থাকতে হবে
  await pool.query(
    `INSERT INTO payment_requests (user_id, type, amount, status, updated_at)
     VALUES ($1, 'deposit', 500, 'approved', NOW())`, [userId]
  );
  return userId;
}

async function cleanup(userId) {
  for (const t of ['daily_rewards', 'bonuses', 'coin_transactions', 'payment_requests']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

async function balanceOf(userId) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].coins);
}

async function ledgerSum(userId) {
  const r = await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id = $1', [userId]
  );
  return Number(r.rows[0].s);
}

describe('লাল খাম (red packet) — ব্যালেন্স ও লেজার মেলে', () => {
  test('ক্লেইমের পর ব্যালেন্স বৃদ্ধি ঠিক লেজারের সমান', async () => {
    const userId = await makeQualifiedUser();
    const before = await balanceOf(userId);

    const result = await redpacket.claimRedPacket(userId);
    expect(result.ok).toBe(true);

    const delta = (await balanceOf(userId)) - before;
    expect(delta).toBe(result.amount);
    expect(await ledgerSum(userId)).toBe(delta); // আগে এটা 0 ছিল

    await cleanup(userId);
  });

  test('লেজার সারিটি সঠিক টাইপ ও পরিমাণে লেখা হয়', async () => {
    const userId = await makeQualifiedUser();
    const result = await redpacket.claimRedPacket(userId);

    const r = await pool.query(
      `SELECT amount, type FROM coin_transactions WHERE user_id = $1 AND type = 'red_packet'`, [userId]
    );
    expect(r.rows.length).toBe(1);
    expect(Number(r.rows[0].amount)).toBe(result.amount);

    await cleanup(userId);
  });
});

describe('গোল্ডেন এগ — ব্যালেন্স ও লেজার মেলে', () => {
  test('ক্লেইমের পর ব্যালেন্স বৃদ্ধি ঠিক লেজারের সমান', async () => {
    const userId = await makeQualifiedUser();
    const before = await balanceOf(userId);

    const result = await redpacket.claimGoldenEgg(userId, 0);
    expect(result.ok).toBe(true);

    const delta = (await balanceOf(userId)) - before;
    expect(delta).toBe(result.amount);
    expect(await ledgerSum(userId)).toBe(delta);

    await cleanup(userId);
  });

  test('দুই ধরনের পুরস্কার একসাথে নিলেও সব মিলে যায়', async () => {
    const userId = await makeQualifiedUser();
    const before = await balanceOf(userId);

    const a = await redpacket.claimRedPacket(userId);
    const b = await redpacket.claimGoldenEgg(userId, 0);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const delta = (await balanceOf(userId)) - before;
    expect(delta).toBe(a.amount + b.amount);
    expect(await ledgerSum(userId)).toBe(delta);

    await cleanup(userId);
  });
});

describe('ডুপ্লিকেট ক্লেইম সুরক্ষা অক্ষত', () => {
  test('একই দিনে দ্বিতীয়বার ক্লেইম করলে ব্যালেন্স বা লেজার বদলায় না', async () => {
    const userId = await makeQualifiedUser();
    await redpacket.claimRedPacket(userId);

    const balAfterFirst = await balanceOf(userId);
    const ledAfterFirst = await ledgerSum(userId);

    const second = await redpacket.claimRedPacket(userId);
    expect(second.ok).toBe(false);
    expect(await balanceOf(userId)).toBe(balAfterFirst);
    expect(await ledgerSum(userId)).toBe(ledAfterFirst);

    await cleanup(userId);
  });

  test('যোগ্য কার্যক্রম ছাড়া ক্লেইম করা যায় না এবং কোনো কয়েন যোগ হয় না', async () => {
    const u = await pool.query(
      `INSERT INTO users (username, phone, password, coins)
       VALUES ('rpnoq_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x', 500) RETURNING id`
    );
    const userId = u.rows[0].id;

    const before = await balanceOf(userId);
    const r = await redpacket.claimGoldenEgg(userId, 0);
    expect(r.ok).toBe(false);
    expect(await balanceOf(userId)).toBe(before);
    expect(await ledgerSum(userId)).toBe(0);

    await cleanup(userId);
  });
});

describe('সব রিওয়ার্ড সার্ভিসে ব্যালেন্স পরিবর্তনের সাথে লেজার লেখা হয়', () => {
  test('ব্যালেন্স মিউটেট করা প্রতিটা সার্ভিস coin_transactions-এও লেখে', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'services');

    const missing = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const mutates = /UPDATE users SET coins\s*=\s*coins\s*[+]/.test(src);
      if (!mutates) continue;
      if (!/INSERT INTO coin_transactions/.test(src)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });
});
