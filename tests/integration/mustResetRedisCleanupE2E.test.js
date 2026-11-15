// বাধ্যতামূলক পাসওয়ার্ড-রিসেট (must_reset_password) × Redis সেশন স্টোর — HTTP স্তরে, আসল Redis + আসল Postgres।
//   (ক) ফ্ল্যাগধারীর লগইনের পর পাসওয়ার্ড-বদল পাতায় রিডাইরেক্ট
//   (খ) লগইনের সেশন Redis-এ `livo:sess:<sid>` কী-তে, JSON-এ user.id সহ
//   (গ) পাসওয়ার্ড বদলালে ফ্ল্যাগ মোছে, অন্য সেশন বাতিল, বর্তমান সেশন চালু
//   (ঘ) cleanupBankCardHolderName --apply-এর SCAN শুধু আক্রান্তের সেশন মোছে, অন্যের অক্ষত
// ওয়ালেট/সেটেলমেন্ট কোড ছোঁয়া হয় না। (ঘ)-তে স্ক্রিপ্ট আলাদা scratch DB-তে চলে — শেয়ার্ড DB-র bank_cards/ব্যাকআপ
// টেবিল অক্ষত থাকে; Redis সেশনগুলো আসল HTTP লগইনের, user id scratch DB-র ইউজারের সাথে মিলিয়ে রাখা।
// app.js লোডের আগেই স্টোর নির্বাচনের env সেট করতে হয়।
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
process.env.REDIS_ENABLED = 'true';
process.env.REDIS_URL = REDIS_URL;
process.env.SESSION_STORE_TYPE = 'redis';

const Redis = require('ioredis');
const { Client, Pool } = require('pg');
const { app, getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const cache = require('../../services/cache');
const { run } = require('../../scripts/cleanupBankCardHolderName');

const SESS_PREFIX = 'livo:sess:'; // app.js-এর প্রোডাকশন prefix
const PW = 'SecurePass123';
const RESET_PAGE = '/profile/security/login-password';

async function registerUser(tag) {
  const email = `${uniqueUsername(tag)}@example.test`;
  const { agent, token } = await getCsrfAgent('/register');
  const res = await agent.post('/register').type('form').send({
    username: uniqueUsername(tag), email, phone: uniquePhone(), password: PW, confirmPassword: PW, _csrf: token
  });
  expect(res.status).toBe(302);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { id, email };
}

async function login(email, password = PW) {
  const { agent, token } = await getCsrfAgent('/login');
  const res = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ identifier: email, password, _csrf: token });
  expect(res.status).toBe(302);
  return { agent, location: res.headers.location };
}

async function setFlag(id, v) {
  await pool.query('UPDATE users SET must_reset_password = $2 WHERE id = $1', [id, v]);
  await cache.del(`auth:active:${id}`).catch(() => {});
}

// Redis-এ এই ইউজারের সব সেশন কী (SCAN + JSON user.id) — স্টোরের আসল ফরম্যাট থেকে
async function redisKeysOf(redis, userId) {
  const found = []; let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${SESS_PREFIX}*`, 'COUNT', 500);
    cursor = next;
    for (const k of keys) {
      const raw = await redis.get(k);
      try { if (JSON.parse(raw)?.user?.id === userId) found.push(k); } catch (_) { /* অন্য ফরম্যাট */ }
    }
  } while (cursor !== '0');
  return found;
}

describe('must_reset_password × Redis সেশন স্টোর (আসল Redis + Postgres)', () => {
  let redis;
  beforeAll(async () => { redis = new Redis(REDIS_URL); await redis.ping(); });
  afterAll(async () => { await redis.quit().catch(() => {}); });

  test('(ক)(খ)(গ) ফ্ল্যাগধারীর লগইন → রিডাইরেক্ট; Redis কী-ফরম্যাট; পাসওয়ার্ড বদলে ফ্ল্যাগ মোছে, অন্য সেশন বাতিল, বর্তমান চালু', async () => {
    const { id, email } = await registerUser('mr');
    await setFlag(id, true);

    const dev1 = await login(email);
    const dev2 = await login(email);

    // (ক)
    expect(dev1.location).toBe(RESET_PAGE);
    expect(dev2.location).toBe(RESET_PAGE);
    // ফ্ল্যাগ থাকা অবস্থায় বাকি পাতা আটকানো (isAuth)
    const blocked = await dev1.agent.get('/profile');
    expect(blocked.status).toBe(302);
    expect(blocked.headers.location).toBe(RESET_PAGE);

    // (খ) device_sessions-এর sid ধরে সরাসরি কী পড়া
    const sids = (await pool.query(
      'SELECT sid FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id', [id]
    )).rows.map((r) => r.sid);
    expect(sids.length).toBeGreaterThanOrEqual(2);
    for (const sid of sids) {
      const raw = await redis.get(`${SESS_PREFIX}${sid}`);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw).user.id).toBe(id);
    }
    expect((await redisKeysOf(redis, id)).length).toBeGreaterThanOrEqual(2);

    // (গ) dev1-এ পাসওয়ার্ড বদল (অনুমোদিত পথ)
    const page = await dev1.agent.get(RESET_PAGE);
    expect(page.status).toBe(200);
    const csrf = extractCsrfToken(page.text);
    const NEW_PW = 'BrandNewPass456';
    const ch = await dev1.agent.post('/profile/change-password').type('form')
      .send({ current_password: PW, new_password: NEW_PW, confirmPassword: NEW_PW, _csrf: csrf });
    expect(ch.status).toBe(302);

    const flag = (await pool.query('SELECT must_reset_password FROM users WHERE id = $1', [id])).rows[0].must_reset_password;
    expect(flag).toBe(false);

    // অন্য সেশন (dev2) Redis থেকে মুছেছে ও কুকি অচল; বর্তমান (dev1) চালু
    const left = await redisKeysOf(redis, id);
    expect(left.length).toBe(1);
    const r2 = await dev2.agent.get('/profile');
    expect(r2.status).toBe(302);
    expect(r2.headers.location).toMatch(/\/login/);
    const r1 = await dev1.agent.get('/profile');
    expect(r1.status).toBe(200);
  });

  describe('(ঘ) cleanupBankCardHolderName --apply — Redis SCAN', () => {
    const BASE = process.env.DATABASE_URL;
    const urlFor = (db) => { const u = new URL(BASE); u.pathname = '/' + db; return u.toString(); };
    let scratchName, scratch;
    const extraKeys = [];

    afterAll(async () => {
      if (extraKeys.length) await redis.del(...extraKeys).catch(() => {});
      if (scratch) await scratch.end().catch(() => {});
      if (scratchName) {
        const admin = new Client({ connectionString: BASE }); await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${scratchName}`); await admin.end();
      }
    });

    test('শুধু আক্রান্তের Redis সেশন মোছে; অন্য ইউজার ও অন্য কী অক্ষত', async () => {
      const A = await registerUser('ca');   // আক্রান্ত
      const B = await registerUser('cb');   // আক্রান্ত নয়
      const a1 = await login(A.email); const a2 = await login(A.email);
      const b1 = await login(B.email);
      expect((await a1.agent.get('/profile')).status).toBe(200);
      expect((await b1.agent.get('/profile')).status).toBe(200);
      const aKeys = await redisKeysOf(redis, A.id);
      const bKeys = await redisKeysOf(redis, B.id);
      expect(aKeys.length).toBeGreaterThanOrEqual(2);
      expect(bKeys.length).toBeGreaterThanOrEqual(1);

      // স্ক্রিপ্টের ক্রিয়াকলাপ scratch DB-তে — ইউজার id আসল ইউজারের সাথে মেলানো
      scratchName = `mre_${process.pid}_${Date.now()}`;
      const admin = new Client({ connectionString: BASE }); await admin.connect();
      await admin.query(`CREATE DATABASE ${scratchName}`); await admin.end();
      scratch = new Pool({ connectionString: urlFor(scratchName) });
      await scratch.query(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, must_reset_password BOOLEAN NOT NULL DEFAULT false);
        CREATE TABLE bank_cards (id SERIAL PRIMARY KEY, user_id INTEGER, bank_name TEXT, account_number TEXT, holder_name TEXT);
        CREATE TABLE device_sessions (sid TEXT, user_id INTEGER, revoked_at TIMESTAMPTZ);`);
      await scratch.query('INSERT INTO users (id, username) VALUES ($1,$2),($3,$4)', [A.id, 'a', B.id, 'b']);
      await scratch.query(
        `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1,'bKash','01711111111',$3), ($2,'bKash','01722222222',$4)`,
        [A.id, B.id, 'Sup3rSecretPass!', 'Rahim Uddin']); // A: পাসওয়ার্ড-সদৃশ নাম; B: বৈধ নাম

      // অন্য prefix-এর কী ও অ-সেশন কী — ছোঁয়া চলবে না
      const foreign = `other:sess:${A.id}`; const plain = `mre:plain:${Date.now()}`;
      await redis.set(foreign, JSON.stringify({ user: { id: A.id } })); await redis.set(plain, '1');
      extraKeys.push(foreign, plain);

      const out = [];
      const code = await run({
        argv: ['--apply'],
        env: { DATABASE_URL: 'x://hidden', REDIS_URL, REDIS_ENABLED: 'true', SESSION_STORE_TYPE: 'redis' },
        out: (m) => out.push(m),
        deps: {
          pool: scratch,
          revokeAllOtherSessions: async () => 0, // Redis মোছা এখানে হয় না — শুধু স্ক্রিপ্টের SCAN-পথ যাচাই হচ্ছে
          invalidateAuthCache: async () => {},
          createRedis: (url) => new Redis(url, { maxRetriesPerRequest: 1 }),
        },
      });
      expect(code).toBe(0);
      expect(out.join('\n')).toContain(`Redis ${aKeys.length}টি`); // রেজিস্ট্রেশন + ২ লগইন সেশন, শুধু A-র

      for (const k of aKeys) expect(await redis.exists(k)).toBe(0);   // আক্রান্ত: সব গেছে
      for (const k of bKeys) expect(await redis.exists(k)).toBe(1);   // অন্য ইউজার: অক্ষত
      expect(await redis.exists(foreign)).toBe(1);
      expect(await redis.exists(plain)).toBe(1);
      expect((await b1.agent.get('/profile')).status).toBe(200);
      const ra = await a1.agent.get('/profile');
      expect(ra.status).toBe(302);
      expect(ra.headers.location).toMatch(/\/login/);
      expect((await a2.agent.get('/profile')).status).toBe(302);
    });
  });
});
