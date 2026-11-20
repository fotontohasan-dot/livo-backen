// admin রিপোর্ট/লগে from/to-এ 2026-3-5 ধরনের ইনপুট: এরর পেজ নয় — স্বয়ংক্রিয় সংশোধন বা বন্ধুত্বপূর্ণ বার্তা।
// আসল Postgres + আসল HTTP।
const { newCtx, SEED, D, num } = require('./_adminBd');

jest.setTimeout(120000);
const c = newCtx('ADF');

beforeAll(async () => {
  c.installRenderSpy(); await c.login();
  await c.dep('deposit', 'DAFTER', SEED.AFTER, 20);
  await c.dep('deposit', 'DNEXT', SEED.NEXT, 50000);
  await c.loginLog('AFTER', SEED.AFTER);
  await c.loginLog('NEXT', SEED.NEXT);
});
afterAll(() => c.cleanup());

describe('/admin/reports', () => {
  test('2026-3-10 (শূন্য ছাড়া) ও 2026-03-10 একই ফল দেয়, loadError নয়', async () => {
    const strict = await c.page(`/admin/reports?from=${D}&to=${D}`, 'admin/reports');
    const loose = await c.page('/admin/reports?from=2026-3-10&to=2026/3/10', 'admin/reports');
    expect(num(loose.deposits.total)).toBe(num(strict.deposits.total));
    expect(num(loose.deposits.cnt)).toBe(num(strict.deposits.cnt));
    expect(loose.from || D).toBe(D);
  });
  test('অর্থহীন তারিখে ৫০০ নয়: পেজ রেন্ডার হয় (ফিল্টার বাদ)', async () => {
    const r = await c.agent.get('/admin/reports?from=abc&to=2026-02-30');
    expect(r.status).toBe(200);
  });
});

describe('/admin/login-history', () => {
  test('2026-3-10 → শুধু BD ১০ মার্চের সারি', async () => {
    const o = await c.page(`/admin/login-history?q=${c.TAG}&from=2026-3-10&to=2026-3-10`, 'admin/login-history');
    expect(o.logs.map(r => r.location).filter(Boolean).map(v => v.slice(c.TAG.length + 1))).toEqual(['AFTER']);
  });
  test('অচেনা তারিখেও ৫০০ নয়', async () => {
    const r = await c.agent.get(`/admin/login-history?q=${c.TAG}&from=10-03-2026`);
    expect(r.status).toBe(200);
  });
});
