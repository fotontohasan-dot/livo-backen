// web role-এ consumer ইচ্ছাকৃতভাবে চলে না — queue health তখন স্থায়ী "worker চালু নেই" error দেখাবে না।
// অন্য role-এ আগের আচরণ অপরিবর্তিত।
const queue = require('../../services/queue');

describe('queue.getHealthStatus × PROCESS_ROLE', () => {
  const saved = process.env.PROCESS_ROLE;
  const savedDis = process.env.DISABLE_BACKGROUND_WORKER;
  beforeEach(() => { delete process.env.DISABLE_BACKGROUND_WORKER; });
  afterEach(() => {
    if (saved === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = saved;
    if (savedDis === undefined) delete process.env.DISABLE_BACKGROUND_WORKER; else process.env.DISABLE_BACKGROUND_WORKER = savedDis;
  });

  test.each(['true', '1'])('render.yaml web (PROCESS_ROLE নেই, DISABLE_BACKGROUND_WORKER=%s): "ওয়ার্কার চালু নেই" error নয়', async (v) => {
    delete process.env.PROCESS_ROLE;
    process.env.DISABLE_BACKGROUND_WORKER = v;
    const h = await queue.getHealthStatus();
    expect(h.running).toBe(false);
    expect(h.issues.join(' ')).not.toMatch(/ওয়ার্কার চালু নেই/);
  });

  test('DISABLE_BACKGROUND_WORKER=false হলে আগের মতোই error', async () => {
    delete process.env.PROCESS_ROLE;
    process.env.DISABLE_BACKGROUND_WORKER = 'false';
    const h = await queue.getHealthStatus();
    expect(h.issues.join(' ')).toMatch(/ওয়ার্কার চালু নেই/);
  });

  test('web: consumer না চললেও "ওয়ার্কার চালু নেই" error নয়', async () => {
    process.env.PROCESS_ROLE = 'web';
    const h = await queue.getHealthStatus();
    expect(h.running).toBe(false);
    expect(h.issues.join(' ')).not.toMatch(/ওয়ার্কার চালু নেই/);
  });

  test.each(['all', 'worker', undefined])('role=%p: consumer না চললে আগের মতোই error', async (role) => {
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
    const h = await queue.getHealthStatus();
    expect(h.level).toBe('error');
    expect(h.issues.join(' ')).toMatch(/ওয়ার্কার চালু নেই/);
  });
});
