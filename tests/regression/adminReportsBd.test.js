// tests/regression/adminReportsBd.test.js
// routes/admin.js /reports ও লগ-এক্সপোর্ট (docs/admin-report-dates-bd-5.md-এর S22–S26) এখন Asia/Dhaka ব্যবসায়িক দিনে:
//   S22 /reports রিপোর্ট-রেঞ্জ (ডিফল্ট from/to + ডিপোজিট/উইথড্র/বেট/নতুন-ইউজার চার কোয়েরির `BETWEEN`)
//   S23 /reports দৈনিক গ্রুপিং (ggrTrend staked/payout, userTrend নতুন ইউজার)
//   S24 /login-history   S25 /api-logs   S26 /api-logs/export.csv   (from/to; আগে `<= to::date + 1 day`)
// আসল Postgres + আসল HTTP; টাকা/বেট হিসাব অপরিবর্তিত — শুধু কোন দিনের সারি কোন বাকেটে পড়ে।
//
// স্থির দিন D = 2026-03-10 (BD)। সিড: BEFORE/AFTER/LATE/EDGE/NEXT (_adminBd.js)। সঠিক D-বাকেট = AFTER + LATE;
// BEFORE = ৯ মার্চ; EDGE (ঠিক BD ১১ মার্চ ০০:০০:০০) ও NEXT = ১১ মার্চ। পুরোনো (UTC) কোডে এগুলো ৯/১০ মার্চে ভুল জায়গায় পড়ত।
// ডিফল্ট-রেঞ্জ টেস্টে স্থির ঘড়ি: BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০।
const { at } = require('./_bdClock');
const { newCtx, SEED, D, entry, num } = require('./_adminBd');

jest.setTimeout(120000);

const c = newCtx('ARB');
const AMT = { BEFORE: 1, AFTER: 20, LATE: 300, EDGE: 4000, NEXT: 50000 };
const rep = (qs = '') => c.page(`/admin/reports${qs}`, 'admin/reports');

beforeAll(async () => { c.installRenderSpy(); await c.login(); });
afterAll(() => c.cleanup());

describe('S22–S23 /reports', () => {
  let r0, t0;
  beforeAll(async () => {
    r0 = await rep(`?from=${D}&to=${D}`);
    t0 = await rep('?from=2026-03-09&to=2026-03-11');
    for (const [k, when] of Object.entries(SEED)) {
      await c.dep('deposit', `D${k}`, when, AMT[k]);
      await c.dep('withdraw', `W${k}`, when, AMT[k] * 2);
      await c.bet(`B${k}`, when, AMT[k], 'lost');
      await c.newUser(k.toLowerCase(), when);
    }
    await c.bet('BWON', SEED.AFTER, 1000, 'won', 2); // AFTER-এর দিনে: স্টেক ১০০০, পে-আউট ২০০০
  });

  test('S22 রেঞ্জ from=to=D: ডিপোজিট/উইথড্র/বেট/নতুন ইউজার — শুধু AFTER + LATE', async () => {
    const r1 = await rep(`?from=${D}&to=${D}`);
    expect(num(r1.deposits.total) - num(r0.deposits.total)).toBe(320);
    expect(num(r1.deposits.cnt) - num(r0.deposits.cnt)).toBe(2);
    expect(num(r1.withdrawals.total) - num(r0.withdrawals.total)).toBe(640);
    expect(num(r1.withdrawals.cnt) - num(r0.withdrawals.cnt)).toBe(2);
    expect(num(r1.bets.total_stake) - num(r0.bets.total_stake)).toBe(1320);
    expect(num(r1.bets.cnt) - num(r0.bets.cnt)).toBe(3);
    expect(num(r1.bets.total_payout) - num(r0.bets.total_payout)).toBe(2000);
    expect(num(r1.newUsers) - num(r0.newUsers)).toBe(2);
  });
  test('S23 দৈনিক GGR ট্রেন্ড: ৯ মার্চ = ১; ১০ মার্চ = (২০+৩০০+১০০০) − ২০০০; ১১ মার্চ = ৪০০০+৫০০০০', async () => {
    const t1 = await rep('?from=2026-03-09&to=2026-03-11');
    const g = (t, day) => num(entry(t.ggrTrend, day).ggr);
    expect(g(t1, '2026-03-09') - g(t0, '2026-03-09')).toBe(1);
    expect(g(t1, '2026-03-10') - g(t0, '2026-03-10')).toBe(-680);
    expect(g(t1, '2026-03-11') - g(t0, '2026-03-11')).toBe(54000);
  });
  test('S23 দৈনিক নতুন-ইউজার ট্রেন্ড: ৯ মার্চ +১, ১০ মার্চ +২, ১১ মার্চ +২', async () => {
    const t1 = await rep('?from=2026-03-09&to=2026-03-11');
    const u = (t, day) => num(entry(t.userTrend, day).count);
    expect(u(t1, '2026-03-09') - u(t0, '2026-03-09')).toBe(1);
    expect(u(t1, '2026-03-10') - u(t0, '2026-03-10')).toBe(2);
    expect(u(t1, '2026-03-11') - u(t0, '2026-03-11')).toBe(2);
  });
});

describe('S24–S26 লগ ফিল্টার/এক্সপোর্ট: from=to=২০২৬-০৩-১০ (BD দিন)', () => {
  beforeAll(async () => {
    for (const [k, when] of Object.entries(SEED)) { await c.loginLog(k, when); await c.apiLog(k, when); }
  });
  const sorted = ['AFTER', 'LATE'];

  test('S24 login-history: শুধু AFTER, LATE — মধ্যরাতের ঠিক সারি (EDGE) বাদ', async () => {
    const o = await c.page(`/admin/login-history?q=${c.TAG}&from=${D}&to=${D}`, 'admin/login-history');
    expect(o.logs.map(r => r.location).filter(Boolean).map(v => v.slice(c.TAG.length + 1)).sort()).toEqual(sorted);
  });
  test('S25 api-logs: শুধু AFTER, LATE', async () => {
    const o = await c.page(`/admin/api-logs?endpoint=${c.TAG}&from=${D}&to=${D}`, 'admin/api-logs');
    expect(o.logs.map(r => r.endpoint.split('/').pop()).sort()).toEqual(sorted);
  });
  test('S26 api-logs/export.csv: শুধু AFTER, LATE', async () => {
    const r = await c.agent.get(`/admin/api-logs/export.csv?endpoint=${c.TAG}&from=${D}&to=${D}`);
    expect(r.status).toBe(200);
    const got = Object.keys(SEED).filter(k => r.text.includes(`/${c.TAG}/${k}"`)).sort();
    expect(got).toEqual(sorted);
  });
});

// স্থির ঘড়ির টেস্ট সবার শেষে: `at()`-এর ভেতরে তৈরি সেশন বাস্তব ঘড়িতে মেয়াদোত্তীর্ণ হয়, তাই পরে আর লগইন-নির্ভর টেস্ট চলে না।
describe('S22 ডিফল্ট রেঞ্জ — স্থির ঘড়ি (BD ১০ মার্চ ২৩:৫৯:৩০ বনাম ১১ মার্চ ০০:০০:৩০)', () => {
  test('S22 ডিফল্ট রেঞ্জ: to = BD আজ, from = BD আজ−৩০ (২৩:৫৯:৩০ → ১০ মার্চ; ০০:০০:৩০ → ১১ মার্চ)', async () => {
    const x = await at('2026-03-10T17:59:30Z', () => rep());
    const y = await at('2026-03-10T18:00:30Z', () => rep());
    expect([x.from, x.to]).toEqual(['2026-02-08', '2026-03-10']);
    expect([y.from, y.to]).toEqual(['2026-02-09', '2026-03-11']);
  });
});
