// tests/regression/adminDashBd2.test.js
// routes/admin.js ড্যাশবোর্ড ও লাইভ-স্ট্যাটস (docs/admin-report-dates-bd-5.md-এর S9–S14) এখন Asia/Dhaka ব্যবসায়িক দিনে
// (আগে CURRENT_DATE / created_at::date / toISOString().slice = UTC):
//   S9   ড্যাশবোর্ড newUsersToday         S10 revenueTrend ১৪ দিন     S11 userGrowth ১৪ দিন
//   S12  ড্যাশবোর্ড loadError fallback dateRange
//   S13  /api/dashboard-stats আজ ডিপোজিট/উইথড্র/P&L/গতকাল   S14 /api/dashboard-stats newUsersToday
// আসল Postgres + আসল HTTP। টাকা/বেট/সেটেলমেন্ট হিসাব অপরিবর্তিত — শুধু কোন দিনের সারি কোন বাকেটে পড়ে।
//
// দুই ধরনের ডেটা (adminReportDayBd.test.js-এর মতোই):
//  (ক) বাস্তব ঘড়ির সাপেক্ষে BD মধ্যরাতের দুই পাশ: BEFORE = BD গতকাল ২৩:৩০, AFTER = BD আজ ০০:৩০ (UTC-তে দুটোই একই দিনে!)
//  (খ) স্থির ঘড়ি (Date) — BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০: নতুন কোডে "আজ" JS ব্যবসায়িক ঘড়ি থেকে আসে।
const { pool } = require('../../db');
const bt = require('../../utils/businessTime');
const { at } = require('./_bdClock');
const { newCtx, entry, num } = require('./_adminBd');

jest.setTimeout(120000);

const c = newCtx('ADB');
const ts = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const T0 = bt.startOfDay();                              // BD আজ ০০:০০ (UTC Date)
const AFTER = ts(new Date(T0.getTime() + 30 * 60000));   // BD আজ ০০:৩০
const BEFORE = ts(new Date(T0.getTime() - 30 * 60000));  // BD গতকাল ২৩:৩০
const TODAY = bt.today();
const YESTERDAY = bt.addDays(TODAY, -1);

const dash = () => c.page('/admin', 'admin/dashboard');
const stats = async () => (await c.json('/admin/api/dashboard-stats')).stats;

beforeAll(async () => { c.installRenderSpy(); await c.login(); });
afterAll(() => c.cleanup());

describe('(ক) বাস্তব ঘড়ি — BD মধ্যরাতের দুই পাশের সারি', () => {
  let d0, s0;
  beforeAll(async () => {
    d0 = await dash(); s0 = await stats();
    await c.dep('deposit', 'DB', BEFORE, 1000);   await c.dep('deposit', 'DA', AFTER, 20000);
    await c.dep('withdraw', 'WB', BEFORE, 500);   await c.dep('withdraw', 'WA', AFTER, 7000);
    await c.bet('BB', BEFORE, 1000, 'lost');
    await c.bet('BA', AFTER, 20000, 'lost');
    await c.bet('BW', AFTER, 3000, 'won', 2);
    await c.newUser('b', BEFORE); await c.newUser('a', AFTER);
  });

  test('S9 ড্যাশবোর্ড newUsersToday: শুধু AFTER', async () => {
    const d1 = await dash();
    expect(d1.stats.new_users_today - d0.stats.new_users_today).toBe(1);
  });
  test('S10 revenueTrend: আজকের বাকেটে শুধু AFTER, গতকালেরটায় শুধু BEFORE; ১৪টা দিন, শেষ = BD আজ', async () => {
    const d1 = await dash();
    expect(d1.revenueTrend).toHaveLength(14);
    expect(entry(d1.revenueTrend, TODAY).day).toBeDefined();
    expect(num(entry(d1.revenueTrend, TODAY).deposit) - num(entry(d0.revenueTrend, TODAY).deposit)).toBe(20000);
    expect(num(entry(d1.revenueTrend, TODAY).withdraw) - num(entry(d0.revenueTrend, TODAY).withdraw)).toBe(7000);
    expect(num(entry(d1.revenueTrend, YESTERDAY).deposit) - num(entry(d0.revenueTrend, YESTERDAY).deposit)).toBe(1000);
    expect(num(entry(d1.revenueTrend, YESTERDAY).withdraw) - num(entry(d0.revenueTrend, YESTERDAY).withdraw)).toBe(500);
  });
  test('S11 userGrowth: আজ +১ (AFTER), গতকাল +১ (BEFORE)', async () => {
    const d1 = await dash();
    expect(d1.userGrowth).toHaveLength(14);
    expect(num(entry(d1.userGrowth, TODAY).count) - num(entry(d0.userGrowth, TODAY).count)).toBe(1);
    expect(num(entry(d1.userGrowth, YESTERDAY).count) - num(entry(d0.userGrowth, YESTERDAY).count)).toBe(1);
  });
  test('S13 /api/dashboard-stats: আজ-ডিপোজিট/উইথড্র শুধু AFTER; P&L আজ = ১৭০০০, গতকাল = ১০০০', async () => {
    const s1 = await stats();
    expect(s1.today_deposit - s0.today_deposit).toBe(20000);
    expect(s1.today_withdraw - s0.today_withdraw).toBe(7000);
    expect(s1.today_profit - s0.today_profit).toBe(17000);
    expect(s1.yesterday_profit - s0.yesterday_profit).toBe(1000);
  });
  test('S14 /api/dashboard-stats newUsersToday: শুধু AFTER', async () => {
    const s1 = await stats();
    expect(s1.new_users_today - s0.new_users_today).toBe(1);
  });
});

describe('(খ) স্থির ঘড়ি — "আজ" ব্যবসায়িক ঘড়ি থেকে (BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০)', () => {
  const A = '2026-03-10T17:59:30Z', B = '2026-03-10T18:00:30Z';
  const ROW = '2026-03-09 19:00:00';                   // BD ১০ মার্চ ০১:০০

  let base, baseB, baseS, baseSB, xs, ys, xd, yd;
  beforeAll(async () => {
    base = await at(A, () => dash()); baseB = await at(B, () => dash());
    baseS = await at(A, () => stats()); baseSB = await at(B, () => stats());
    await c.dep('deposit', 'FD', ROW, 111);
    await c.dep('withdraw', 'FW', ROW, 222);
    await c.bet('FB', ROW, 400, 'lost');
    await c.newUser('f', ROW);
    xd = await at(A, () => dash()); yd = await at(B, () => dash());
    xs = await at(A, () => stats()); ys = await at(B, () => stats());
  });

  test('S9 newUsersToday: BD ১০ মার্চ ০১:০০-এর ইউজার ২৩:৫৯:৩০-এ আজকের, ০০:০০:৩০-এ নয়', async () => {
    expect(xd.stats.new_users_today - base.stats.new_users_today).toBe(1);
    expect(yd.stats.new_users_today - baseB.stats.new_users_today).toBe(0);
  });
  test('S10 revenueTrend: শেষ দিন ১০ মার্চ → ১১ মার্চ; ১০ মার্চের বাকেটে ১১১ (UTC ৯ মার্চে নয়)', async () => {
    expect(xd.revenueTrend).toHaveLength(14); expect(yd.revenueTrend).toHaveLength(14);
    expect(entry(xd.revenueTrend, '2026-03-10').day).toBeDefined();
    expect(entry(xd.revenueTrend, '2026-03-11').day).toBeUndefined();
    expect(entry(yd.revenueTrend, '2026-03-11').day).toBeDefined();
    expect(num(entry(xd.revenueTrend, '2026-03-10').deposit) - num(entry(base.revenueTrend, '2026-03-10').deposit)).toBe(111);
    expect(num(entry(xd.revenueTrend, '2026-03-10').withdraw) - num(entry(base.revenueTrend, '2026-03-10').withdraw)).toBe(222);
    expect(num(entry(xd.revenueTrend, '2026-03-09').deposit) - num(entry(base.revenueTrend, '2026-03-09').deposit)).toBe(0);
  });
  test('S11 userGrowth: শেষ দিন ১০ → ১১ মার্চ; ১০ মার্চের বাকেটে +১', async () => {
    expect(dayLast(xd.userGrowth)).toBe('2026-03-10');
    expect(dayLast(yd.userGrowth)).toBe('2026-03-11');
    expect(num(entry(xd.userGrowth, '2026-03-10').count) - num(entry(base.userGrowth, '2026-03-10').count)).toBe(1);
    expect(num(entry(xd.userGrowth, '2026-03-09').count) - num(entry(base.userGrowth, '2026-03-09').count)).toBe(0);
  });
  test('S12 loadError fallback: dateRange.to = BD আজ (১০ মার্চ / ১১ মার্চ), from = to−২৯', async () => {
    const real = pool.query.bind(pool);
    const spy = jest.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      (typeof sql === 'string' && /FROM payment_requests WHERE type='deposit' AND status='approved'\s*$/.test(sql))
        ? Promise.reject(new Error('forced for S12')) : real(sql, ...rest));
    try {
      c.lastErr = {}; await at(A, () => c.agent.get('/admin'));
      const x = c.lastErr['admin/dashboard'];
      c.lastErr = {}; await at(B, () => c.agent.get('/admin'));
      const y = c.lastErr['admin/dashboard'];
      expect(x && x.loadError).toBe(true); expect(y && y.loadError).toBe(true);
      expect(x.dateRange).toEqual({ from: '2026-02-09', to: '2026-03-10' });
      expect(y.dateRange).toEqual({ from: '2026-02-10', to: '2026-03-11' });
    } finally { spy.mockRestore(); }
  });
  test('S13 /api/dashboard-stats: ১০ মার্চ ০১:০০(BD)-এর ডিপোজিট/উইথড্র/বেট ২৩:৫৯:৩০-এ আজকের, ০০:০০:৩০-এ গতকালের', async () => {
    expect(xs.today_deposit - baseS.today_deposit).toBe(111);
    expect(ys.today_deposit - baseSB.today_deposit).toBe(0);
    expect(xs.today_withdraw - baseS.today_withdraw).toBe(222);
    expect(ys.today_withdraw - baseSB.today_withdraw).toBe(0);
    expect(xs.today_profit - baseS.today_profit).toBe(400);       // lost ৪০০
    expect(ys.today_profit - baseSB.today_profit).toBe(0);
    expect(ys.yesterday_profit - baseSB.yesterday_profit).toBe(400); // ১১ মার্চে "গতকাল" = ১০ মার্চ
    expect(xs.yesterday_profit - baseS.yesterday_profit).toBe(0);
  });
  test('S14 /api/dashboard-stats newUsersToday', async () => {
    expect(xs.new_users_today - baseS.new_users_today).toBe(1);
    expect(ys.new_users_today - baseSB.new_users_today).toBe(0);
  });
});

function dayLast(arr) { return String(arr[arr.length - 1].day.toISOString ? arr[arr.length - 1].day.toISOString() : arr[arr.length - 1].day).slice(0, 10); }
