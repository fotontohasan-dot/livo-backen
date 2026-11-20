// tests/regression/profileDateFilterBd.test.js
// /profile/history ও /profile/stats-এর quick=today|yesterday|7days এবং from/to ফিল্টার এখন
// Asia/Dhaka ব্যবসায়িক দিনে (আগে: toISOString UTC দিন + b.created_at::date DB-টাইমজোনে)।
// আসল Postgres + আসল HTTP; শুধু Date ঘড়ি স্থির। বাজি/স্টেক/পেআউট হিসাব অপরিবর্তিত।
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');
const { at } = require('./_bdClock');

jest.setTimeout(60000);

const TAG = `PF${Date.now().toString(36).toUpperCase()}`;
const BEFORE = '2026-03-10T17:59:30Z'; // BD ১০ মার্চ ২৩:৫৯:৩০ (UTC-ও ১০ মার্চ)
const AFTER = '2026-03-10T18:00:30Z';  // BD ১১ মার্চ ০০:০০:৩০ (UTC এখনও ১০ মার্চ)
let agent, userId;

async function bet(label, utcTs) {
  await pool.query(
    `INSERT INTO bets (user_id, market_type, runner, odd, stake, status, created_at)
     VALUES ($1,'match_winner',$2,2.00,10,'lost',$3::timestamp)`, [userId, `${TAG}${label}`, utcTs]);
}
const hist = async (qs) => (await agent.get(`/profile/history?${qs}`)).text;
const has = (html, label) => html.includes(`${TAG}${label}`);
const statsTotal = async (qs) => {
  const html = (await agent.get(`/profile/stats?${qs}`)).text;
  return Number((html.match(/dz67-11">(\d+)</) || [])[1]);
};

beforeAll(async () => {
  const { agent: a, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await a.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const r = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  agent = a; userId = r.rows[0].id;
  await pool.query('DELETE FROM bets WHERE user_id=$1', [userId]);
  await bet('MORN', '2026-03-10 02:00:00');  // BD ১০ মার্চ ০৮:০০
  await bet('EARLY', '2026-03-09 19:00:00'); // BD ১০ মার্চ ০১:০০ (UTC-তে ৯ মার্চ)
  await bet('PREV', '2026-03-09 17:00:00');  // BD ৯ মার্চ ২৩:০০
  await bet('NEXT', '2026-03-10 18:00:10');  // BD ১১ মার্চ ০০:০০:১০ (UTC-তে ১০ মার্চ)
});

afterAll(async () => {
  await pool.query('DELETE FROM bets WHERE user_id=$1', [userId]).catch(() => {});
  await cleanupUsers([userId]);
  await pool.end().catch(() => {});
});

describe('/profile/history', () => {
  test('today, BD ২৩:৫৯:৩০ → ১০ মার্চের দুটো (EARLY সহ), ৯/১১ মার্চের নয়', async () => {
    const h = await at(BEFORE, () => hist('quick=today'));
    expect(has(h, 'MORN')).toBe(true);
    expect(has(h, 'EARLY')).toBe(true);
    expect(has(h, 'PREV')).toBe(false);
    expect(has(h, 'NEXT')).toBe(false);
  });

  test('today, BD ০০:০০:৩০ (UTC এখনও ১০ মার্চ) → শুধু ১১ মার্চের NEXT', async () => {
    const h = await at(AFTER, () => hist('quick=today'));
    expect(has(h, 'NEXT')).toBe(true);
    expect(has(h, 'MORN')).toBe(false);
    expect(has(h, 'EARLY')).toBe(false);
  });

  test('yesterday, BD ০০:০০:৩০ → BD ১০ মার্চের দুটো', async () => {
    const h = await at(AFTER, () => hist('quick=yesterday'));
    expect(has(h, 'MORN')).toBe(true);
    expect(has(h, 'EARLY')).toBe(true);
    expect(has(h, 'NEXT')).toBe(false);
    expect(has(h, 'PREV')).toBe(false);
  });

  test('7days, BD ০০:০০:৩০ → ১১ মার্চ পর্যন্ত, চারটাই', async () => {
    const h = await at(AFTER, () => hist('quick=7days'));
    ['MORN', 'EARLY', 'PREV', 'NEXT'].forEach(l => expect(has(h, l)).toBe(true));
  });

  test('from/to=2026-03-10 → BD ১০ মার্চের দুটো', async () => {
    const h = await at(BEFORE, () => hist('from=2026-03-10&to=2026-03-10'));
    expect(has(h, 'MORN')).toBe(true);
    expect(has(h, 'EARLY')).toBe(true);
    expect(has(h, 'PREV')).toBe(false);
    expect(has(h, 'NEXT')).toBe(false);
  });
});

describe('/profile/stats', () => {
  test('today: BD ২৩:৫৯:৩০ → ২টা; BD ০০:০০:৩০ → ১টা', async () => {
    expect(await at(BEFORE, () => statsTotal('quick=today'))).toBe(2);
    expect(await at(AFTER, () => statsTotal('quick=today'))).toBe(1);
  });

  test('yesterday, BD ০০:০০:৩০ → ২টা', async () => {
    expect(await at(AFTER, () => statsTotal('quick=yesterday'))).toBe(2);
  });

  test('from/to=2026-03-10 → ২টা', async () => {
    expect(await at(BEFORE, () => statsTotal('from=2026-03-10&to=2026-03-10'))).toBe(2);
  });
});
