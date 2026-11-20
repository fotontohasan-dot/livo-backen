// tests/regression/redpacketDepositDayBd.test.js
// লাল প্যাকেট/সোনার ডিম আনলকের শর্ত "আজ ডিপোজিট অনুমোদিত" — এখন Asia/Dhaka ব্যবসায়িক দিনে
// (আগে: `(updated_at + interval '6 hours')::date`, হাতে-করা অফসেট)। আসল Postgres, শুধু Date ঘড়ি স্থির।
// দ্রষ্টব্য: DB সেশন UTC হলে পুরোনো `+6h` ও BD সমান ফল দেয়, তাই এই ফাইল গার্ড (রিগ্রেশন-প্রতিরোধ);
// পুরোনো কোডে আসল ফেল redpacketDepositDayDbTz.test.js-এ (DB সেশন ≠ UTC)।
// কেবল "কোন দিনের ডিপোজিট" নির্ধারণ বদলেছে; পুরস্কারের পরিমাণ/ওয়ালেট/দাবি-লজিক অপরিবর্তিত।
const { pool } = require('../../db');
const { getRewardStatus } = require('../../services/redpacket');
const { at } = require('./_bdClock');

jest.setTimeout(60000);

let uid;
const dep = (label, utcTs) => pool.query(
  `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, status, created_at, updated_at)
   VALUES ($1,'deposit','bkash',100,$2,'approved',$3::timestamp,$3::timestamp)`,
  [uid, `RPK-${Date.now().toString(36)}-${label}`, utcTs]);
const unlocked = async (isoNow) => !(await at(isoNow, () => getRewardStatus(uid))).goldenEgg.locked;

beforeAll(async () => {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1,$2,'x',0) RETURNING id`,
    [`rp${Date.now().toString(36)}`.slice(0, 14), `017${String(Date.now()).slice(-8)}`]);
  uid = r.rows[0].id;
});
afterEach(async () => { await pool.query('DELETE FROM payment_requests WHERE user_id=$1', [uid]); });
afterAll(async () => {
  await pool.query('DELETE FROM users WHERE id=$1', [uid]).catch(() => {});
  await pool.end().catch(() => {});
});

describe('আজকের ডিপোজিট — BD মধ্যরাতের আগে/পরে (DB সেশন UTC)', () => {
  test('BD ১০ মার্চ ০১:০০-এর (UTC ৯ মার্চ ১৯:০০) ডিপোজিট: ১০ মার্চ ২৩:৫৯:৩০-এ আনলক', async () => {
    await dep('A', '2026-03-09 19:00:00');
    expect(await unlocked('2026-03-10T17:59:30Z')).toBe(true);
  });
  test('একই ডিপোজিট BD ১১ মার্চ ০০:০০:৩০-এ আর আজকের নয় → লক', async () => {
    await dep('A', '2026-03-09 19:00:00');
    expect(await unlocked('2026-03-10T18:00:30Z')).toBe(false);
  });
  test('BD ১১ মার্চ ০০:০০:১০-এর (UTC ১০ মার্চ ১৮:০০:১০) ডিপোজিট: ১০ মার্চ ২৩:৫৯:৩০-এ লক, ১১ মার্চ ০০:০০:৩০-এ আনলক', async () => {
    await dep('B', '2026-03-10 18:00:10');
    expect(await unlocked('2026-03-10T17:59:30Z')).toBe(false);
    expect(await unlocked('2026-03-10T18:00:30Z')).toBe(true);
  });
});
