// Task 2.1 — একাধিক worker/instance-এ scheduled backup ডুপ্লিকেট প্রতিরোধ।
// আসল PostgreSQL দরকার (pg_try_advisory_xact_lock + backup_history)। runner ইনজেক্ট করা,
// তাই আসল pg dump/ফাইল তৈরি হয় না এবং কোনো আর্থিক টেবিলে হাত পড়ে না।
const { runScheduledBackupsOnce } = require('../../services/backupManager');
const { pool } = require('../../db');

jest.setTimeout(60000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = `guardtest_${Date.now()}.json`;

async function insertScheduledDb(status = 'completed') {
  await pool.query(
    `INSERT INTO backup_history (type, filename, status, source) VALUES ('database', $1, $2, 'scheduled')`,
    [TAG, status]
  );
}

beforeEach(async () => {
  await pool.query('DELETE FROM backup_history WHERE filename = $1', [TAG]);
  // অন্য টেস্টের scheduled রো যেন "সাম্প্রতিক" ধরা না পড়ে
  await pool.query(`UPDATE backup_history SET created_at = NOW() - INTERVAL '30 days' WHERE source = 'scheduled'`);
});
afterAll(async () => {
  await pool.query('DELETE FROM backup_history WHERE filename = $1', [TAG]);
});

describe('runScheduledBackupsOnce', () => {
  test('একসাথে ৩টা instance চললেও runner মাত্র একবার চলে', async () => {
    let calls = 0;
    const runner = async () => { calls++; await sleep(400); await insertScheduledDb(); return { ok: true }; };
    const results = await Promise.all([1, 2, 3].map(() => runScheduledBackupsOnce({ runner, minGapMs: 60000 })));
    expect(calls).toBe(1);
    expect(results.filter((r) => r && r.skipped).length).toBe(2);
    expect(results.filter((r) => r && r.ok).length).toBe(1);
  });

  test('প্রথমটা শেষ হওয়ার পরে দেরিতে আসা টাইমার সাম্প্রতিক backup দেখে skip করে', async () => {
    await insertScheduledDb();
    const runner = jest.fn().mockResolvedValue({ ok: true });
    const r = await runScheduledBackupsOnce({ runner, minGapMs: 60000 });
    expect(r).toEqual({ skipped: true, reason: 'recent' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('ব্যর্থ (failed) backup "সাম্প্রতিক সম্পন্ন" গণ্য হয় না — পুনরায় চেষ্টা চলে', async () => {
    await insertScheduledDb('failed');
    const runner = jest.fn().mockResolvedValue({ ok: true });
    await runScheduledBackupsOnce({ runner, minGapMs: 60000 });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('পুরোনো (gap-এর বাইরে) backup থাকলে নতুন রান চলে', async () => {
    await insertScheduledDb();
    await pool.query(`UPDATE backup_history SET created_at = NOW() - INTERVAL '2 hours' WHERE filename = $1`, [TAG]);
    const runner = jest.fn().mockResolvedValue({ ok: true });
    await runScheduledBackupsOnce({ runner, minGapMs: 60 * 60 * 1000 });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('runner throw করলে lock ছাড়ে — পরের রান আটকে যায় না, ত্রুটি উপরে পৌঁছায়', async () => {
    await expect(runScheduledBackupsOnce({ runner: async () => { throw new Error('boom'); }, minGapMs: 60000 }))
      .rejects.toThrow('boom');
    const runner = jest.fn().mockResolvedValue({ ok: true });
    await runScheduledBackupsOnce({ runner, minGapMs: 60000 });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test('pool connection leak নেই — রানের পরে সব client ফেরত আসে', async () => {
    await runScheduledBackupsOnce({ runner: async () => ({ ok: true }), minGapMs: 60000 });
    await runScheduledBackupsOnce({ runner: async () => ({ ok: true }), minGapMs: 60000 });
    expect(pool.waitingCount).toBe(0);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });
});
