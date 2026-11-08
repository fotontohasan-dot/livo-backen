// scripts/migrate.js — আসল প্রসেস হিসেবে scratch PostgreSQL-এর বিপরীতে। প্রোডাকশন DB কখনো নয়।
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

jest.setTimeout(120000);

const BASE_URL = process.env.DATABASE_URL;
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'migrate.js');
const KEY = require('../../migrations').MIGRATION_LOCK_KEY;
const created = [];

function urlFor(dbName) { const u = new URL(BASE_URL); u.pathname = '/' + dbName; return u.toString(); }

async function makeDb(tag) {
  const name = `mig_${tag}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  created.push(name);
  return name;
}

function runScript(extraEnv) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...extraEnv };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env, cwd: path.join(__dirname, '..', '..') });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60000); // ঝুলে থাকলে ধরা পড়ে (signal != null)
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out }); });
  });
}

async function query(dbName, sql, params) {
  const c = new Client({ connectionString: urlFor(dbName) });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

afterAll(async () => {
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect();
  for (const n of created) { try { await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`); } catch (e) { /* best effort */ } }
  await admin.end();
});

describe('node scripts/migrate.js (scratch DB)', () => {
  test('সফল: exit 0, সময়মতো বেরোয় (kill লাগেনি), টেবিল তৈরি, লক মুক্ত, কোনো URL/পাসওয়ার্ড লগে নেই', async () => {
    const db = await makeDb('ok');
    const url = urlFor(db);
    const r = await runScript({ DATABASE_URL: url });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect((await query(db, `SELECT to_regclass('public.users') AS t`)).rows[0].t).toBe('users');
    expect((await query(db, `SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted
       AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`, [KEY])).rows[0].n).toBe(0);
    expect(r.out).toContain('DATABASE_URL');
    expect(r.out).not.toContain(url);
    const pw = new URL(url).password;
    if (pw) expect(r.out).not.toContain(pw);
  });

  test('migration ব্যর্থ → non-zero exit, লক মুক্ত', async () => {
    const db = await makeDb('fail');
    await query(db, 'CREATE VIEW users AS SELECT 1 AS id'); // পরের ALTER TABLE ব্যর্থ করে
    const r = await runScript({ DATABASE_URL: urlFor(db) });
    expect(r.signal).toBeNull();
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/migrate: ব্যর্থ/);
    const held = await query(db, `SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted
       AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`, [KEY]);
    expect(held.rows[0].n).toBe(0);
  });

  test('MIGRATION_DATABASE_URL ওভাররাইড: DATABASE_URL অস্তিত্বহীন DB হলেও ওভাররাইডের DB-তে migrate হয়', async () => {
    const real = await makeDb('override');
    const r = await runScript({
      DATABASE_URL: urlFor('mig_does_not_exist_zzz'),
      MIGRATION_DATABASE_URL: urlFor(real),
    });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.out).toContain('MIGRATION_DATABASE_URL');
    expect((await query(real, `SELECT to_regclass('public.users') AS t`)).rows[0].t).toBe('users');
    expect(r.out).not.toContain(urlFor(real));
  });

  test('ওভাররাইড ছাড়া: বিদ্যমান DATABASE_URL-ই ব্যবহৃত হয়; ভুল DATABASE_URL → non-zero', async () => {
    const bad = await runScript({ DATABASE_URL: urlFor('mig_does_not_exist_zzz') });
    expect(bad.signal).toBeNull();
    expect(bad.code).not.toBe(0);
  });

  test('সংযোগ ব্যর্থ (পাসওয়ার্ডসহ URL): non-zero, আউটপুটে পাসওয়ার্ড/URL নেই', async () => {
    const pw = 'Zq9-integration-secret-PW';
    const url = `postgres://leaky_user:${pw}@127.0.0.1:1/nodb`;
    const r = await runScript({ DATABASE_URL: url });
    expect(r.signal).toBeNull();
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain(pw);
    expect(r.out).not.toContain(url);
    expect(r.out).not.toContain('leaky_user');
  });

  test('কোনো URL সেট নেই → exit 1', async () => {
    const r = await runScript({});
    expect(r.signal).toBeNull();
    expect(r.code).toBe(1);
  });
});
