// K10 — probe (ডেডলক ভাঙা), ব্যর্থতা-গণনার নিয়ম (শুধু টাইমআউট/নেটওয়ার্ক/5xx/429; 4xx নয়), শুধু-পড়া probe।
jest.mock('../../services/autoSuspend', () => ({ recordOutcome: jest.fn() }));

const autoSuspendMock = require('../../services/autoSuspend');
const { integrationFetch } = require('../../utils/integrationHttp');

const resp = (status, ok = status >= 200 && status < 300) => ({ status, ok, headers: { get: () => null }, body: null });
let n = 0;
const uniq = () => `sports:t${Date.now()}_${n++}`; // প্রতি টেস্টে আলাদা নাম, যাতে breaker অবস্থা মেশে না

describe('ব্যর্থতা কী গোনা হয় (integrationFetch)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; autoSuspendMock.recordOutcome.mockClear(); });

  test('5xx = ব্যর্থতা', async () => {
    global.fetch = jest.fn(async () => resp(503));
    const name = uniq();
    await integrationFetch(name, 'http://x.invalid/a');
    expect(autoSuspendMock.recordOutcome).toHaveBeenCalledWith(name, false, { rateLimited: false });
  });

  test('429 = ব্যর্থতা + rateLimited চিহ্ন', async () => {
    global.fetch = jest.fn(async () => resp(429));
    const name = uniq();
    await integrationFetch(name, 'http://x.invalid/a');
    expect(autoSuspendMock.recordOutcome).toHaveBeenCalledWith(name, false, { rateLimited: true });
  });

  test.each([400, 401, 403, 404, 422])('4xx (%i) গোনা হয় না — ব্যর্থতাও না, সফলতাও না', async (status) => {
    global.fetch = jest.fn(async () => resp(status));
    await integrationFetch(uniq(), 'http://x.invalid/a');
    expect(autoSuspendMock.recordOutcome).not.toHaveBeenCalled();
  });

  test('2xx = সফল', async () => {
    global.fetch = jest.fn(async () => resp(200));
    const name = uniq();
    await integrationFetch(name, 'http://x.invalid/a');
    expect(autoSuspendMock.recordOutcome).toHaveBeenCalledWith(name, true, { rateLimited: false });
  });

  test('নেটওয়ার্ক ত্রুটি = ব্যর্থতা', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
    const name = uniq();
    await expect(integrationFetch(name, 'http://x.invalid/a')).rejects.toThrow();
    expect(autoSuspendMock.recordOutcome).toHaveBeenCalledWith(name, false);
  });

  test('টাইমআউট = ব্যর্থতা', async () => {
    global.fetch = jest.fn((url, opts) => new Promise((_, rej) => {
      opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    }));
    const name = uniq();
    await expect(integrationFetch(name, 'http://x.invalid/a', {}, { timeoutMs: 30 })).rejects.toThrow();
    expect(autoSuspendMock.recordOutcome).toHaveBeenCalledWith(name, false);
  });
});

// ---------- probe ও নিজে-খোলা (আসল autoSuspend, মেমরি-স্টোর) ----------
describe('probe', () => {
  const actual = jest.requireActual('../../services/autoSuspend');

  function memoryStore(clock) {
    const rows = new Map();
    return {
      rows,
      async get(n) { return rows.get(n) || null; },
      async list() { return [...rows.values()]; },
      async suspend(n, { source, reason, detail }) {
        const prev = rows.get(n);
        const row = { name: n, suspended: true, source, reason, detail, suspended_at: prev && prev.suspended ? prev.suspended_at : new Date(clock.t), success_streak: 0, suspend_count: 1 };
        rows.set(n, row);
        return { transitioned: !(prev && prev.suspended), state: row };
      },
      async bumpSuccess(n) { const r = rows.get(n); if (!r || !r.suspended || r.source !== 'auto') return null; r.success_streak += 1; return { ...r }; },
      async resetStreak(n) { const r = rows.get(n); if (r && r.suspended && r.source === 'auto') r.success_streak = 0; },
      async resume(n) { const r = rows.get(n); if (!r || !r.suspended) return null; r.suspended = false; r.success_streak = 0; return { ...r }; }
    };
  }
  function setup() {
    const clock = { t: 1_000_000 };
    const store = memoryStore(clock);
    const svc = actual.createAutoSuspend({ store, now: () => clock.t, env: { AUTO_SUSPEND_CACHE_TTL_MS: '1' }, logger: { warn: () => {} }, audit: async () => {} });
    return { svc, store, clock };
  }
  const trip = async (svc, clock, name) => { for (let i = 0; i < 5; i++) { await svc.recordOutcome(name, false); clock.t += 10; } };

  test('ডিফল্ট probe ব্যবধান ২ মিনিট', () => {
    expect(actual.resolveConfig({}).probeIntervalMs).toBe(120000);
  });

  test('সাসপেন্ড অবস্থায় probe প্রতি ২ মিনিটে একবার; টানা ৩ সফল probe-এ নিজে খোলে (স্পোর্টস ও ক্যাসিনো)', async () => {
    for (const name of ['sports:cricapi', 'sports:rapidapi', 'casino:db-games']) {
      const { svc, clock } = setup();
      const probe = jest.fn(async () => { await svc.recordOutcome(name, true); });
      svc.registerProbe(name, probe);
      await trip(svc, clock, name);
      expect(await svc.isSuspended(name)).toBe(true);

      expect(await svc.runProbes()).toBe(1);           // t0: probe #1
      clock.t += 60000;
      expect(await svc.runProbes()).toBe(0);           // ২ মিনিটের আগে নয়
      expect(probe).toHaveBeenCalledTimes(1);
      clock.t += 60000;
      expect(await svc.runProbes()).toBe(1);           // probe #2
      expect(await svc.isSuspended(name)).toBe(true);  // ২টায় নয়
      clock.t += 120000;
      expect(await svc.runProbes()).toBe(1);           // probe #3 → খোলে
      expect(await svc.isSuspended(name)).toBe(false);
    }
  });

  test('মাঝে ব্যর্থ probe ধারা শূন্য করে', async () => {
    const { svc, clock } = setup();
    const name = 'sports:cricapi';
    let okNext = true;
    svc.registerProbe(name, async () => { await svc.recordOutcome(name, okNext); });
    await trip(svc, clock, name);
    await svc.runProbes(); clock.t += 120000;
    await svc.runProbes(); clock.t += 120000;
    okNext = false; await svc.runProbes(); clock.t += 120000;   // ব্যর্থ → ধারা ০
    okNext = true;
    await svc.runProbes(); clock.t += 120000;
    await svc.runProbes(); clock.t += 120000;
    expect(await svc.isSuspended(name)).toBe(true);             // মাত্র ২ টানা সফল
    await svc.runProbes();
    expect(await svc.isSuspended(name)).toBe(false);            // ৩ টানা
  });

  test('হাতে সাসপেন্ডে probe চলে না', async () => {
    const { svc } = setup();
    const probe = jest.fn();
    svc.registerProbe('sports:cricapi', probe);
    await svc.manualSuspend('sports:cricapi', { by: 'admin', byId: 1 });
    expect(await svc.runProbes()).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });
});

// ---------- স্পোর্টস probe শুধু-পড়া ----------
describe('sportsAPI probe শুধু-পড়া', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.resetModules(); });

  test('একটা GET, বডি/মেথড নেই, ক্যাশে লেখে না, ইউজার/বাজি/ওয়ালেট ছোঁয় না', async () => {
    process.env.CRICKET_API_KEY = 'k_test_dummy';
    process.env.RAPIDAPI_KEY = 'k_test_dummy';
    const query = jest.fn();
    jest.doMock('../../db', () => ({ pool: { query, connect: query } }));
    const calls = [];
    global.fetch = jest.fn(async (url, opts = {}) => { calls.push({ url: String(url), opts }); return { status: 200, ok: true, headers: { get: () => 'application/json' }, body: null, json: async () => ({ data: [{ id: 1 }] }) }; });
    const api = require('../../services/sportsAPI');
    await api.probeCricket();
    await api.probeFootball();
    expect(calls).toHaveLength(2);
    for (const c of calls) { expect(c.opts.method === undefined || c.opts.method === 'GET').toBe(true); expect(c.opts.body).toBeUndefined(); }
    // শুধু বিদ্যমান API-স্বাস্থ্য রেকর্ড (integration_status/integration_suspend); ইউজার, বাজি, ওয়ালেট, লেনদেন টেবিল কখনো নয়
    for (const [sql] of query.mock.calls) {
      expect(String(sql)).toMatch(/integration_status|integration_suspend/);
      expect(String(sql)).not.toMatch(/\b(users|bets|wallets?|transactions|accumulator\w*|game_sessions|payment_requests)\b/i);
    }
    // ক্যাশে কিছু লেখা হয়নি: এখন স্বাভাবিক ফাংশন আবার আপস্ট্রিমে যায়
    await api.getCricketCurrentMatches();
    expect(calls).toHaveLength(3);
  });

  test('কী না থাকলে কোনো কল নেই', async () => {
    delete process.env.CRICKET_API_KEY; delete process.env.RAPIDAPI_KEY;
    global.fetch = jest.fn();
    const api = require('../../services/sportsAPI');
    await api.probeCricket(); await api.probeFootball();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('scheduler probe জবে স্পোর্টস probe নিবন্ধিত; payment/wallet নয়', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../services/scheduler.js'), 'utf8');
    const i = src.indexOf('integration_suspend_probe: {');
    const block = src.slice(i, src.indexOf('system_health_check: {', i));
    expect(block).toMatch(/registerProbe\('sports:cricapi'/);
    expect(block).toMatch(/registerProbe\('sports:rapidapi'/);
    expect(block).not.toMatch(/payment:|wallet:/);
  });
});
