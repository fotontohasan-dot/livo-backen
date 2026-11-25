// tests/regression/redpacketDepositDayDbTz.test.js
// একই শর্ত, কিন্তু DB সেশন-টাইমজোন UTC নয় (Asia/Dhaka)। `updated_at` TIMESTAMP (tz ছাড়া) ও NOW() সেশন-টাইমে লেখে,
// তাই পুরোনো `+6 hours` অফসেট এখানে ১২ ঘণ্টা সরে যেত। এখন সেশন-টাইমজোন থেকে BD দিনে রূপান্তর।
// PGOPTIONS অবশ্যই db.js লোডের আগে সেট করতে হবে (প্রতিটা Jest ফাইলের নিজস্ব Pool)।
process.env.PGOPTIONS = '-c timezone=Asia/Dhaka';
const { pool } = require('../../db');
const { getRewardStatus } = require('../../services/redpacket');
const { at } = require('./_bdClock');

jest.setTimeout(60000);
let uid;

beforeAll(async () => {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1,$2,'x',0) RETURNING id`,
    [`rq${Date.now().toString(36)}`.slice(0, 14), `017${String(Date.now()).slice(-8)}`]);
  uid = r.rows[0].id;
});
afterAll(async () => {
  await pool.query('DELETE FROM payment_requests WHERE user_id=$1', [uid]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id=$1', [uid]).catch(() => {});
  await pool.end().catch(() => {});
});

test('পূর্বশর্ত: এই ফাইলে DB সেশন সত্যিই Asia/Dhaka', async () => {
  expect((await pool.query('SHOW TimeZone')).rows[0].TimeZone).toBe('Asia/Dhaka');
});

test('DB সেশন BD: BD ১০ মার্চ ২৩:৩০-এ লেখা ডিপোজিট (updated_at=স্থানীয় ২৩:৩০) ১০ মার্চ ২৩:৫৯:৩০-এ আনলক, ১১ মার্চ ০০:০০:৩০-এ লক', async () => {
  await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, status, created_at, updated_at)
     VALUES ($1,'deposit','bkash',100,$2,'approved','2026-03-10 23:30:00','2026-03-10 23:30:00')`,
    [uid, `RPQ-${Date.now().toString(36)}`]);
  const before = await at('2026-03-10T17:59:30Z', () => getRewardStatus(uid));
  const after = await at('2026-03-10T18:00:30Z', () => getRewardStatus(uid));
  expect(before.goldenEgg.locked).toBe(false);
  expect(after.goldenEgg.locked).toBe(true);
});
