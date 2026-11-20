// tests/regression/adminReportDayBd.test.js
// routes/admin.js রিপোর্টের প্রথম ৮টা তারিখ-স্থান এখন Asia/Dhaka ব্যবসায়িক দিনে (আগে CURRENT_DATE / created_at::date /
// toISOString().slice = UTC):
//   S1-S3  GET /admin/api/analytics  (revenue / userGrowth / betStats দৈনিক গ্রুপিং)
//   S4     ড্যাশবোর্ড dateRange (ডিফল্ট from/to + betStats/betPayout/apiUsage তিন কোয়েরি)
//   S5-S8  ড্যাশবোর্ড আজ-ডিপোজিট / আজ-উইথড্র / আজ-বেট / আজ+গতকাল P&L
// আসল Postgres + আসল HTTP। res.render শুধু call-through স্পাই (locals পড়তে; কিছু বদলায় না)।
// টাকা/বেট/সেটেলমেন্ট হিসাব অপরিবর্তিত — শুধু কোন দিনের সারি কোন বাকেটে পড়ে।
//
// দুই ধরনের ডেটা:
//  (ক) বাস্তব ঘড়ির সাপেক্ষে BD মধ্যরাতের দুই পাশ: BEFORE = BD গতকাল ২৩:৩০, AFTER = BD আজ ০০:৩০ (UTC-তে দুটোই একই দিনে!)
//      — পুরোনো কোডে (UTC দিন) বাকেট ভুল; BD ০০:০০–০৬:০০-এর মধ্যে চালালে পুরোনো কোড ঘটনাচক্রে ঠিক ফল দেয়।
//  (খ) স্থির ঘড়ি (Date) — BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০: নতুন কোডে "আজ" JS ব্যবসায়িক ঘড়ি থেকে আসে।
const express = require('express');
const { pool } = require('../../db');
const bt = require('../../utils/businessTime');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');
const { at } = require('./_bdClock');

jest.setTimeout(120000);

const TAG = `ARD${Date.now().toString(36).toUpperCase()}`;
const ts = (d) => d.toISOString().replace('T', ' ').slice(0, 19); // UTC naive (DB সেশন UTC)
const T0 = bt.startOfDay();                              // BD আজ ০০:০০ (UTC Date)
const AFTER = ts(new Date(T0.getTime() + 30 * 60000));   // BD আজ ০০:৩০
const BEFORE = ts(new Date(T0.getTime() - 30 * 60000));  // BD গতকাল ২৩:৩০
const TODAY = bt.today();
const YESTERDAY = bt.addDays(TODAY, -1);

let agent, adminId; const userIds = [];
let captured = null;
const origRender = express.response.render;

const dayOf = (v) => String(v).slice(0, 10);
async function dash(qs = '') {
  captured = null;
  await agent.get(`/admin${qs}`);
  expect(captured).not.toBeNull();
  return captured;
}
async function analytics(days = 3) {
  const r = await agent.get(`/admin/api/analytics?days=${days}`);
  expect(r.status).toBe(200);
  return r.body;
}
const entry = (arr, day) => (arr.find(x => dayOf(x.day) === day) || {});

async function dep(type, label, when, amount) {
  await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, status, created_at, updated_at)
     VALUES ($1,$2,'bkash',$3,$4,'approved',$5::timestamp,$5::timestamp)`,
    [adminId, type, amount, `${TAG}-${label}`, when]);
}
async function bet(label, when, stake, status, odd = 2) {
  await pool.query(
    `INSERT INTO bets (user_id, stake, odd, status, created_at, client_ref) VALUES ($1,$2,$3,$4,$5::timestamp,$6)`,
    [adminId, stake, odd, status, when, `${TAG}-${label}`]);
}
async function newUser(label, when) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins, created_at) VALUES ($1,$2,'x',0,$3::timestamp) RETURNING id`,
    [`${TAG}${label}`.slice(0, 18).toLowerCase(), `017${String(Date.now()).slice(-7)}${label.length}`.slice(0, 11), when]);
  userIds.push(r.rows[0].id);
}
async function apiLog(when) {
  await pool.query(
    `INSERT INTO api_usage_logs (endpoint, method, status_code, response_time_ms, created_at) VALUES ($1,'GET',200,5,$2::timestamp)`,
    [`/${TAG}`, when]);
}

beforeAll(async () => {
  jest.spyOn(express.response, 'render').mockImplementation(function (view, opts, cb) {
    if (view === 'admin/dashboard' && opts && !opts.loadError) captured = opts;
    return origRender.call(this, view, opts, cb);
  });
  const { agent: a, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await a.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const r = await pool.query('UPDATE users SET role=$1 WHERE username=$2 RETURNING id', ['admin', username]);
  agent = a; adminId = r.rows[0].id;
});
afterAll(async () => {
  jest.restoreAllMocks();
  await pool.query('DELETE FROM payment_requests WHERE transaction_id LIKE $1', [`${TAG}-%`]).catch(() => {});
  await pool.query('DELETE FROM bets WHERE client_ref LIKE $1', [`${TAG}-%`]).catch(() => {});
  await pool.query('DELETE FROM api_usage_logs WHERE endpoint = $1', [`/${TAG}`]).catch(() => {});
  await cleanupUsers([...userIds, adminId]);
  await pool.end().catch(() => {});
});

describe('(ক) বাস্তব ঘড়ি — BD মধ্যরাতের দুই পাশের সারি', () => {
  let a0, d0, an0;
  beforeAll(async () => {
    a0 = await analytics(3);
    d0 = await dash();
    d0r = await dash(`?from=${TODAY}&to=${TODAY}`);
    await dep('deposit', 'DB', BEFORE, 1000);   await dep('deposit', 'DA', AFTER, 20000);
    await dep('withdraw', 'WB', BEFORE, 500);   await dep('withdraw', 'WA', AFTER, 7000);
    await bet('BB', BEFORE, 1000, 'lost');
    await bet('BA', AFTER, 20000, 'lost');
    await bet('BW', AFTER, 3000, 'won', 2);
    await newUser('b', BEFORE); await newUser('a', AFTER);
    await apiLog(BEFORE); await apiLog(AFTER);
  });
  let d0r;

  test('S1 analytics revenue: আজকের বাকেটে শুধু AFTER, গতকালেরটায় শুধু BEFORE', async () => {
    const a1 = await analytics(3);
    expect(entry(a1.revenue, TODAY).deposit - entry(a0.revenue, TODAY).deposit).toBe(20000);
    expect(entry(a1.revenue, TODAY).withdraw - entry(a0.revenue, TODAY).withdraw).toBe(7000);
    expect(entry(a1.revenue, YESTERDAY).deposit - entry(a0.revenue, YESTERDAY).deposit).toBe(1000);
    expect(entry(a1.revenue, YESTERDAY).withdraw - entry(a0.revenue, YESTERDAY).withdraw).toBe(500);
  });
  test('S2 analytics userGrowth', async () => {
    const a1 = await analytics(3);
    expect(entry(a1.userGrowth, TODAY).count - entry(a0.userGrowth, TODAY).count).toBe(1);
    expect(entry(a1.userGrowth, YESTERDAY).count - entry(a0.userGrowth, YESTERDAY).count).toBe(1);
  });
  test('S3 analytics betStats', async () => {
    const a1 = await analytics(3);
    expect(entry(a1.betStats, TODAY).cnt - entry(a0.betStats, TODAY).cnt).toBe(2);
    expect(entry(a1.betStats, TODAY).staked - entry(a0.betStats, TODAY).staked).toBe(23000);
    expect(entry(a1.betStats, YESTERDAY).cnt - entry(a0.betStats, YESTERDAY).cnt).toBe(1);
    expect(entry(a1.betStats, YESTERDAY).staked - entry(a0.betStats, YESTERDAY).staked).toBe(1000);
  });
  test('S4 ড্যাশবোর্ড dateRange: ডিফল্ট to = BD আজ, from = BD আজ−২৯; from=to=আজ হলে betStats/payout/apiUsage শুধু AFTER-এর', async () => {
    const d1 = await dash();
    expect(d1.dateRange.to).toBe(TODAY);
    expect(d1.dateRange.from).toBe(bt.addDays(TODAY, -29));
    const r1 = await dash(`?from=${TODAY}&to=${TODAY}`);
    expect(r1.betStatistics.totalBets - d0r.betStatistics.totalBets).toBe(2);
    expect(r1.betStatistics.totalStake - d0r.betStatistics.totalStake).toBe(23000);
    expect(r1.betStatistics.totalPayout - d0r.betStatistics.totalPayout).toBe(6000);
    expect(r1.apiUsageStats.totalRequests - d0r.apiUsageStats.totalRequests).toBe(1);
  });
  test('S5 আজ-ডিপোজিট, S6 আজ-উইথড্র: শুধু AFTER', async () => {
    const d1 = await dash();
    expect(d1.stats.today_deposit - d0.stats.today_deposit).toBe(20000);
    expect(d1.stats.today_deposit_count - d0.stats.today_deposit_count).toBe(1);
    expect(d1.stats.today_withdraw - d0.stats.today_withdraw).toBe(7000);
    expect(d1.stats.today_withdraw_count - d0.stats.today_withdraw_count).toBe(1);
  });
  test('S7 আজ-বেট: শুধু AFTER-এর দুটো (২৩০০০)', async () => {
    const d1 = await dash();
    expect(d1.stats.today_bet_count - d0.stats.today_bet_count).toBe(2);
    expect(d1.stats.today_bet_amount - d0.stats.today_bet_amount).toBe(23000);
  });
  test('S8 আজ P&L = (২০০০০+৩০০০) − ৬০০০ = ১৭০০০; গতকাল P&L = ১০০০', async () => {
    const d1 = await dash();
    expect(d1.stats.today_profit - d0.stats.today_profit).toBe(17000);
    expect(d1.stats.yesterday_profit - d0.stats.yesterday_profit).toBe(1000);
  });
});

describe('(খ) স্থির ঘড়ি — নতুন কোডে "আজ" ব্যবসায়িক ঘড়ি থেকে (BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০)', () => {
  const A = '2026-03-10T17:59:30Z', B = '2026-03-10T18:00:30Z';
  test('S4 ডিফল্ট dateRange.to: ১০ মার্চ → ১১ মার্চ; from = to−২৯', async () => {
    const x = await at(A, () => dash());
    const y = await at(B, () => dash());
    expect(x.dateRange.to).toBe('2026-03-10'); expect(x.dateRange.from).toBe('2026-02-09');
    expect(y.dateRange.to).toBe('2026-03-11'); expect(y.dateRange.from).toBe('2026-02-10');
  });
  test('S1 analytics: BD ১০ মার্চ ২৩:৫৯:৩০-এ সিরিজের শেষ দিন ১০ মার্চ; ০০:০০:৩০-এ ১১ মার্চ', async () => {
    const x = await at(A, () => analytics(1));
    const y = await at(B, () => analytics(1));
    expect(dayOf(x.revenue[x.revenue.length - 1].day)).toBe('2026-03-10');
    expect(dayOf(y.revenue[y.revenue.length - 1].day)).toBe('2026-03-11');
  });
  test('S5 আজ-ডিপোজিট: ১০ মার্চ ০১:০০(BD)-এর সারি ২৩:৫৯:৩০-এ আজকের, ০০:০০:৩০-এ নয়', async () => {
    await dep('deposit', 'FK', '2026-03-09 19:00:00', 111); // BD ১০ মার্চ ০১:০০
    const x = await at(A, () => dash()); const y = await at(B, () => dash());
    const base = await at('2026-03-20T00:00:00Z', () => dash()); // দুই দিনেই নেই এমন দিন
    expect(x.stats.today_deposit - base.stats.today_deposit).toBe(111);
    expect(y.stats.today_deposit - base.stats.today_deposit).toBe(0);
  });
});
