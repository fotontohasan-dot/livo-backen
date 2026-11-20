// tests/regression/adminListFiltersBd.test.js
// routes/admin.js তালিকা-ফিল্টার ও "আজ"-কার্ড (docs/admin-report-dates-bd-5.md-এর S15–S21) এখন Asia/Dhaka ব্যবসায়িক দিনে:
//   S15 /deposits/legacy-disabled   S16 /withdrawals/legacy-disabled   (from/to রেঞ্জ ফিল্টার)
//   S17 /bot-logs   S21 /fraud-logs                                    (from/to; আগে `<= to::date + 1 day` — মধ্যরাতের ঠিক সারিও ঢুকত)
//   S18 /bets (আজ স্টেক ও P&L)   S19 /api/bets-live   S20 /bot-monitoring (আজকের bot_activity_logs)
// আসল Postgres + আসল HTTP; টাকা/বেট হিসাব অপরিবর্তিত — শুধু কোন দিনের সারি কোন ফিল্টার/কার্ডে পড়ে।
//
// ফিল্টার-টেস্ট (S15–S17, S21): স্থির দিন D = 2026-03-10 (BD), ঘড়ি-নিরপেক্ষ। সিড: BEFORE/AFTER/LATE/EDGE/NEXT (_adminBd.js দেখুন)।
//   সঠিক = D-তে AFTER ও LATE; BEFORE (BD ৯ মার্চ) ও EDGE (ঠিক BD ১১ মার্চ ০০:০০:০০) ও NEXT বাদ।
//   পুরোনো (UTC) কোডে উল্টো: AFTER বাদ পড়ে, EDGE/NEXT ঢোকে।
// "আজ"-কার্ড (S18–S20): (ক) বাস্তব ঘড়ির BD মধ্যরাতের দুই পাশ, (খ) স্থির ঘড়ি (BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০)।
const bt = require('../../utils/businessTime');
const { at } = require('./_bdClock');
const { newCtx, SEED, D } = require('./_adminBd');

jest.setTimeout(120000);

const c = newCtx('ALF');
const ts = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const T0 = bt.startOfDay();
const AFTER_R = ts(new Date(T0.getTime() + 30 * 60000));   // BD আজ ০০:৩০
const BEFORE_R = ts(new Date(T0.getTime() - 30 * 60000));  // BD গতকাল ২৩:৩০

beforeAll(async () => { c.installRenderSpy(); await c.login(); });
afterAll(() => c.cleanup());

const labelsOf = (rows, pick) => rows.map(pick).filter(v => v && v.startsWith(`${c.TAG}-`))
  .map(v => v.slice(c.TAG.length + 1)).sort();
const SORTED_D = ['AFTER', 'LATE'];

describe('ফিল্টার-রেঞ্জ: from=to=২০২৬-০৩-১০ (BD দিন) — স্থির তারিখ', () => {
  beforeAll(async () => {
    for (const [k, when] of Object.entries(SEED)) {
      await c.dep('deposit', k, when, 10, 'approved');
      await c.dep('withdraw', k, when, 10, 'approved');
      await c.botLog(k, when);
      await c.fraudFlag(k, when);
    }
  });

  test('S15 জমা (legacy-disabled): D-তে শুধু AFTER, LATE', async () => {
    const o = await c.page(`/admin/deposits/legacy-disabled?from=${D}&to=${D}`, 'admin/deposits');
    expect(labelsOf(o.recentDeposits, r => r.transaction_id)).toEqual(SORTED_D);
  });
  test('S15 জমা: শুধু from — D থেকে পরে: AFTER, LATE, EDGE, NEXT (BEFORE নয়)', async () => {
    const o = await c.page(`/admin/deposits/legacy-disabled?from=${D}`, 'admin/deposits');
    expect(labelsOf(o.recentDeposits, r => r.transaction_id)).toEqual(['AFTER', 'EDGE', 'LATE', 'NEXT']);
  });
  test('S16 উত্তোলন (legacy-disabled): D-তে শুধু AFTER, LATE', async () => {
    const o = await c.page(`/admin/withdrawals/legacy-disabled?from=${D}&to=${D}`, 'admin/withdrawals');
    expect(labelsOf(o.recentWithdrawals, r => r.transaction_id)).toEqual(SORTED_D);
  });
  test('S16 উত্তোলন: শুধু to — D পর্যন্ত: BEFORE, AFTER, LATE (EDGE, NEXT নয়)', async () => {
    const o = await c.page(`/admin/withdrawals/legacy-disabled?to=${D}`, 'admin/withdrawals');
    const got = labelsOf(o.recentWithdrawals, r => r.transaction_id);
    expect(got).toEqual(expect.arrayContaining(['AFTER', 'BEFORE', 'LATE']));
    expect(got).not.toContain('EDGE'); expect(got).not.toContain('NEXT');
  });
  test('S17 bot-logs: D-তে শুধু AFTER, LATE — মধ্যরাতের ঠিক সারি (EDGE) বাদ', async () => {
    const o = await c.page(`/admin/bot-logs?from=${D}&to=${D}&ip=203.0.113.77`, 'admin/bot-logs');
    expect(labelsOf(o.logs, r => r.reason)).toEqual(SORTED_D);
  });
  test('S21 fraud-logs: D-তে শুধু AFTER, LATE — মধ্যরাতের ঠিক সারি (EDGE) বাদ', async () => {
    const o = await c.page(`/admin/fraud-logs?from=${D}&to=${D}&user_id=${c.adminId}`, 'admin/fraud-logs');
    expect(labelsOf(o.logs, r => r.reason)).toEqual(SORTED_D);
  });
});

describe('(ক) "আজ"-কার্ড — বাস্তব ঘড়ি, BD মধ্যরাতের দুই পাশ', () => {
  let b0, l0, m0;
  beforeAll(async () => {
    b0 = await c.page('/admin/bets', 'admin/bets');
    l0 = await c.json('/admin/api/bets-live');
    m0 = await c.page('/admin/bot-monitoring', 'admin/bot-monitoring');
    await c.bet('RB', BEFORE_R, 1000, 'lost');
    await c.bet('RA', AFTER_R, 20000, 'lost');
    await c.bet('RW', AFTER_R, 3000, 'won', 2);
    await c.botLog('RB', BEFORE_R, true); await c.botLog('RA', AFTER_R, true);
  });

  test('S18 /bets: আজ স্টেক = শুধু AFTER (২৩০০০); আজ GGR = ২৩০০০ − ৬০০০', async () => {
    const b1 = await c.page('/admin/bets', 'admin/bets');
    expect(b1.todayStake - b0.todayStake).toBe(23000);
    expect(b1.todayGgr - b0.todayGgr).toBe(17000);
  });
  test('S19 /api/bets-live: একই', async () => {
    const l1 = await c.json('/admin/api/bets-live');
    expect(l1.todayStake - l0.todayStake).toBe(23000);
    expect(l1.todayGgr - l0.todayGgr).toBe(17000);
  });
  test('S20 /bot-monitoring: আজকের bot_activity_logs — শুধু AFTER', async () => {
    const m1 = await c.page('/admin/bot-monitoring', 'admin/bot-monitoring');
    expect(Number(m1.statsToday.total) - Number(m0.statsToday.total)).toBe(1);
    expect(Number(m1.statsToday.blocked) - Number(m0.statsToday.blocked)).toBe(1);
  });
});

describe('(খ) "আজ"-কার্ড — স্থির ঘড়ি (BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০)', () => {
  const A = '2026-03-10T17:59:30Z', B = '2026-03-10T18:00:30Z';
  const ROW = '2026-03-09 19:00:00'; // BD ১০ মার্চ ০১:০০
  const read = async () => ({
    bets: await c.page('/admin/bets', 'admin/bets'),
    live: await c.json('/admin/api/bets-live'),
    mon: await c.page('/admin/bot-monitoring', 'admin/bot-monitoring')
  });
  let baseA, baseB, xa, xb;
  beforeAll(async () => {
    baseA = await at(A, read); baseB = await at(B, read);
    await c.bet('FB', ROW, 400, 'lost');
    await c.botLog('F', ROW);
    xa = await at(A, read); xb = await at(B, read);
  });

  test('S18 /bets: ১০ মার্চ ০১:০০(BD)-এর বেট ২৩:৫৯:৩০-এ আজকের, ০০:০০:৩০-এ নয়', () => {
    expect(xa.bets.todayStake - baseA.bets.todayStake).toBe(400);
    expect(xa.bets.todayGgr - baseA.bets.todayGgr).toBe(400);
    expect(xb.bets.todayStake - baseB.bets.todayStake).toBe(0);
    expect(xb.bets.todayGgr - baseB.bets.todayGgr).toBe(0);
  });
  test('S19 /api/bets-live: একই', () => {
    expect(xa.live.todayStake - baseA.live.todayStake).toBe(400);
    expect(xa.live.todayGgr - baseA.live.todayGgr).toBe(400);
    expect(xb.live.todayStake - baseB.live.todayStake).toBe(0);
    expect(xb.live.todayGgr - baseB.live.todayGgr).toBe(0);
  });
  test('S20 /bot-monitoring: ২৩:৫৯:৩০-এ আজকের, ০০:০০:৩০-এ নয়', () => {
    expect(Number(xa.mon.statsToday.total) - Number(baseA.mon.statsToday.total)).toBe(1);
    expect(Number(xb.mon.statsToday.total) - Number(baseB.mon.statsToday.total)).toBe(0);
  });
});
