// render.yaml-এর web প্রসেস: DISABLE_BACKGROUND_WORKER=true, PROCESS_ROLE নেই, ওয়ার্কার চলে না।
// /ready কিউ-হেলথ বা PROCESS_ROLE দেখে না — তাই এখানে ভুল 503 হওয়ার কথা নয়। আসল Postgres + Redis।
const request = require('supertest');

describe('/ready × web প্রসেস (DISABLE_BACKGROUND_WORKER=true, PROCESS_ROLE নেই)', () => {
  const keys = ['PROCESS_ROLE', 'DISABLE_BACKGROUND_WORKER', 'REDIS_ENABLED', 'REDIS_URL'];
  const saved = {};
  let app, closeRedis;

  beforeAll(() => {
    keys.forEach((k) => { saved[k] = process.env[k]; });
    delete process.env.PROCESS_ROLE;
    process.env.DISABLE_BACKGROUND_WORKER = 'true';
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
    jest.isolateModules(() => {
      require('../../services/startupState').markMigrationsCompleted();
      ({ closeQueueRedis: closeRedis } = require('../../queues/connection'));
      app = require('../../app');
    });
  });

  afterAll(async () => {
    try { await closeRedis(); } catch (_) { /* best-effort */ }
    keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });

  test('worker না চললেও /ready 200 (কিউ-হেলথ error থাকলেও)', async () => {
    const queue = require('../../services/queue');
    expect((await queue.getHealthStatus()).running).toBe(false); // consumer সত্যিই বন্ধ
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });
});
