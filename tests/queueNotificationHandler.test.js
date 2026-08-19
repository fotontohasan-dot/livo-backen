// services/queueHandlers.js — 'notification' হ্যান্ডলার।
// আগে userIds-এর জন্য একটা লুপে আলাদা আলাদা pool.query(INSERT) চলত। services/queue.js
// জব ব্যর্থ হলে *পুরো* জবটাই রিট্রাই করে (সর্বোচ্চ ৩ বার) — তাই লুপ মাঝপথে ব্যর্থ হয়ে
// আগেই-সফল ইনসার্টগুলো retry-তে আবার চললে ডুপ্লিকেট নোটিফিকেশন রো তৈরি হতো। এই টেস্ট
// নিশ্চিত করে: (ক) একটাই কলে সবার জন্য ঠিক একটা করে রো insert হয়, (খ) Telegram পাঠানো
// ব্যর্থ হলেও হ্যান্ডলার থ্রো করে না (তাই queue.js পুরো জব রিট্রাই করবে না — আগের ইনসার্ট
// ডুপ্লিকেট হবে না)।

const { pool } = require('../db');
const { uniqueUsername, uniquePhone } = require('./helpers/app');

async function createUser() {
  const username = uniqueUsername('nq');
  const r = await pool.query(
    `INSERT INTO users (username, phone, password) VALUES ($1, $2, 'x') RETURNING id`,
    [username, uniquePhone()]
  );
  return r.rows[0].id;
}

describe("queueHandlers 'notification' — ডুপ্লিকেট-প্রতিরোধ", () => {
  test('একাধিক userId-এর জন্য একটাই কলে প্রতিটার জন্য ঠিক একটা করে রো insert হয় (atomic bulk insert)', async () => {
    const captured = {};
    jest.doMock('../services/queue', () => ({ registerHandler: (type, fn) => { captured[type] = fn; } }));
    jest.doMock('../services/telegramNotify', () => ({ notifyTelegram: jest.fn().mockResolvedValue() }));
    jest.isolateModules(() => { require('../services/queueHandlers'); });
    jest.dontMock('../services/queue');
    jest.dontMock('../services/telegramNotify');

    const u1 = await createUser();
    const u2 = await createUser();

    await captured.notification({ userIds: [u1, u2], title: 'টেস্ট', message: 'হ্যালো' });

    const rows = await pool.query(
      `SELECT user_id, COUNT(*)::int AS c FROM notifications WHERE user_id IN ($1,$2) AND title='টেস্ট' GROUP BY user_id`,
      [u1, u2]
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.every(r => r.c === 1)).toBe(true);
  });

  test('Telegram পাঠানো ব্যর্থ হলেও হ্যান্ডলার থ্রো করে না (রিট্রাইয়ে ডুপ্লিকেট ইনসার্ট এড়াতে)', async () => {
    const captured = {};
    jest.doMock('../services/queue', () => ({ registerHandler: (type, fn) => { captured[type] = fn; } }));
    jest.doMock('../services/telegramNotify', () => ({
      notifyTelegram: jest.fn().mockRejectedValue(new Error('telegram down (test)'))
    }));
    jest.isolateModules(() => { require('../services/queueHandlers'); });
    jest.dontMock('../services/queue');
    jest.dontMock('../services/telegramNotify');

    const u1 = await createUser();

    await expect(captured.notification({
      userIds: [u1], title: 'টেস্ট২', message: 'হ্যালো২', telegramText: 'admin alert'
    })).resolves.toBeUndefined(); // থ্রো করেনি — queue.js এটাকে সফল হিসেবে গণ্য করবে, রিট্রাই হবে না

    const rows = await pool.query(
      `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND title='টেস্ট২'`, [u1]
    );
    expect(rows.rows[0].c).toBe(1); // ইনসার্ট ঠিকই হয়েছে, একবারই
  });
});
