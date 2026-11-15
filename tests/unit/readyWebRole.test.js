// render.yaml-এর web প্রসেস: DISABLE_BACKGROUND_WORKER=true, PROCESS_ROLE নেই, ওয়ার্কার চলে না।
// /ready কিউ-হেলথ বা PROCESS_ROLE দেখে না — তাই এখানে ভুল 503 হওয়ার কথা নয়। আসল Postgres + Redis।
// app.js/queues/connection লোডের আগেই env সেট করতে হয় (jest প্রতি ফাইলে আলাদা process.env দেয়)।
delete process.env.PROCESS_ROLE;
process.env.DISABLE_BACKGROUND_WORKER = 'true';
process.env.REDIS_ENABLED = 'true';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';

const { freshRequest } = require('../helpers/app'); // শেয়ার্ড listening সার্ভার (হারনেস নিয়ম)
const { closeQueueRedis } = require('../../queues/connection');
const queue = require('../../services/queue');

describe('/ready × web প্রসেস (DISABLE_BACKGROUND_WORKER=true, PROCESS_ROLE নেই)', () => {
  beforeAll(() => { require('../../services/startupState').markMigrationsCompleted(); });
  afterAll(async () => { try { await closeQueueRedis(); } catch (_) { /* best-effort */ } });

  test('worker না চললেও /ready 200 (কিউ-হেলথ-এ consumer বন্ধ থাকলেও)', async () => {
    expect((await queue.getHealthStatus()).running).toBe(false); // consumer সত্যিই বন্ধ
    const res = await freshRequest().get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });
});
