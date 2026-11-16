// K10 — অটো-সাসপেন্ড: API ডাউনে বন্ধ, ঠিক হলে খোলে, একটা ব্যর্থতায় নয়, flapping নেই, payment/wallet কখনো নয়, প্রোভাইডার আলাদা।
const { createAutoSuspend, isSuspendable, evaluateTrip, resolveConfig } = require('../../services/autoSuspend');

function memoryStore(clock) {
  const rows = new Map();
  return {
    rows,
    async get(n) { return rows.get(n) || null; },
    async list() { return [...rows.values()]; },
    async suspend(n, { source, reason, detail, by }) {
      const prev = rows.get(n);
      if (prev && prev.suspended && prev.source === 'manual' && source === 'auto') return null;
      const row = {
        name: n, suspended: true, source, reason, detail, updated_by: by || null,
        suspended_at: prev && prev.suspended ? prev.suspended_at : new Date(clock.t),
        success_streak: 0, suspend_count: (prev ? prev.suspend_count : 0) + (prev && prev.suspended ? 0 : 1)
      };
      rows.set(n, row);
      return { transitioned: !(prev && prev.suspended), state: row };
    },
    async bumpSuccess(n) {
      const r = rows.get(n);
      if (!r || !r.suspended || r.source !== 'auto') return null;
      r.success_streak += 1; return { ...r };
    },
    async resetStreak(n) { const r = rows.get(n); if (r && r.suspended && r.source === 'auto') r.success_streak = 0; },
    async resume(n, { onlyAuto }) {
      const r = rows.get(n);
      if (!r || !r.suspended || (onlyAuto && r.source !== 'auto')) return null;
      r.suspended = false; r.success_streak = 0; return { ...r };
    }
  };
}

function setup(envOver = {}, breakers = null) {
  const clock = { t: 1_000_000 };
  const store = memoryStore(clock);
  const audit = jest.fn(async () => {});
  const env = { AUTO_SUSPEND_CACHE_TTL_MS: '1', ...envOver };
  const svc = createAutoSuspend({ store, now: () => clock.t, env, logger: { warn: () => {} }, breakers, audit });
  const tick = (ms) => { clock.t += ms; };
  return { svc, store, clock, tick, audit };
}

const fail = async (svc, name, n, tick) => { for (let i = 0; i < n; i++) { await svc.recordOutcome(name, false); tick && tick(10); } };
const ok = async (svc, name, n, tick) => { for (let i = 0; i < n; i++) { await svc.recordOutcome(name, true); tick && tick(10); } };

describe('সাসপেন্ডযোগ্যতা', () => {
  test('payment:* ও wallet:* কখনো নয়; sports/casino/sms/email হ্যাঁ', () => {
    for (const n of ['payment:sslcommerz', 'wallet:bkash', 'wallet:nagad', 'payment:anything']) expect(isSuspendable(n)).toBe(false);
    for (const n of ['sports:cricapi', 'sports:rapidapi', 'casino:db-games', 'sms', 'email']) expect(isSuspendable(n)).toBe(true);
    expect(isSuspendable('cloudinary')).toBe(false);
    expect(isSuspendable('telegram')).toBe(false);
  });
});

describe('সাসপেন্ড শর্ত', () => {
  test('একটা ব্যর্থতায় বন্ধ হয় না; ৪টায়ও নয়; টানা ৫-এ হয়', async () => {
    const { svc, tick } = setup();
    await fail(svc, 'sports:cricapi', 1, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
    await fail(svc, 'sports:cricapi', 3, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
    await fail(svc, 'sports:cricapi', 1, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(true);
  });
  test('মাঝে একটা সফল কল টানা-ব্যর্থতা শূন্য করে', async () => {
    const { svc, tick } = setup();
    await fail(svc, 'sports:cricapi', 4, tick);
    await ok(svc, 'sports:cricapi', 1, tick);
    await fail(svc, 'sports:cricapi', 4, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
  });
  test('উইন্ডোতে ≥৫০% ব্যর্থতা (ন্যূনতম ১০ কল) → সাসপেন্ড', async () => {
    const { svc, tick } = setup();
    for (let i = 0; i < 5; i++) { await ok(svc, 'sports:rapidapi', 1, tick); await fail(svc, 'sports:rapidapi', 1, tick); }
    expect(await svc.isSuspended('sports:rapidapi')).toBe(true);
  });
  test('অনেক আগের (>১০ মিনিট) ব্যর্থতার সাথে ১টা নতুন ব্যর্থতা জুড়ে "টানা ৫" হয় না', async () => {
    const { svc, tick } = setup();
    await fail(svc, 'sports:cricapi', 4, tick);
    tick(11 * 60 * 1000);
    await fail(svc, 'sports:cricapi', 1, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
  });
  test('উইন্ডোর বাইরের পুরনো ব্যর্থতা error-rate-এ গোনা হয় না', async () => {
    // ৪টা ব্যর্থ + ৮টা সফল (মোট ১২ কল, হার <৫০%), উইন্ডো পেরিয়ে ১টা ব্যর্থ → সাসপেন্ড নয়
    const ctx = setup();
    for (let i = 0; i < 4; i++) { await ok(ctx.svc, 'sports:cricapi', 1, ctx.tick); await ctx.svc.recordOutcome('sports:cricapi', false); ctx.tick(10); await ok(ctx.svc, 'sports:cricapi', 1, ctx.tick); }
    ctx.tick(61000);
    await ctx.svc.recordOutcome('sports:cricapi', false);
    expect(await ctx.svc.isSuspended('sports:cricapi')).toBe(false);
  });
  test('রেট-লিমিট (429) বারবার → সাসপেন্ড, reason rate_limited', async () => {
    const { svc, tick, store } = setup();
    for (let i = 0; i < 3; i++) { await svc.recordOutcome('sports:cricapi', false, { rateLimited: true }); tick(10); }
    expect(await svc.isSuspended('sports:cricapi')).toBe(true);
    expect(store.rows.get('sports:cricapi').reason).toMatch(/rate_limited|consecutive_failures/);
  });
  test('সীমা env থেকে বদলানো যায়', async () => {
    const { svc, tick } = setup({ AUTO_SUSPEND_CONSECUTIVE_FAILURES: '2' });
    await fail(svc, 'sms', 2, tick);
    expect(await svc.isSuspended('sms')).toBe(true);
  });
  test('breaker OPEN সংকেতে সাসপেন্ড; closed/half_open-এ নয়', async () => {
    const { svc } = setup();
    await svc.onBreakerChange({ name: 'casino:db-games', from: 'half_open', to: 'closed' });
    expect(await svc.isSuspended('casino:db-games')).toBe(false);
    await svc.onBreakerChange({ name: 'casino:db-games', from: 'closed', to: 'open', reason: 'consecutive failures 5' });
    expect(await svc.isSuspended('casino:db-games')).toBe(true);
  });
  test('AUTO_SUSPEND_ENABLED=false হলে auto সাসপেন্ড হয় না', async () => {
    const { svc, tick } = setup({ AUTO_SUSPEND_ENABLED: 'false' });
    await fail(svc, 'sports:cricapi', 10, tick);
    await svc.onBreakerChange({ name: 'sports:cricapi', to: 'open' });
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
  });
  test('payment:*/wallet:* ব্যর্থতা যতই হোক সাসপেন্ড হয় না, breaker OPEN-এও না', async () => {
    const { svc, tick, store } = setup();
    await fail(svc, 'payment:sslcommerz', 50, tick);
    await fail(svc, 'wallet:bkash', 50, tick);
    await svc.onBreakerChange({ name: 'payment:sslcommerz', to: 'open' });
    expect(await svc.isSuspended('payment:sslcommerz')).toBe(false);
    expect(await svc.isSuspended('wallet:bkash')).toBe(false);
    expect(store.rows.size).toBe(0);
    await expect(svc.manualSuspend('payment:sslcommerz', { by: 'admin' })).rejects.toMatchObject({ code: 'NOT_SUSPENDABLE' });
    await expect(svc.manualSuspend('wallet:nagad', { by: 'admin' })).rejects.toMatchObject({ code: 'NOT_SUSPENDABLE' });
  });
  test('একটা প্রোভাইডার সাসপেন্ড হলে অন্যটা চলে', async () => {
    const { svc, tick } = setup();
    await fail(svc, 'casino:alpha', 5, tick);
    expect(await svc.isSuspended('casino:alpha')).toBe(true);
    expect(await svc.isSuspended('casino:beta')).toBe(false);
    expect([...(await svc.suspendedCasinoProviders())]).toEqual(['alpha']);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
  });
});

describe('নিজে চালু হওয়া ও flapping', () => {
  async function suspended() {
    const ctx = setup();
    await fail(ctx.svc, 'sports:cricapi', 5, ctx.tick);
    expect(await ctx.svc.isSuspended('sports:cricapi')).toBe(true);
    return ctx;
  }
  test('ন্যূনতম বন্ধ থাকার সময় পেরোনোর আগে ৩ সফল কলেও খোলে না', async () => {
    const { svc, tick } = await suspended();
    await ok(svc, 'sports:cricapi', 5, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(true);
  });
  test('সময় পেরোলে ও ৩ সফল কলের পর খোলে; ২টায় নয়', async () => {
    const { svc, tick } = await suspended();
    tick(121000);
    await ok(svc, 'sports:cricapi', 2, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(true);
    await ok(svc, 'sports:cricapi', 1, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
  });
  test('মাঝে ব্যর্থতা এলে সফল-ধারা শূন্য হয়', async () => {
    const { svc, tick } = await suspended();
    tick(121000);
    await ok(svc, 'sports:cricapi', 2, tick);
    await fail(svc, 'sports:cricapi', 1, tick);
    await ok(svc, 'sports:cricapi', 2, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(true);
    await ok(svc, 'sports:cricapi', 1, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
  });
  test('breaker এখনো closed না হলে খোলে না', async () => {
    const breakers = { getAllBreakerSnapshots: () => [{ name: 'sports:cricapi', state: 'half_open' }] };
    const { svc, tick } = setup({}, breakers);
    await fail(svc, 'sports:cricapi', 5, tick);
    tick(121000);
    await ok(svc, 'sports:cricapi', 5, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(true);
    breakers.getAllBreakerSnapshots = () => [{ name: 'sports:cricapi', state: 'closed' }];
    await ok(svc, 'sports:cricapi', 1, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
  });
  test('খোলার পর ১টা ব্যর্থতায় আবার বন্ধ হয় না (flapping নেই)', async () => {
    const { svc, tick } = await suspended();
    tick(121000);
    await ok(svc, 'sports:cricapi', 3, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
    await fail(svc, 'sports:cricapi', 1, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
    await fail(svc, 'sports:cricapi', 3, tick);
    expect(await svc.isSuspended('sports:cricapi')).toBe(false); // মোট ৪ < ৫
  });
});

describe('হাতে (manual) নিয়ন্ত্রণ', () => {
  test('হাতে বন্ধ করলে সফল কলে নিজে খোলে না; হাতে resume চলে; লগ হয়', async () => {
    const { svc, tick, audit } = setup();
    await svc.manualSuspend('casino:alpha', { by: 'admin1', byId: 7, reason: 'রক্ষণাবেক্ষণ' });
    tick(999999);
    await ok(svc, 'casino:alpha', 10, tick);
    expect(await svc.isSuspended('casino:alpha')).toBe(true);
    await svc.manualResume('casino:alpha', { by: 'admin1', byId: 7 });
    expect(await svc.isSuspended('casino:alpha')).toBe(false);
    const actions = audit.mock.calls.map((c) => c[2]);
    expect(actions).toEqual(['INTEGRATION_SUSPENDED', 'INTEGRATION_RESUMED']);
    expect(audit.mock.calls[0][0]).toBe(7);
  });
  test('auto সংকেত হাতের সাসপেন্ড বদলায় না', async () => {
    const { svc, tick, store } = setup();
    await svc.manualSuspend('sports:cricapi', { by: 'admin1' });
    await fail(svc, 'sports:cricapi', 6, tick);
    expect(store.rows.get('sports:cricapi').source).toBe('manual');
  });
});

describe('ফেইল-ওপেন ও পরিষ্কার', () => {
  test('স্টোর ব্যর্থ হলে isSuspended=false, recordOutcome throw করে না', async () => {
    const store = { get: async () => { throw new Error('db down'); }, list: async () => { throw new Error('db down'); } };
    const svc = createAutoSuspend({ store, env: {}, logger: { warn: () => {} } });
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
    await expect(svc.recordOutcome('sports:cricapi', false)).resolves.toBeUndefined();
    expect(await svc.listStates()).toEqual([]);
  });
  test('detail থেকে URL/টোকেন মুছে যায়', async () => {
    const { svc, store } = setup();
    await svc.onBreakerChange({ name: 'sms', to: 'open', reason: 'https://x.test/send?api_key=SECRETVALUE123456 failed' });
    expect(store.rows.get('sms').detail).not.toMatch(/SECRETVALUE|https?:\/\//);
  });
  test('evaluateTrip/resolveConfig ডিফল্ট', () => {
    const c = resolveConfig({});
    expect(c.consecutiveFailures).toBe(5);
    expect(c.errorRate).toBe(0.5);
    expect(c.resumeSuccesses).toBe(3);
    expect(evaluateTrip({ consecutive: 0, window: [], rateLimited: [] }, c, 1)).toBeNull();
  });
});
