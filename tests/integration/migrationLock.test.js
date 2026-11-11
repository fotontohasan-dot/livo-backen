// Task 2.4 — runMigrations() মিউচুয়াল-এক্সক্লুশন। প্রতিটা গ্রুপ নিজস্ব scratch ডাটাবেসে চলে
// (শেয়ার্ড bet420_test স্পর্শ করে না)। প্রোডাকশন DB কখনো ব্যবহৃত হয় না।
const { Client } = require('pg');

const BASE_URL = process.env.DATABASE_URL;
const KEY = require('../../migrations').MIGRATION_LOCK_KEY;
const created = [];

function urlFor(dbName) {
  const u = new URL(BASE_URL);
  u.pathname = '/' + dbName;
  return u.toString();
}

async function makeDb(tag) {
  const name = `mlock_${tag}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  created.push(name);
  return name;
}

// আলাদা মডিউল রেজিস্ট্রিতে migrations + db লোড করা, যাতে pool scratch DB-তে যায়।
function loadRunner(dbName) {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = urlFor(dbName);
  let mod;
  jest.isolateModules(() => {
    mod = { run: require('../../migrations'), pool: require('../../db').pool };
  });
  process.env.DATABASE_URL = prev;
  return mod;
}

async function rawClient(dbName) {
  const c = new Client({ connectionString: urlFor(dbName) });
  await c.connect();
  return c;
}

const grantedHolders = (c) => c.query(
  `SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`, [KEY]);

const poolFullyReleased = (pool) => pool.totalCount === pool.idleCount && pool.waitingCount === 0;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  jest.restoreAllMocks();
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect();
  for (const n of created) {
    try { await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`); } catch (e) { /* best effort */ }
  }
  await admin.end();
});

describe('runMigrations() advisory lock', () => {
  jest.setTimeout(120000);

  test('৩টি একসাথে (web x2 + worker) খালি DB-তে — সবাই সফল, লক একসাথে একজনের কাছে', async () => {
    const db = await makeDb('conc');
    const runners = [loadRunner(db), loadRunner(db), loadRunner(db)];
    const probe = await rawClient(db);

    let maxHolders = 0;
    let sawHolder = false;
    const sampler = setInterval(async () => {
      try {
        const n = (await grantedHolders(probe)).rows[0].n;
        if (n > 0) sawHolder = true;
        if (n > maxHolders) maxHolders = n;
      } catch (e) { /* probe বন্ধ হয়ে গেলে উপেক্ষা */ }
    }, 15);

    const results = await Promise.allSettled(runners.map((r) => r.run()));
    clearInterval(sampler);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(sawHolder).toBe(true);
    expect(maxHolders).toBe(1);
    expect((await grantedHolders(probe)).rows[0].n).toBe(0); // শেষে কেউ লক ধরে নেই
    expect((await probe.query(`SELECT to_regclass('public.users') AS t`)).rows[0].t).toBe('users');

    for (const r of runners) {
      expect(poolFullyReleased(r.pool)).toBe(true);
      await r.pool.end();
    }
    await probe.end();
  });

  test('অন্য কেউ লক ধরে থাকলে migration অপেক্ষা করে, ছাড়লে এগোয়', async () => {
    const db = await makeDb('wait');
    const holder = await rawClient(db);
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [KEY]);

    const r = loadRunner(db);
    let settled = false;
    const p = r.run().then(() => { settled = true; });
    await new Promise((res) => setTimeout(res, 1200));
    expect(settled).toBe(false);
    expect((await holder.query(`SELECT to_regclass('public.users') AS t`)).rows[0].t).toBeNull(); // কোনো DDL চলেনি

    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [KEY]);
    await p;
    expect(settled).toBe(true);
    expect((await holder.query(`SELECT to_regclass('public.users') AS t`)).rows[0].t).toBe('users');
    expect(poolFullyReleased(r.pool)).toBe(true);
    await r.pool.end();
    await holder.end();
  });

  test('লক টাইমআউট — reject করে, কানেকশন ফেরত দেয়, অন্যের লক ছোঁয় না', async () => {
    const db = await makeDb('timeout');
    const holder = await rawClient(db);
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [KEY]);

    const prev = process.env.MIGRATION_LOCK_TIMEOUT_MS;
    process.env.MIGRATION_LOCK_TIMEOUT_MS = '700';
    const r = loadRunner(db);
    try {
      await expect(r.run()).rejects.toThrow(/migration lock/);
    } finally {
      if (prev === undefined) delete process.env.MIGRATION_LOCK_TIMEOUT_MS; else process.env.MIGRATION_LOCK_TIMEOUT_MS = prev;
    }
    expect(poolFullyReleased(r.pool)).toBe(true);
    expect((await grantedHolders(holder)).rows[0].n).toBe(1); // holder-এর লক অক্ষত
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [KEY]);
    await r.pool.end();
    await holder.end();
  });

  test('migration মাঝপথে ব্যর্থ হলে লক ছাড়ে ও কানেকশন ফেরত দেয়', async () => {
    const db = await makeDb('fail');
    const setup = await rawClient(db);
    // `users` একটা VIEW — CREATE TABLE IF NOT EXISTS এড়িয়ে যায়, পরের ALTER TABLE ব্যর্থ হয়
    await setup.query('CREATE VIEW users AS SELECT 1 AS id');

    const r = loadRunner(db);
    await expect(r.run()).rejects.toThrow();

    expect(poolFullyReleased(r.pool)).toBe(true);
    expect((await grantedHolders(setup)).rows[0].n).toBe(0);
    const got = await setup.query('SELECT pg_try_advisory_lock($1::bigint) AS l', [KEY]);
    expect(got.rows[0].l).toBe(true); // অন্য সেশন এখন লক নিতে পারে
    await setup.query('SELECT pg_advisory_unlock($1::bigint)', [KEY]);

    // ব্যর্থতার পর সুস্থ অবস্থায় আবার চালানো যায়
    await setup.query('DROP VIEW users');
    await expect(r.run()).resolves.toBeUndefined();
    expect(poolFullyReleased(r.pool)).toBe(true);
    await r.pool.end();
    await setup.end();
  });
});
