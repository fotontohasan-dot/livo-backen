// server.js `all` role: ৩s boot-timer শাটডাউনে বাতিল হয় — পরে ফায়ার করে consumer চালু করে না।
jest.useFakeTimers();
const mockStartWorker = jest.fn();
const mockInitQueueSystem = jest.fn(() => Promise.resolve());
jest.mock('../../services/queue', () => ({ startWorker: (...a) => mockStartWorker(...a), stopWorker: jest.fn(), stopWorkerAndDrain: jest.fn() }));
jest.mock('../../services/queueHandlers', () => ({}));
jest.mock('../../queues', () => ({ initQueueSystem: (...a) => mockInitQueueSystem(...a), initQueueProducers: jest.fn(() => Promise.resolve()) }));
jest.mock('../../services/matchUpdater', () => ({ syncMatches: jest.fn(() => Promise.resolve()), stopMatchSync: jest.fn() }));
jest.mock('../../services/casinoGameSync', () => ({ syncNewProvidersOnBoot: jest.fn(() => Promise.resolve()) }));
jest.mock('../../services/backup', () => ({ scheduleDailyBackup: jest.fn(), stopDailyBackup: jest.fn() }));
jest.mock('../../services/backupManager', () => ({ scheduleAutoBackup: jest.fn(), stopAutoBackup: jest.fn() }));
jest.mock('../../services/scheduler', () => ({ start: jest.fn(() => Promise.resolve()), stop: jest.fn() }));

describe('startBackgroundWork boot-timer', () => {
  const OLD = process.env.DISABLE_BACKGROUND_WORKER;
  let server;
  beforeAll(() => { delete process.env.DISABLE_BACKGROUND_WORKER; jest.spyOn(console, 'log').mockImplementation(() => {}); server = require('../../server'); });
  afterAll(() => { if (OLD !== undefined) process.env.DISABLE_BACKGROUND_WORKER = OLD; jest.restoreAllMocks(); jest.useRealTimers(); });
  beforeEach(() => { mockStartWorker.mockClear(); mockInitQueueSystem.mockClear(); });

  test('স্বাভাবিক: ৩s পরে queue worker ও BullMQ চালু হয়', () => {
    server.startBackgroundWork();
    jest.advanceTimersByTime(3000);
    expect(mockStartWorker).toHaveBeenCalledTimes(1);
    expect(mockInitQueueSystem).toHaveBeenCalledTimes(1);
  });

  test('stopBackgroundBoot() হলে ৩s পরেও কোনো consumer চালু হয় না', () => {
    server.startBackgroundWork();
    server.stopBackgroundBoot();
    jest.advanceTimersByTime(10000);
    expect(mockStartWorker).not.toHaveBeenCalled();
    expect(mockInitQueueSystem).not.toHaveBeenCalled();
    expect(() => server.stopBackgroundBoot()).not.toThrow(); // idempotent
  });
});
