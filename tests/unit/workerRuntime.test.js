// Test B/E (unit) — worker runtime lifecycle, ফেক সার্ভিস দিয়ে (কোনো DB/Redis লাগে না)।
const { createWorkerRuntime, defaultServices, waitForWorkerSchema } = require('../../services/workerRuntime');

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function fakeService(name, calls, extra = {}) {
  return {
    name,
    start: jest.fn(async () => { calls.push(`start:${name}`); }),
    stop: jest.fn(async () => { calls.push(`stop:${name}`); }),
    ...extra,
  };
}

describe('createWorkerRuntime', () => {
  test('সার্ভিস ক্রমানুসারে চালু হয়, প্রতিটা একবারই — start() দুবার ডাকলেও', async () => {
    const calls = [];
    const a = fakeService('a', calls); const b = fakeService('b', calls);
    const rt = createWorkerRuntime({ services: [a, b], logger: quiet });
    await Promise.all([rt.start(), rt.start()]);
    await rt.start();
    expect(calls).toEqual(['start:a', 'start:b']);
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(rt.getStatus()).toEqual({ a: 'running', b: 'running' });
  });

  test('stop() উল্টো ক্রমে বন্ধ করে এবং idempotent — দ্বিতীয় cleanup হয় না', async () => {
    const calls = [];
    const a = fakeService('a', calls); const b = fakeService('b', calls);
    const rt = createWorkerRuntime({ services: [a, b], logger: quiet });
    await rt.start();
    await Promise.all([rt.stop(), rt.stop()]);
    await rt.stop();
    expect(calls).toEqual(['start:a', 'start:b', 'stop:b', 'stop:a']);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  test('strict: মাঝপথে ব্যর্থ হলে আগের সার্ভিস বন্ধ হয়, পরেরটা চালু হয় না, start() reject করে', async () => {
    const calls = [];
    const a = fakeService('a', calls);
    const bad = fakeService('bad', calls, { start: jest.fn(async () => { throw new Error('boom'); }) });
    const c = fakeService('c', calls);
    const rt = createWorkerRuntime({ services: [a, bad, c], strict: true, logger: quiet });
    await expect(rt.start()).rejects.toThrow('boom');
    // ব্যর্থ সার্ভিসেরও stop() ডাকা হয় (আংশিক resource ছাড়ার জন্য), তারপর আগেরগুলো উল্টো ক্রমে
    expect(calls).toEqual(['start:a', 'stop:bad', 'stop:a']);
    expect(c.start).not.toHaveBeenCalled();
    expect(rt.getStatus().bad).toBe('failed');
  });

  test('non-strict (all role): ব্যর্থতা লগ হয়, বাকিরা চলে', async () => {
    const calls = [];
    const bad = fakeService('bad', calls, { start: jest.fn(async () => { throw new Error('boom'); }) });
    const c = fakeService('c', calls);
    const rt = createWorkerRuntime({ services: [bad, c], strict: false, logger: quiet });
    await expect(rt.start()).resolves.toBeUndefined();
    expect(c.start).toHaveBeenCalled();
  });

  test('stop() এক সার্ভিসের ব্যর্থতায় বাকিদের বন্ধ করা আটকায় না', async () => {
    const calls = [];
    const a = fakeService('a', calls);
    const b = fakeService('b', calls, { stop: jest.fn(async () => { throw new Error('stop fail'); }) });
    const rt = createWorkerRuntime({ services: [a, b], logger: quiet });
    await rt.start();
    await rt.stop();
    expect(a.stop).toHaveBeenCalled();
  });

  test('fireAndForget সার্ভিসের ধীর/ব্যর্থ startup, startup আটকায় না ও unhandled rejection দেয় না', async () => {
    const calls = [];
    let release;
    const slow = fakeService('slow', calls, { fireAndForget: true, start: jest.fn(() => new Promise((r) => { release = r; })) });
    const failing = fakeService('failing', calls, { fireAndForget: true, start: jest.fn(async () => { throw new Error('net'); }) });
    const after = fakeService('after', calls);
    const rt = createWorkerRuntime({ services: [slow, failing, after], strict: true, logger: quiet });
    await rt.start();
    expect(after.start).toHaveBeenCalled();
    release();
    await rt.stop();
    expect(slow.stop).toHaveBeenCalled();
  });

  describe('delay timer ও heartbeat', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('delayMs: সময় হলে চালু হয়', async () => {
      const calls = [];
      const d = fakeService('d', calls, { delayMs: 3000 });
      const rt = createWorkerRuntime({ services: [d], logger: quiet });
      await rt.start();
      expect(d.start).not.toHaveBeenCalled();
      expect(rt.getStatus().d).toBe('pending');
      await jest.advanceTimersByTimeAsync(3000);
      expect(d.start).toHaveBeenCalledTimes(1);
      await rt.stop();
      expect(d.stop).toHaveBeenCalledTimes(1);
    });

    test('delay শেষ হওয়ার আগে stop() করলে সার্ভিস কখনো চালু হয় না, timer পরিষ্কার', async () => {
      const calls = [];
      const d = fakeService('d', calls, { delayMs: 3000 });
      const rt = createWorkerRuntime({ services: [d], logger: quiet });
      await rt.start();
      await rt.stop();
      await jest.advanceTimersByTimeAsync(10000);
      expect(d.start).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    test('heartbeat timer stop()-এ পরিষ্কার হয়', async () => {
      const rt = createWorkerRuntime({ services: [], heartbeatMs: 1000, logger: quiet });
      await rt.start();
      expect(jest.getTimerCount()).toBe(1);
      await rt.stop();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe('defaultServices — কোন task worker-এ যায়', () => {
  test('অনুমোদিত তালিকা ও ক্রম; queue handler consumer-এর আগে', () => {
    const names = defaultServices().map((s) => s.name);
    expect(names).toEqual([
      'pgQueueConsumer', 'bullmqConsumers', 'scheduler', 'matchSync', 'casinoBootSync', 'dailyBackup', 'autoBackup',
    ]);
  });
  test('bootDelayMs শুধু delayed-group-এ (all role-এর পুরোনো ৩ সেকেন্ড)', () => {
    const delayed = defaultServices({ bootDelayMs: 3000 }).filter((s) => s.delayMs).map((s) => s.name);
    expect(delayed).toEqual(['pgQueueConsumer', 'bullmqConsumers', 'matchSync', 'casinoBootSync']);
  });
  test('আর্থিক সার্ভিস (settlement/wallet/bet) তালিকায় নেই', () => {
    const src = JSON.stringify(defaultServices().map((s) => `${s.start}${s.stop || ''}`));
    expect(src).not.toMatch(/settlement|wallet|layBet|coin/i);
  });
});

describe('waitForWorkerSchema', () => {
  test('সব টেবিল থাকলে সাথে সাথে true, কোনো DDL নয় (শুধু SELECT)', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(waitForWorkerSchema(pool, { logger: quiet })).resolves.toBe(true);
    expect(pool.query.mock.calls[0][0]).toMatch(/^SELECT/);
  });
  test('টেবিল পরে এলে retry করে সফল হয়', async () => {
    const pool = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ name: 'cron_jobs' }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const sleep = jest.fn(async () => {});
    await expect(waitForWorkerSchema(pool, { sleep, intervalMs: 1, logger: quiet })).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  test('সময়সীমায় না এলে throw (fail-closed)', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [{ name: 'job_queue' }] })) };
    await expect(waitForWorkerSchema(pool, { timeoutMs: 0, logger: quiet })).rejects.toThrow(/job_queue/);
  });
});
