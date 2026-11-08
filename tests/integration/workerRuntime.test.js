// workerRuntime / queue / queues — shutdown ও lifecycle ইউনিট-ইন্টিগ্রেশন টেস্ট (বাস্তব test DB)।
const workerRuntime = require('../../services/workerRuntime');
const queue = require('../../services/queue');
const matchUpdater = require('../../services/matchUpdater');
const backup = require('../../services/backup');
const backupManager = require('../../services/backupManager');
const { pool } = require('../../db');

afterAll(async () => { await pool.end().catch(() => {}); });
beforeEach(() => workerRuntime._resetForTests());

describe('stopBackgroundWork', () => {
  test('একাধিকবার ডাকলেও প্রতিটা stop একবারই চলে (duplicate cleanup নেই)', async () => {
    const spies = [
      jest.spyOn(matchUpdater, 'stopSync'),
      jest.spyOn(backup, 'stopDailyBackup'),
      jest.spyOn(backupManager, 'stopAutoBackup'),
      jest.spyOn(queue, 'drainWorker')
    ];
    try {
      const a = workerRuntime.stopBackgroundWork({ drainTimeoutMs: 500 });
      const b = workerRuntime.stopBackgroundWork({ drainTimeoutMs: 500 });
      expect(a).toBe(b);
      await a;
      await workerRuntime.stopBackgroundWork();
      spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  test('ট্র্যাক করা টাইমার ও keep-alive পরিষ্কার হয়', async () => {
    let fired = false;
    workerRuntime.trackTimer(setTimeout(() => { fired = true; }, 30));
    workerRuntime.startKeepAlive();
    expect(workerRuntime.getStatus().keepAliveActive).toBe(true);
    expect(workerRuntime.getStatus().trackedTimers).toBe(1);
    await workerRuntime.stopBackgroundWork({ drainTimeoutMs: 200 });
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(false);
    expect(workerRuntime.getStatus()).toMatchObject({ keepAliveActive: false, trackedTimers: 0, stopped: true });
  });
});

describe('queue.drainWorker', () => {
  test('কোনো চলমান tick না থাকলে সাথে সাথে drained', async () => {
    expect(await queue.drainWorker(200)).toEqual({ drained: true });
  });

  test('worker শুরু ও drain: polling থামে এবং state.running=false', async () => {
    queue.startWorker();
    const r = await queue.drainWorker(3000);
    expect(r.drained).toBe(true);
    // দ্বিতীয়বার drain নিরাপদ
    expect((await queue.drainWorker(200)).drained).toBe(true);
  });
});

describe('matchUpdater / backup stop', () => {
  test('stopSync এবং backup stop ফাংশনগুলো না চালু থাকলেও নিরাপদ ও idempotent', () => {
    expect(() => { matchUpdater.stopSync(); matchUpdater.stopSync(); }).not.toThrow();
    expect(() => { backup.stopDailyBackup(); backup.stopDailyBackup(); }).not.toThrow();
    expect(() => { backupManager.stopAutoBackup(); backupManager.stopAutoBackup(); }).not.toThrow();
  });

  test('scheduleAutoBackup → stopAutoBackup → আবার schedule করা যায় (হ্যান্ডল সত্যিই clear হয়)', () => {
    process.env.BACKUP_SCHEDULE_HOURS = '24';
    const spy = jest.spyOn(global, 'setInterval');
    try {
      backupManager.scheduleAutoBackup();
      backupManager.scheduleAutoBackup(); // গার্ড — দ্বিতীয় interval নয়
      expect(spy).toHaveBeenCalledTimes(1);
      backupManager.stopAutoBackup();
      backupManager.scheduleAutoBackup(); // stop-এর পর আবার বসে
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      backupManager.stopAutoBackup();
      spy.mockRestore();
      delete process.env.BACKUP_SCHEDULE_HOURS;
    }
  });
});

describe('waitForSchema', () => {
  test('সব টেবিল থাকলে true (বাস্তব test DB)', async () => {
    await expect(workerRuntime.waitForSchema({ attempts: 1, delayMs: 1 })).resolves.toBe(true);
  });

  test('টেবিল অনুপস্থিত থাকলে সীমিত চেষ্টার পর স্পষ্ট এরর — fake success নয়', async () => {
    const original = workerRuntime.REQUIRED_TABLES.slice();
    workerRuntime.REQUIRED_TABLES.push('definitely_missing_table_xyz');
    let sleeps = 0;
    try {
      await expect(workerRuntime.waitForSchema({ attempts: 2, delayMs: 1, sleep: async () => { sleeps++; } }))
        .rejects.toThrow(/definitely_missing_table_xyz/);
      expect(sleeps).toBe(1);
    } finally {
      workerRuntime.REQUIRED_TABLES.length = 0;
      original.forEach((t) => workerRuntime.REQUIRED_TABLES.push(t));
    }
  });
});

describe('queues (BullMQ) — producer বনাম consumer', () => {
  test('initQueueProducers কোনো Worker/QueueEvents চালু করে না', async () => {
    jest.resetModules();
    const startWorkers = jest.fn();
    const startDeadLetterListeners = jest.fn();
    jest.doMock('../../queues/workers', () => ({ startWorkers, stopWorkers: jest.fn(async () => {}) }));
    jest.doMock('../../queues/deadLetter', () => ({
      startDeadLetterListeners, stopDeadLetterListeners: jest.fn(async () => {}), retryDeadLetter: jest.fn()
    }));
    const queues = require('../../queues');
    const res = await queues.initQueueProducers(); // REDIS_URL নেই → false, কিছুই চালু হয় না
    expect(res).toBe(false);
    expect(startWorkers).not.toHaveBeenCalled();
    expect(startDeadLetterListeners).not.toHaveBeenCalled();
    jest.dontMock('../../queues/workers');
    jest.dontMock('../../queues/deadLetter');
  });

  test('shutdownQueueSystem idempotent — একই promise, stopWorkers একবার', async () => {
    jest.resetModules();
    const stopWorkers = jest.fn(async () => {});
    const stopDeadLetterListeners = jest.fn(async () => {});
    jest.doMock('../../queues/workers', () => ({ startWorkers: jest.fn(), stopWorkers }));
    jest.doMock('../../queues/deadLetter', () => ({ startDeadLetterListeners: jest.fn(), stopDeadLetterListeners }));
    const queues = require('../../queues');
    const p1 = queues.shutdownQueueSystem();
    const p2 = queues.shutdownQueueSystem();
    expect(p1).toBe(p2);
    await p1;
    expect(stopWorkers).toHaveBeenCalledTimes(1);
    expect(stopDeadLetterListeners).toHaveBeenCalledTimes(1);
    jest.dontMock('../../queues/workers');
    jest.dontMock('../../queues/deadLetter');
  });
});
