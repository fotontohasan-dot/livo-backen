// K10 — probe শুধু একজায়গা থেকে (প্রসেস-নির্বিশেষে): একাধিক web/worker প্রসেস একসাথে scheduler চালালেও (PROCESS_ROLE সেট না থাকলে
// ডিফল্ট `all` — প্রতিটা web ইনস্ট্যান্সেই scheduler চলে) একই সাসপেন্ড-হওয়া API-তে ব্যবধানে একটাই probe যায়।
// প্রতিটা "প্রসেস" = আলাদা createAutoSuspend (নিজস্ব লোকাল lastProbeAt/ক্যাশ) + একই Postgres।
const { pool } = require('../../db');
const { createAutoSuspend, pgStore } = require('../../services/autoSuspend');

const NAME = 'sports:cricapi';
const INTERVAL = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { AUTO_SUSPEND_CACHE_TTL_MS: '1', AUTO_SUSPEND_PROBE_INTERVAL_MS: String(INTERVAL) };
const quiet = { warn: () => {} };

function makeProcess(store) {
  const svc = createAutoSuspend({ store, env, logger: quiet, audit: async () => {} });
  const probe = jest.fn(async () => {});
  svc.registerProbe(NAME, probe);
  return { svc, probe };
}
const realStore = () => pgStore(pool);
const seedAutoSuspended = () => pool.query(
  `INSERT INTO integration_suspend (name, suspended, source, reason, suspended_at, updated_at, last_probe_at)
   VALUES ($1, true, 'auto', 'consecutive_failures', NOW(), NOW(), NULL)
   ON CONFLICT (name) DO UPDATE SET suspended = true, source = 'auto', reason = 'consecutive_failures', suspended_at = NOW(), last_probe_at = NULL`, [NAME]);
const total = (ps) => ps.reduce((a, p) => a + p.probe.mock.calls.length, 0);

beforeEach(seedAutoSuspended);
afterAll(async () => { await pool.query('DELETE FROM integration_suspend WHERE name = $1', [NAME]); });

describe('probe একক মালিক (শেয়ার্ড DB-দাবি)', () => {
  test('৩টা প্রসেস ঠিক একই মুহূর্তে runProbes ডাকলে মোট ১টা probe যায়', async () => {
    const ps = [makeProcess(realStore()), makeProcess(realStore()), makeProcess(realStore())];
    const ran = await Promise.all(ps.map((p) => p.svc.runProbes()));
    expect(total(ps)).toBe(1);
    expect(ran.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('ব্যবধানের মধ্যে বারবার টিক এলেও সব মিলে ১টা; ব্যবধান পেরোলে আবার ঠিক ১টা', async () => {
    const ps = [makeProcess(realStore()), makeProcess(realStore())];
    for (let i = 0; i < 3; i++) { await Promise.all(ps.map((p) => p.svc.runProbes())); await sleep(30); }
    expect(total(ps)).toBe(1);
    await sleep(INTERVAL + 100);
    for (let i = 0; i < 3; i++) { await Promise.all(ps.map((p) => p.svc.runProbes())); await sleep(30); }
    expect(total(ps)).toBe(2);
  });

  test('জেতা প্রসেসই probe চালায়; হারা প্রসেসের probe ফাংশন একবারও ডাকা হয় না', async () => {
    const [a, b] = [makeProcess(realStore()), makeProcess(realStore())];
    await a.svc.runProbes();       // a আগে → দাবি জেতে
    await b.svc.runProbes();       // b হারে (শেয়ার্ড সীমা)
    expect(a.probe).toHaveBeenCalledTimes(1);
    expect(b.probe).not.toHaveBeenCalled();
  });

  test('হাতে সাসপেন্ড/সাসপেন্ডহীন API-তে probe দাবিই হয় না', async () => {
    await pool.query("UPDATE integration_suspend SET source = 'manual' WHERE name = $1", [NAME]);
    const p = makeProcess(realStore());
    expect(await p.svc.runProbes()).toBe(0);
    await pool.query("UPDATE integration_suspend SET source = 'auto', suspended = false WHERE name = $1", [NAME]);
    expect(await p.svc.runProbes()).toBe(0);
    expect(p.probe).not.toHaveBeenCalled();
  });

  test('দাবি করতে DB-ত্রুটি হলে সেই টিকে probe নয় (ডুপ্লিকেটের চেয়ে বাদ নিরাপদ), পরের টিকে আবার চেষ্টা', async () => {
    let fail = true;
    const store = { ...realStore(), claimProbe: async (...a) => { if (fail) throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); return realStore().claimProbe(...a); } };
    const p = makeProcess(store);
    expect(await p.svc.runProbes()).toBe(0);
    expect(p.probe).not.toHaveBeenCalled();
    fail = false;
    expect(await p.svc.runProbes()).toBe(1);   // ত্রুটিতে লোকাল সীমা বসেনি, তাই পরের টিকেই চলে
    expect(p.probe).toHaveBeenCalledTimes(1);
  });

  test('প্রমাণ (আগের আচরণ): শেয়ার্ড দাবি ছাড়া ৩ প্রসেসে ৩টা probe যেত', async () => {
    const legacy = () => { const s = realStore(); delete s.claimProbe; return s; };
    const ps = [makeProcess(legacy()), makeProcess(legacy()), makeProcess(legacy())];
    await Promise.all(ps.map((p) => p.svc.runProbes()));
    expect(total(ps)).toBe(3);
  });
});
