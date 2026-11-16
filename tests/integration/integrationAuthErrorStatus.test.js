// K10 — আসল Postgres: 401/403 বারবার এলেও সাসপেন্ড হয় না (বর্তমান আচরণ অক্ষত), কিন্তু Integrations Status রিপোর্টে
// আলাদা "অথ ত্রুটি" সক্রিয় দেখায়; পরে একটা সফল কল এলে মিটে যায়।
process.env.AUTO_SUSPEND_CACHE_TTL_MS = '1';
const { pool } = require('../../db');
const status = require('../../services/integrationStatus');
const autoSuspend = require('../../services/autoSuspend');
const { integrationFetch } = require('../../utils/integrationHttp');

const NAME = 'sports:cricapi';
const resp = (code) => ({ status: code, ok: code >= 200 && code < 300, headers: { get: () => null }, body: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = async () => (await status.buildStatusReport()).integrations.find((i) => i.id === NAME);
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('শর্ত পূরণ হয়নি');
}

const realFetch = global.fetch;
beforeEach(async () => {
  status._lastAuthWrite.clear(); status._lastWrite.clear();
  await pool.query('DELETE FROM integration_status WHERE name = $1', [NAME]);
  await pool.query('DELETE FROM integration_suspend WHERE name = $1', [NAME]);
});
afterAll(async () => {
  global.fetch = realFetch;
  await pool.query('DELETE FROM integration_status WHERE name = $1', [NAME]);
  await pool.query('DELETE FROM integration_suspend WHERE name = $1', [NAME]);
});

describe('অথ ত্রুটি: সাসপেন্ড নয়, কিন্তু অ্যাডমিন রিপোর্টে দৃশ্যমান', () => {
  test.each([401, 403])('HTTP %i ১৫ বার এলেও সাসপেন্ড হয় না; রিপোর্টে অথ ত্রুটি সক্রিয়', async (code) => {
    global.fetch = jest.fn(async () => resp(code));
    for (let i = 0; i < 15; i++) {
      const r = await integrationFetch(NAME, 'http://x.invalid/a');
      expect(r.status).toBe(code);
      status._lastAuthWrite.clear(); status._lastWrite.clear(); // throttle বাদে প্রতিটা কল ব্যবহারের মতো গোনা
    }
    await sleep(300); // fire-and-forget লেখাগুলো শেষ হওয়া পর্যন্ত

    // ১) সাসপেন্ড হয়নি (বিদ্যমান আচরণ): না অটো-ট্র্যাকারে, না DB-তে
    expect(await autoSuspend.isSuspended(NAME)).toBe(false);
    expect((await pool.query('SELECT 1 FROM integration_suspend WHERE name = $1', [NAME])).rowCount).toBe(0);
    const rep = await entry();
    expect(rep.suspend.suspended).toBe(false);

    // ২) কিন্তু অথ ত্রুটি আলাদা অবস্থা হিসেবে সক্রিয়
    expect(rep.authError.active).toBe(true);
    expect(rep.authError.status).toBe(code);
    expect(rep.authError.count).toBeGreaterThanOrEqual(1);
    expect(rep.authError.lastAt).toBeTruthy();
  });

  test('সফল কল এলে অথ ত্রুটি মিটে যায় (সংখ্যা ইতিহাস হিসেবে থাকে); আবার ত্রুটি এলে আবার সক্রিয়', async () => {
    expect(await status.recordAuthError(NAME, 401)).toBe(true);
    let rep = await entry();
    expect(rep.authError).toMatchObject({ active: true, status: 401, count: 1 });

    await sleep(20);
    status._lastWrite.clear();
    status.recordIntegrationResult(NAME, true);           // API key ঠিক করার পরের সফল কল
    await waitFor(async () => (await entry()).lastSuccessAt);
    rep = await entry();
    expect(rep.authError.active).toBe(false);
    expect(rep.authError.count).toBe(1);

    await sleep(20);
    status._lastAuthWrite.clear();
    expect(await status.recordAuthError(NAME, 403)).toBe(true);
    rep = await entry();
    expect(rep.authError).toMatchObject({ active: true, status: 403, count: 2 });
  });

  test('রিপোর্টে কোনো গোপন মান/বার্তা নেই — authError-এ শুধু active/status/lastAt/count', async () => {
    await status.recordAuthError(NAME, 401);
    const rep = await entry();
    expect(Object.keys(rep.authError).sort()).toEqual(['active', 'count', 'lastAt', 'status']);
  });

  test('অথ ত্রুটি ছাড়া ইন্টিগ্রেশনে authError নিষ্ক্রিয় (সারি না থাকলেও রিপোর্ট ভাঙে না)', async () => {
    const rep = await entry();
    expect(rep.authError).toEqual({ active: false, status: null, lastAt: null, count: 0 });
  });
});
