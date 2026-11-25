// tests/regression/contestMonthBd.test.js
// রেফারেল কনটেস্টের "চলতি মাস / আগের মাস" এখন Asia/Dhaka ব্যবসায়িক মাসে (আগে: SQL
// CURRENT_DATE + to_char(created_at) DB-টাইমজোনে, মাসের নাম/কী সার্ভার-টাইমজোনের JS Date-এ)।
// আসল Postgres; শুধু Date ঘড়ি স্থির। লিডারবোর্ড র‍্যাংকিং/প্রাইজ অপরিবর্তিত।
//
// মাসের সীমানা: BD ১ এপ্রিল ০০:০০ = UTC ৩১ মার্চ ১৮:০০।
const { pool } = require('../../db');
const { getLeaderboard, getContestWinnersForMonth } = require('../../services/contest');
const { at } = require('./_bdClock');

jest.setTimeout(60000);

const BEFORE = '2026-03-31T17:59:30Z'; // BD ৩১ মার্চ ২৩:৫৯:৩০
const AFTER = '2026-03-31T18:00:30Z';  // BD ১ এপ্রিল ০০:০০:৩০ (UTC এখনও ৩১ মার্চ)

const users = [];
let seq = 0;
async function mkUser(prefix) {
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`.slice(-9);
  const username = `${prefix}${tag}`;
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1,$2,'x',0) RETURNING id`,
    [username, `018${String(Date.now()).slice(-7)}${seq}`.slice(0, 11)]);
  users.push(r.rows[0].id);
  return { id: r.rows[0].id, username };
}
const countFor = (rows, username) => (rows.find(l => l.username === username) || {}).referrals || 0;

let referrer;
beforeAll(async () => {
  referrer = await mkUser('ctR');
  const mar = await mkUser('ctA'); // BD ৩১ মার্চ ২৩:৩০ (UTC ১৭:৩০)
  const apr = await mkUser('ctB'); // BD ১ এপ্রিল ০০:৩০ (UTC ৩১ মার্চ ১৮:৩০) — UTC-তে এখনও মার্চ!
  await pool.query(`INSERT INTO referrals (referrer_id, referred_id, created_at) VALUES ($1,$2,'2026-03-31 17:30:00')`, [referrer.id, mar.id]);
  await pool.query(`INSERT INTO referrals (referrer_id, referred_id, created_at) VALUES ($1,$2,'2026-03-31 18:30:00')`, [referrer.id, apr.id]);
});

afterAll(async () => {
  await pool.query('DELETE FROM referrals WHERE referrer_id = ANY($1)', [users]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]).catch(() => {});
  await pool.end().catch(() => {});
});

describe('getLeaderboard — চলতি মাস', () => {
  test('BD ৩১ মার্চ ২৩:৫৯:৩০ → মার্চ: শুধু ১টা রেফারেল (এপ্রিলের BD-০০:৩০ সারিটা নয়)', async () => {
    const lb = await at(BEFORE, () => getLeaderboard(referrer.id));
    expect(countFor(lb.leaders, referrer.username)).toBe(1);
  });

  test('BD ১ এপ্রিল ০০:০০:৩০ (UTC এখনও ৩১ মার্চ) → এপ্রিল: ১টা রেফারেল', async () => {
    const lb = await at(AFTER, () => getLeaderboard(referrer.id));
    expect(countFor(lb.leaders, referrer.username)).toBe(1);
  });

  test('মাসের নাম BD মাস দেখায়: ২৩:৫৯ মার্চ, ০০:০০ এপ্রিল', async () => {
    const m = await at(BEFORE, () => getLeaderboard(referrer.id));
    const a = await at(AFTER, () => getLeaderboard(referrer.id));
    expect(m.monthName).toBe(new Date('2026-03-15T12:00:00Z').toLocaleDateString('bn-BD', { month: 'long', year: 'numeric' }));
    expect(a.monthName).toBe(new Date('2026-04-15T12:00:00Z').toLocaleDateString('bn-BD', { month: 'long', year: 'numeric' }));
  });
});

describe('getContestWinnersForMonth — আগের মাস', () => {
  test('BD ১ এপ্রিল ০০:০০:৩০-এ monthsBack=1 → মার্চ (key 2026-03) ও মার্চের ১টা রেফারেল', async () => {
    const w = await at(AFTER, () => getContestWinnersForMonth(1));
    expect(w.monthKey).toBe('2026-03');
    expect(countFor(w.leaders, referrer.username)).toBe(1);
  });

  test('BD ৩১ মার্চ ২৩:৫৯:৩০-এ monthsBack=1 → ফেব্রুয়ারি (key 2026-02), রেফারেল নেই', async () => {
    const w = await at(BEFORE, () => getContestWinnersForMonth(1));
    expect(w.monthKey).toBe('2026-02');
    expect(countFor(w.leaders, referrer.username)).toBe(0);
  });
});
