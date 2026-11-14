// scripts/cleanupBankCardHolderName.js — আসল Postgres + আসল Redis। প্রতিটা টেস্ট নিজস্ব scratch DB-তে (শেয়ার্ড DB স্পর্শ করে না)।
const { Client, Pool } = require('pg');
const Redis = require('ioredis');
const { run, BACKUP_TABLE } = require('../../scripts/cleanupBankCardHolderName');

const BASE = process.env.DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379';
const urlFor = (db) => { const u = new URL(BASE); u.pathname = '/' + db; return u.toString(); };
const SECRETS = ['Sup3rSecretPass!', 'hunter2hunter2', 'নামটি গোপন'];
const created = []; const pools = [];
const redisKeys = [];

async function makeScratch(tag) {
  const name = `chn_${tag}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: BASE }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  created.push(name);
  const pool = new Pool({ connectionString: urlFor(name) }); pools.push(pool);
  await pool.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT, must_reset_password BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE bank_cards (id SERIAL PRIMARY KEY, user_id INTEGER, bank_name TEXT, account_number TEXT, holder_name TEXT);
    CREATE TABLE device_sessions (sid TEXT, user_id INTEGER, revoked_at TIMESTAMPTZ);`);
  return { name, pool };
}
async function seed(pool) {
  const u = [];
  for (const n of ['u_aff1', 'u_aff2', 'u_clean', 'u_blank']) u.push((await pool.query('INSERT INTO users (username) VALUES ($1) RETURNING id', [n])).rows[0].id);
  const [a1, a2, c, b] = u;
  await pool.query(`INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES
    ($1,'bKash','01711111111',$5), ($2,'Nagad','01722222222',$6), ($2,'Rocket','01733333333',$7),
    ($3,'bKash','01744444444',NULL), ($4,'bKash','01755555555','   ')`, [a1, a2, c, b, SECRETS[0], SECRETS[1], SECRETS[2]]);
  return { a1, a2, c, b };
}
function deps(pool, { spyRedis = null } = {}) {
  const revoked = [];
  return {
    revoked,
    deps: {
      pool,
      revokeAllOtherSessions: async (uid) => { revoked.push(uid); return 1; },
      invalidateAuthCache: async () => {},
      createRedis: (url) => {
        const r = new Redis(url, { maxRetriesPerRequest: 1 });
        if (!spyRedis) return r;
        return new Proxy(r, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { spyRedis.push(String(k)); return t[k](...a); } : t[k]) });
      },
    },
  };
}
const exec = async (args, pool, extra = {}, env = {}) => {
  const out = [];
  const d = deps(pool, extra);
  const code = await run({ argv: args, env: { DATABASE_URL: 'x://hidden', ...env }, out: (m) => out.push(m), deps: d.deps });
  return { code, out: out.join('\n'), revoked: d.revoked };
};
const snap = async (pool) => ({
  cards: (await pool.query('SELECT id, holder_name FROM bank_cards ORDER BY id')).rows,
  flags: (await pool.query('SELECT id, must_reset_password FROM users ORDER BY id')).rows,
  hasBackup: !!(await pool.query('SELECT to_regclass($1) AS t', [`public.${BACKUP_TABLE}`])).rows[0].t,
});

let redis;
beforeAll(async () => { redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 }); await redis.ping(); });
afterAll(async () => {
  if (redisKeys.length) await redis.del(...redisKeys);
  await redis.quit();
  for (const p of pools) await p.end().catch(() => {});
  const admin = new Client({ connectionString: BASE }); await admin.connect();
  for (const n of created) await admin.query(`DROP DATABASE IF EXISTS ${n}`);
  await admin.end();
});

describe('dry-run', () => {
  test('কিছু বদলায় না (কার্ড, ফ্ল্যাগ, ব্যাকআপ টেবিল, Redis সবই অক্ষত); শুধু সংখ্যা ছাপে', async () => {
    const { pool } = await makeScratch('dry');
    await seed(pool);
    const before = await snap(pool);
    const r = await exec([], pool);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DRY-RUN.*আক্রান্ত row: 3, আক্রান্ত ইউজার: 2/);
    expect(await snap(pool)).toEqual(before);
    expect(r.revoked).toEqual([]);
  });
});

describe('--apply', () => {
  test('ব্যাকআপ + NULL + ফ্ল্যাগ (শুধু আক্রান্তদের); Redis সেশন শুধু আক্রান্তদের, SCAN দিয়ে (KEYS নয়)', async () => {
    const { pool } = await makeScratch('apply');
    const ids = await seed(pool);
    const tag = `chn_${Date.now()}`;
    const keys = { a1: `livo:sess:${tag}_a1`, a2: `livo:sess:${tag}_a2`, c: `livo:sess:${tag}_c`, junk: `livo:sess:${tag}_junk` };
    redisKeys.push(...Object.values(keys));
    await redis.set(keys.a1, JSON.stringify({ user: { id: ids.a1 } }));
    await redis.set(keys.a2, JSON.stringify({ user: { id: ids.a2 } }));
    await redis.set(keys.c, JSON.stringify({ user: { id: ids.c } }));
    await redis.set(keys.junk, 'not-json');
    const calls = [];
    const r = await exec(['--apply'], pool, { spyRedis: calls }, { REDIS_URL, SESSION_STORE_TYPE: 'redis' });
    expect(r.code).toBe(0);

    // ব্যাকআপ: ৩টি আক্রান্ত row, মূল মানসহ
    const bk = (await pool.query(`SELECT holder_name FROM ${BACKUP_TABLE} ORDER BY id`)).rows.map((x) => x.holder_name);
    expect(bk.sort()).toEqual([...SECRETS].sort());
    // কার্ড: আক্রান্তরা NULL; বাকিরা যেমন ছিল (NULL ও ফাঁকা)
    const cards = (await pool.query('SELECT user_id, holder_name FROM bank_cards ORDER BY id')).rows;
    expect(cards.filter((x) => [ids.a1, ids.a2].includes(x.user_id)).every((x) => x.holder_name === null)).toBe(true);
    expect(cards.find((x) => x.user_id === ids.b).holder_name).toBe('   ');
    // ফ্ল্যাগ
    const flags = Object.fromEntries((await pool.query('SELECT id, must_reset_password AS f FROM users')).rows.map((x) => [x.id, x.f]));
    expect(flags[ids.a1]).toBe(true); expect(flags[ids.a2]).toBe(true);
    expect(flags[ids.c]).toBe(false); expect(flags[ids.b]).toBe(false);
    // সেশন বাতিল: DB-সেশন শুধু আক্রান্ত, Redis শুধু আক্রান্ত
    expect(r.revoked.sort()).toEqual([ids.a1, ids.a2].sort());
    expect(await redis.exists(keys.a1)).toBe(0);
    expect(await redis.exists(keys.a2)).toBe(0);
    expect(await redis.exists(keys.c)).toBe(1);
    expect(await redis.exists(keys.junk)).toBe(1);
    expect(calls).toContain('scan');
    expect(calls).not.toContain('keys');
    // আউটপুটে কোনো মান/ইউজারনাম নেই
    for (const s of [...SECRETS, 'u_aff1', 'u_aff2', 'u_clean']) expect(r.out).not.toContain(s);
  });

  test('আবার চালালে থেমে যায় (exit 1), ব্যাকআপ হারায় না, কিছু বদলায় না', async () => {
    const { pool } = await makeScratch('rerun');
    await seed(pool);
    expect((await exec(['--apply'], pool)).code).toBe(0);
    const backupBefore = (await pool.query(`SELECT bank_card_id, holder_name FROM ${BACKUP_TABLE} ORDER BY id`)).rows;
    const state = await snap(pool);
    const again = await exec(['--apply'], pool);
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/আগে থেকেই আছে/);
    expect((await pool.query(`SELECT bank_card_id, holder_name FROM ${BACKUP_TABLE} ORDER BY id`)).rows).toEqual(backupBefore);
    expect(await snap(pool)).toEqual(state);
    expect(backupBefore).toHaveLength(3);
  });

  test('ব্যাকআপ টেবিল আগে থেকে থাকলে থামে: ওভাররাইট/ড্রপ নেই, কার্ড/ফ্ল্যাগ অক্ষত, Redis সেশন বাতিল হয় না', async () => {
    const { pool } = await makeScratch('exists');
    const ids = await seed(pool);
    await pool.query(`CREATE TABLE ${BACKUP_TABLE} (id SERIAL PRIMARY KEY, bank_card_id INTEGER NOT NULL, user_id INTEGER, holder_name TEXT, backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`INSERT INTO ${BACKUP_TABLE} (bank_card_id, user_id, holder_name) VALUES (999, 1, 'পুরনো-ব্যাকআপ')`);
    const key = `livo:sess:chn_exists_${Date.now()}`; redisKeys.push(key);
    await redis.set(key, JSON.stringify({ user: { id: ids.a1 } }));
    const cardsBefore = (await snap(pool));
    const r = await exec(['--apply'], pool, {}, { REDIS_URL, SESSION_STORE_TYPE: 'redis' });
    expect(r.code).toBe(1);
    expect(await snap(pool)).toEqual(cardsBefore);
    expect((await pool.query(`SELECT bank_card_id, holder_name FROM ${BACKUP_TABLE}`)).rows).toEqual([{ bank_card_id: 999, holder_name: 'পুরনো-ব্যাকআপ' }]);
    expect(await redis.exists(key)).toBe(1);   // DB ট্রানজ্যাকশন সফল হয়নি → Redis সেশন বাতিল নয়
    expect(r.revoked).toEqual([]);
  });

  test('খালি bank_cards টেবিলে ঠিকমতো শেষ হয় (exit 0), ব্যাকআপ টেবিল বানায় না', async () => {
    const { pool } = await makeScratch('empty');
    const r = await exec(['--apply'], pool);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/আক্রান্ত row: 0/);
    expect((await snap(pool)).hasBackup).toBe(false);
  });
});
