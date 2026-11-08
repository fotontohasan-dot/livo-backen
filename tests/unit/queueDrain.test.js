// Test E (unit) — queue shutdown: নতুন poll বন্ধ + চলমান batch শেষ হওয়ার অপেক্ষা (FOR UPDATE SKIP LOCKED অক্ষত)।
describe('queue.stopWorkerAndDrain', () => {
  let queue; let pool; let queries;

  beforeEach(() => {
    jest.resetModules();
    queries = [];
    const client = {
      query: jest.fn(async (sql) => {
        queries.push(String(sql));
        if (/FOR UPDATE SKIP LOCKED/.test(sql)) {
          return { rows: [{ id: 1, type: 'slow', payload: '{}', attempts: 0, max_attempts: 3, started_at: null }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    pool = { connect: jest.fn(async () => client), query: jest.fn(async () => ({ rows: [] })) };
    jest.doMock('../../db', () => ({ pool }));
    queue = require('../../services/queue');
  });
  afterEach(() => { jest.dontMock('../../db'); });

  test('চলমান batch-এর জব শেষ হওয়া পর্যন্ত অপেক্ষা করে; SKIP LOCKED ক্লেইম অক্ষত', async () => {
    let finished = false;
    queue.registerHandler('slow', async () => { await new Promise((r) => setTimeout(r, 300)); finished = true; });
    const batch = queue.processOneBatch();
    // tick() যেভাবে ট্র্যাক করে সেটাই যাচাই করতে সরাসরি startWorker পথ:
    queue.startWorker();
    await new Promise((r) => setTimeout(r, 2200)); // প্রথম poll (২s) ধরার জন্য
    const res = await queue.stopWorkerAndDrain(5000);
    await batch;
    expect(finished).toBe(true);
    expect(res.drained).toBe(true);
    expect(queue.getStatus().running).toBe(false);
    expect(queries.some((q) => /FOR UPDATE SKIP LOCKED/.test(q))).toBe(true);
  }, 15000);

  test('timeout পেরোলে drained=false রিটার্ন করে (hang করে না)', async () => {
    queue.registerHandler('slow', () => new Promise(() => {})); // কখনো শেষ হয় না
    queue.startWorker();
    await new Promise((r) => setTimeout(r, 2200));
    const t0 = Date.now();
    const res = await queue.stopWorkerAndDrain(400);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.drained).toBe(false);
    expect(res.pending).toBeGreaterThan(0);
  }, 15000);

  test('কিছু চলমান না থাকলে সাথে সাথে drained', async () => {
    expect(await queue.stopWorkerAndDrain(100)).toEqual({ drained: true, pending: 0 });
  });

  test('দুবার stop করা নিরাপদ', async () => {
    queue.startWorker();
    await queue.stopWorkerAndDrain(100);
    await expect(queue.stopWorkerAndDrain(100)).resolves.toBeDefined();
  });
});
