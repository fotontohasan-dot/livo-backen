// worker.js (Render `startCommand: node worker.js`) শাটডাউন — মূল implementation (main) অনুযায়ী।
// প্রতিটা stop কল হয়, queue drain হয় (শুধু stopWorker নয়), DB pool সবার শেষে বন্ধ হয়, এবং
// দুবার সিগন্যালে cleanup দুবার চলে না। কোনো DB/Redis লাগে না — সব ফেক।
const calls = [];
const rec = (n) => jest.fn(async () => { calls.push(n); });

jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../db', () => ({ connectDB: jest.fn(), pool: { end: jest.fn(async () => { calls.push('pool.end'); }) } }));
jest.mock('../../migrations', () => jest.fn());
jest.mock('../../services/matchUpdater', () => ({ syncMatches: jest.fn(), stopMatchSync: jest.fn(() => { calls.push('stopMatchSync'); }) }));
jest.mock('../../services/backup', () => ({ scheduleDailyBackup: jest.fn(), stopDailyBackup: jest.fn(() => { calls.push('stopDailyBackup'); }) }));
jest.mock('../../services/backupManager', () => ({ scheduleAutoBackup: jest.fn(), stopAutoBackup: jest.fn(() => { calls.push('stopAutoBackup'); }) }));
jest.mock('../../services/scheduler', () => ({ stop: jest.fn(() => { calls.push('scheduler.stop'); }) }));
jest.mock('../../services/queue', () => ({
  startWorker: jest.fn(),
  stopWorker: jest.fn(() => { calls.push('queue.stopWorker'); }),
  stopWorkerAndDrain: jest.fn(async () => { calls.push('queue.drain'); return { drained: true, pending: 0 }; }),
}));
jest.mock('../../queues', () => ({ shutdownQueueSystem: jest.fn(async () => { calls.push('bullmq.shutdown'); }) }));
jest.mock('../../services/cache', () => ({ getRawClient: () => ({ quit: jest.fn(async () => { calls.push('redis.quit'); }) }) }));

describe('worker.js gracefulShutdown', () => {
  let exitSpy; let worker; let proc;
  beforeAll(() => {
    proc = require('node:process');
    exitSpy = jest.spyOn(proc, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    worker = require('../../worker');
  });
  afterAll(() => { jest.restoreAllMocks(); proc.removeAllListeners('SIGTERM'); proc.removeAllListeners('SIGINT'); });

  test('সব টাইমার বন্ধ, queue drain, তারপর BullMQ/Redis/DB — এই ক্রমে; exit(0)', async () => {
    await worker.gracefulShutdown('SIGTERM');
    expect(calls).toEqual([
      'stopAutoBackup', 'stopDailyBackup', 'stopMatchSync', 'scheduler.stop',
      'queue.drain', 'bullmq.shutdown', 'redis.quit', 'pool.end',
    ]);
    expect(require('../../services/queue').stopWorker).not.toHaveBeenCalled(); // drain নিজেই stopWorker ডাকে
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('দ্বিতীয় সিগন্যালে cleanup আবার চলে না', async () => {
    const before = calls.length;
    await worker.gracefulShutdown('SIGINT');
    expect(calls.length).toBe(before);
  });
});
