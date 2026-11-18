// Redis কমান্ড-বাজেট প্যাচের ইউনিট টেস্ট (BULLMQ_ENABLED, logBatcher, L1 cache, session touch throttle)
describe('logBatcher', () => {
  test('একাধিক add একটা ব্যাচে লেখে, বাফার ফুল হলে ফেলে দেয়', async () => {
    const { createBatcher } = require('../../services/logBatcher');
    const calls = [];
    const b = createBatcher({ name: 't', flushMs: 60000, maxBatch: 100, maxBuffer: 3, writeRows: async (rows) => { calls.push(rows.length); } });
    expect(b.add(1)).toBe(true); expect(b.add(2)).toBe(true); expect(b.add(3)).toBe(true);
    expect(b.add(4)).toBe(false);
    await b.flush();
    expect(calls).toEqual([3]);
    expect(b.getStats()).toMatchObject({ written: 3, dropped: 1, buffered: 0 });
  });
  test('writeRows ব্যর্থ হলে throw করে না, dropped গোনে', async () => {
    const { createBatcher } = require('../../services/logBatcher');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const b = createBatcher({ name: 'f', flushMs: 60000, writeRows: async () => { throw new Error('db'); } });
    b.add(1);
    await expect(b.flush()).resolves.toBeUndefined();
    expect(b.getStats().failedBatches).toBe(1);
    spy.mockRestore();
  });
  test('buildInsert সঠিক placeholder বানায়', () => {
    const { buildInsert } = require('../../services/logBatcher');
    const q = buildInsert('t', ['a', 'b'], [{ x: 1, y: 2 }, { x: 3, y: 4 }], (r) => [r.x, r.y]);
    expect(q.text).toBe('INSERT INTO t (a, b) VALUES ($1,$2),($3,$4)');
    expect(q.params).toEqual([1, 2, 3, 4]);
  });
});

describe('BULLMQ_ENABLED=false', () => {
  afterEach(() => { delete process.env.BULLMQ_ENABLED; jest.resetModules(); });
  test('enqueueApiLog/enqueueActivityLog Redis ছাড়া batcher-এ যায়', async () => {
    process.env.BULLMQ_ENABLED = 'false';
    jest.resetModules();
    const add = jest.fn(() => true);
    jest.doMock('../../services/logBatcher', () => ({ getApiLogBatcher: () => ({ add }), getActivityLogBatcher: () => ({ add }) }));
    const p = require('../../queues/producers');
    expect(await p.enqueueApiLog({ a: 1 })).toMatchObject({ queued: false, batched: true });
    expect(await p.enqueueActivityLog({ b: 1 })).toMatchObject({ queued: false, batched: true });
    expect(add).toHaveBeenCalledTimes(2);
    jest.dontMock('../../services/logBatcher');
  });
  test('connection null থাকে (কোনো Redis client তৈরি হয় না)', () => {
    process.env.BULLMQ_ENABLED = 'false';
    process.env.REDIS_URL = 'redis://x:1';
    jest.resetModules();
    const c = require('../../queues/connection');
    expect(c.connection).toBeNull();
    expect(c.isQueueEnabled()).toBe(false);
    delete process.env.REDIS_URL;
  });
});

describe('cache L1', () => {
  afterEach(() => { delete process.env.CACHE_L1_TTL_SECONDS; delete process.env.REDIS_ENABLED; jest.resetModules(); });
  test('L1 চালু থাকলে fetchFn একবারই চলে, del() এ মোছে, caller-এর মিউটেশন ক্যাশ দূষিত করে না', async () => {
    process.env.CACHE_L1_TTL_SECONDS = '5'; process.env.REDIS_ENABLED = 'false';
    jest.resetModules();
    const cache = require('../../services/cache');
    let n = 0; const f = async () => ({ v: ++n });
    const a = await cache.getOrSet('k', 60, f); a.v = 99;
    expect(await cache.getOrSet('k', 60, f)).toEqual({ v: 1 });
    await cache.del('k');
    expect(await cache.getOrSet('k', 60, f)).toEqual({ v: 2 });
  });
  test('ডিফল্টে (০) L1 বন্ধ', async () => {
    process.env.REDIS_ENABLED = 'false';
    jest.resetModules();
    const cache = require('../../services/cache');
    let n = 0; const f = async () => ++n;
    await cache.getOrSet('z', 60, f); await cache.getOrSet('z', 60, f);
    expect(n).toBe(2);
  });
});

describe('session touch throttle', () => {
  afterEach(() => { delete process.env.SESSION_TOUCH_THROTTLE_S; jest.resetModules(); });
  test('থ্রটল চালু থাকলে দ্বিতীয় EXPIRE বাদ যায়', async () => {
    process.env.SESSION_TOUCH_THROTTLE_S = '3600';
    jest.resetModules();
    const { adaptIoredis } = require('../../services/sessionStore');
    const c = { expire: jest.fn(async () => 1) };
    const a = adaptIoredis(c);
    await a.expire('s1', 100); await a.expire('s1', 100); await a.expire('s2', 100);
    expect(c.expire).toHaveBeenCalledTimes(2);
  });
  test('ডিফল্টে প্রতিবার EXPIRE', async () => {
    jest.resetModules();
    const { adaptIoredis } = require('../../services/sessionStore');
    const c = { expire: jest.fn(async () => 1) };
    const a = adaptIoredis(c);
    await a.expire('s1', 100); await a.expire('s1', 100);
    expect(c.expire).toHaveBeenCalledTimes(2);
  });
});
