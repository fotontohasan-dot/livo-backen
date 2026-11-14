// PR #271 K1 — must_reset_password migration নিরাপত্তা (আসল Postgres): NOT NULL DEFAULT false, টেবিল-রিরাইট নেই,
// idempotent, পুরনো কোডের সঙ্গে সামঞ্জস্য, rollback পথ।
const { Client } = require('pg');
const { pool } = require('../../db');
const runMigrations = require('../../migrations');

const BASE = process.env.DATABASE_URL;
const urlFor = (db) => { const u = new URL(BASE); u.pathname = '/' + db; return u.toString(); };
const ADD = `ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT false`;
const colInfo = async (db) => (await db.query(
  `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='users' AND column_name='must_reset_password'`)).rows[0];

describe('মূল DB (আসল migrations চালানোর পর)', () => {
  test('কলাম: boolean, NOT NULL, DEFAULT false', async () => {
    expect(await colInfo(pool)).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
  });
  test('পুরনো কোড (কলাম না জেনে INSERT/SELECT) অক্ষত: ডিফল্ট false, পুরনো কোয়েরি চলে', async () => {
    const r = await pool.query(`INSERT INTO users (username, phone, password) VALUES ($1,$2,'x') RETURNING id`, [`oldcode_${Date.now()}`, `019${Math.floor(10000000 + Math.random() * 89999999)}`]);
    const row = (await pool.query('SELECT must_reset_password FROM users WHERE id=$1', [r.rows[0].id])).rows[0];
    expect(row.must_reset_password).toBe(false);
    expect((await pool.query('SELECT id, username, coins FROM users WHERE id=$1', [r.rows[0].id])).rowCount).toBe(1);
    await pool.query('DELETE FROM users WHERE id=$1', [r.rows[0].id]);
  });
  test('migration আবার চালালে একই (idempotent), বিদ্যমান ডেটা বদলায় না', async () => {
    await pool.query('UPDATE users SET must_reset_password = true WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)');
    const before = (await pool.query('SELECT COUNT(*)::int n FROM users WHERE must_reset_password')).rows[0].n;
    await runMigrations();
    expect(await colInfo(pool)).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    expect((await pool.query('SELECT COUNT(*)::int n FROM users WHERE must_reset_password')).rows[0].n).toBe(before);
    await pool.query('UPDATE users SET must_reset_password = false');
  });
});

describe('scratch DB: লক/রিরাইট ও rollback', () => {
  let name; let db;
  beforeAll(async () => {
    name = `mrp_${process.pid}_${Date.now()}`;
    const admin = new Client({ connectionString: BASE }); await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`); await admin.end();
    db = new Client({ connectionString: urlFor(name) }); await db.connect();
    await db.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT, password TEXT)`);
    await db.query(`INSERT INTO users (username, password) SELECT 'u'||g, 'x' FROM generate_series(1, 20000) g`);
  });
  afterAll(async () => {
    await db.end();
    const admin = new Client({ connectionString: BASE }); await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
  });

  test('Postgres ≥ 11 (রিরাইটহীন ADD COLUMN-এর শর্ত)', async () => {
    expect(Number((await db.query('SHOW server_version_num')).rows[0].server_version_num)).toBeGreaterThanOrEqual(110000);
  });

  test('ADD COLUMN NOT NULL DEFAULT false টেবিল রিরাইট করে না (relfilenode অপরিবর্তিত); সব সারি false', async () => {
    const fn = async () => (await db.query(`SELECT relfilenode FROM pg_class WHERE relname='users'`)).rows[0].relfilenode;
    const before = await fn();
    await db.query(ADD);
    expect(await fn()).toBe(before);
    expect((await db.query('SELECT COUNT(*)::int n FROM users WHERE must_reset_password = false')).rows[0].n).toBe(20000);
    expect((await db.query('SELECT COUNT(*)::int n FROM users WHERE must_reset_password IS NULL')).rows[0].n).toBe(0);
  });

  test('লক: ALTER ট্রানজ্যাকশনে ACCESS EXCLUSIVE ধরে (ছোট, শুধু ক্যাটালগ); শেষে ছাড়ে', async () => {
    await db.query('ALTER TABLE users DROP COLUMN must_reset_password');
    await db.query('BEGIN');
    await db.query(ADD);
    const held = (await db.query(`SELECT mode FROM pg_locks WHERE relation = 'users'::regclass AND pid = pg_backend_pid()`)).rows.map((r) => r.mode);
    expect(held).toContain('AccessExclusiveLock');
    await db.query('COMMIT');
    const after = (await db.query(`SELECT mode FROM pg_locks WHERE relation = 'users'::regclass AND pid = pg_backend_pid()`)).rows;
    expect(after).toEqual([]);
  });

  test('IF NOT EXISTS: দ্বিতীয়বার চালালে ব্যর্থ হয় না, ডেটা অক্ষত', async () => {
    await db.query(`UPDATE users SET must_reset_password = true WHERE id <= 5`);
    await db.query(ADD);
    expect((await db.query('SELECT COUNT(*)::int n FROM users WHERE must_reset_password')).rows[0].n).toBe(5);
  });

  test('rollback: DROP COLUMN করলে পুরনো কোয়েরি চলে; নতুন কোড ফেরালে ADD আবার নিরাপদ', async () => {
    await db.query('ALTER TABLE users DROP COLUMN must_reset_password');
    expect((await db.query('SELECT id, username FROM users LIMIT 1')).rowCount).toBe(1);
    await db.query(`INSERT INTO users (username, password) VALUES ('after_rollback','x')`);
    await db.query(ADD);
    expect((await db.query(`SELECT must_reset_password FROM users WHERE username='after_rollback'`)).rows[0].must_reset_password).toBe(false);
  });
});
