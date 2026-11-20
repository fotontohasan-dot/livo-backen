// tests/regression/depositDateRangeBd.test.js
// GET /payment/admin/deposits?quick=today|7d|30d|90d|year ও তারিখ-ফিল্টার এখন Asia/Dhaka
// ব্যবসায়িক দিনে (আগে: UTC দিন + created_at::date DB-টাইমজোনে)। আসল Postgres + আসল HTTP।
// BD দিন বদলায় UTC ১৮:০০-এ; ওই ছয় ঘণ্টায় পুরোনো কোড ভুল দিনের ডিপোজিট দেখাত।
// টাকা/বোনাস/অনুমোদন-লজিক অপরিবর্তিত — শুধু কোন দিনের সারি দেখানো হবে।
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');
const { at } = require('./_bdClock');

jest.setTimeout(60000);

const TAG = `BDR${Date.now().toString(36).toUpperCase()}`;
let agent, adminId;

async function dep(label, utcTs) {
  await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, status, created_at)
     VALUES ($1,'deposit','bkash',100,$2,'pending',$3::timestamp)`,
    [adminId, `${TAG}-${label}`, utcTs]);
}
const page = async (qs) => (await agent.get(`/payment/admin/deposits?method=bkash&${qs}`)).text;
const has = (html, label) => html.includes(`${TAG}-${label}`);

beforeAll(async () => {
  const { agent: a, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await a.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const r = await pool.query('UPDATE users SET role=$1 WHERE username=$2 RETURNING id', ['admin', username]);
  agent = a; adminId = r.rows[0].id;
  // BD ১০ মার্চ ০৮:০০ (UTC ১০ মার্চ ০২:০০) — দুই পদ্ধতিতেই ১০ মার্চ
  await dep('MORN', '2026-03-10 02:00:00');
  // BD ১০ মার্চ ০১:০০ (UTC ৯ মার্চ ১৯:০০) — UTC-তে আগের দিন!
  await dep('EARLY', '2026-03-09 19:00:00');
  // BD ৯ মার্চ ২৩:০০ (UTC ৯ মার্চ ১৭:০০)
  await dep('PREV', '2026-03-09 17:00:00');
  // BD ১১ মার্চ ০০:০০:১০ (UTC ১০ মার্চ ১৮:০০:১০) — UTC-তে এখনও ১০ মার্চ!
  await dep('NEXT', '2026-03-10 18:00:10');
});

afterAll(async () => {
  await pool.query('DELETE FROM payment_requests WHERE transaction_id LIKE $1', [`${TAG}-%`]).catch(() => {});
  await cleanupUsers([adminId]);
  await pool.end().catch(() => {});
});

describe('quick=today — BD মধ্যরাতের আগে/পরে', () => {
  test('BD ১০ মার্চ ২৩:৫৯:৩০ → ১০ মার্চের সারি (UTC-তে ৯ মার্চ ১৯:০০-এরটা সহ), ১১ মার্চের নয়', async () => {
    const html = await at('2026-03-10T17:59:30Z', () => page('quick=today'));
    expect(has(html, 'MORN')).toBe(true);
    expect(has(html, 'EARLY')).toBe(true);
    expect(has(html, 'PREV')).toBe(false);
    expect(has(html, 'NEXT')).toBe(false);
  });

  test('BD ১১ মার্চ ০০:০০:৩০ (UTC এখনও ১০ মার্চ) → শুধু ১১ মার্চের সারি', async () => {
    const html = await at('2026-03-10T18:00:30Z', () => page('quick=today'));
    expect(has(html, 'NEXT')).toBe(true);
    expect(has(html, 'MORN')).toBe(false);
    expect(has(html, 'EARLY')).toBe(false);
  });
});

describe('quick=7d / year — রেঞ্জের শেষ ও বছর BD দিনে', () => {
  test('7d: BD ১১ মার্চ ০০:০০:৩০-এ শেষ সীমা ১১ মার্চ, তাই ১১ মার্চের সারিও আসে', async () => {
    const html = await at('2026-03-10T18:00:30Z', () => page('quick=7d'));
    expect(has(html, 'NEXT')).toBe(true);
    expect(has(html, 'PREV')).toBe(true);
  });

  test('7d: BD ১০ মার্চ ২৩:৫৯:৩০-এ ১১ মার্চের সারি আসে না', async () => {
    const html = await at('2026-03-10T17:59:30Z', () => page('quick=7d'));
    expect(has(html, 'NEXT')).toBe(false);
    expect(has(html, 'MORN')).toBe(true);
  });

});

describe('হাতে দেওয়া from/to — created_at BD দিনে মেলে', () => {
  test('from=to=2026-03-10 → BD ১০ মার্চের দুটো সারি, ৯/১১ মার্চেরটা নয়', async () => {
    const html = await at('2026-03-10T17:59:30Z', () => page('from=2026-03-10&to=2026-03-10'));
    expect(has(html, 'MORN')).toBe(true);
    expect(has(html, 'EARLY')).toBe(true);
    expect(has(html, 'PREV')).toBe(false);
    expect(has(html, 'NEXT')).toBe(false);
  });
});

// সব রিকোয়েস্টই স্থির ঘড়িতে: অতীতের ঘড়িতে সেশনের rolling-expiry আসল সময়ের আগে পড়ে, তাই মাঝে আসল ঘড়ির রিকোয়েস্ট লগআউট করে দেয়।
describe('quick=year — বছরের সীমা BD দিনে', () => {
  test('year: BD নববর্ষের মধ্যরাতে (UTC ৩১ ডিসেম্বর ১৮:০০:৩০) বছর = নতুন বছর', async () => {
    await dep('NY', '2025-12-31 18:00:10'); // BD ১ জানু ২০২৬ ০০:০০:১০
    await dep('OLDY', '2025-12-31 17:00:00'); // BD ৩১ ডিসেম্বর ২০২৫ ২৩:০০
    const html = await at('2025-12-31T18:00:30Z', () => page('quick=year'));
    expect(has(html, 'NY')).toBe(true);
    expect(has(html, 'OLDY')).toBe(false);
  });
});
