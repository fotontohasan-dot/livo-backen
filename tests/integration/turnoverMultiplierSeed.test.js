// turnover_multiplier সিড — খালি scratch PostgreSQL-এ আসল scripts/migrate.js চালিয়ে।
// প্রোডাকশন DB কখনো নয়। ওয়ালেট/সেটেলমেন্ট/বেটিং লজিক ছোঁয়া হয় না।
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

jest.setTimeout(120000);

const BASE_URL = process.env.DATABASE_URL;
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'migrate.js');
const created = [];

function urlFor(dbName) { const u = new URL(BASE_URL); u.pathname = '/' + dbName; return u.toString(); }

async function makeDb(tag) {
  const name = `seed_${tag}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: BASE_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  created.push(name);
  return name;
}

function runMigrate(url) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', DATABASE_URL: url };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env, cwd: path.join(__dirname, '..', '..') });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 90000);
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

describe('turnover_multiplier সিড', () => {
  test('খালি DB-তে migrate চালালে turnover_multiplier = 5 সিড হয়', async () => {
    const db = await makeDb('empty');
    const r = await runMigrate(urlFor(db));
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    const row = (await query(db, `SELECT value FROM site_settings WHERE key = 'turnover_multiplier'`)).rows;
    expect(row).toHaveLength(1);
    expect(row[0].value).toBe('5');
  });

  test('ON CONFLICT DO NOTHING: অ্যাডমিনের বদলানো মান পুনরায় migrate-এ ওভাররাইট হয় না', async () => {
    const db = await makeDb('keep');
    const url = urlFor(db);
    expect((await runMigrate(url)).code).toBe(0);
    await query(db, `UPDATE site_settings SET value = '7' WHERE key = 'turnover_multiplier'`);
    expect((await runMigrate(url)).code).toBe(0);
    const row = (await query(db, `SELECT value FROM site_settings WHERE key = 'turnover_multiplier'`)).rows[0];
    expect(row.value).toBe('7');
  });
});
