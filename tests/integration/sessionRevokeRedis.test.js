// Redis সেশন-স্টোর সক্রিয় থাকলে সেশন বাতিল সত্যিই কাজ করে কিনা (আসল Redis + আসল Postgres)।
// এবং Postgres → Redis স্টোরে বদলালে বিদ্যমান সেশনের কী হয় তার চরিত্র-বর্ণনা (characterization)।
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('../../db');
const { createRedisSessionStore, setActiveSessionStore } = require('../../services/sessionStore');
const { revokeAllOtherSessions, revokeDeviceSession } = require('../../services/deviceTracking');

const URL_ = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const PREFIX = `test:revoke:${process.pid}:`;
const call = (fn) => new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v))));
const mkSess = (extra = {}) => ({
  cookie: { originalMaxAge: 60000, expires: new Date(Date.now() + 60000).toISOString(), httpOnly: true },
  user: { id: 1 }, ...extra
});

describe('session revocation with the Redis store active (real Redis)', () => {
  let r, userId;
  const sid = (n) => `rv-${process.pid}-${n}`;

  beforeAll(async () => {
    r = createRedisSessionStore(URL_, { prefix: PREFIX });
    setActiveSessionStore(r.store);
    const u = await pool.query(
      `INSERT INTO users (username, password, phone, role) VALUES ($1, 'x', $2, 'user') RETURNING id`,
      [`rv_${process.pid}_${Date.now()}`, `0199${String(Date.now()).slice(-7)}`]
    );
    userId = u.rows[0].id;
  });
  afterAll(async () => {
    setActiveSessionStore(null);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const keys = await r.client.keys(`${PREFIX}*`);
    if (keys.length) await r.client.del(...keys);
    r.client.disconnect();
  });

  async function seed(names) {
    for (const n of names) {
      await call((cb) => r.store.set(sid(n), mkSess(), cb));
      await pool.query(
        `INSERT INTO device_sessions (user_id, sid, device_name) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET revoked_at = NULL`,
        [userId, sid(n), `dev-${n}`]
      );
    }
  }

  test('revokeAllOtherSessions removes other sessions from Redis, keeps the current one', async () => {
    await seed(['cur', 'a', 'b']);
    const count = await revokeAllOtherSessions(userId, sid('cur'), 'TEST');
    expect(count).toBe(2);
    expect(await r.client.exists(`${PREFIX}${sid('a')}`)).toBe(0);
    expect(await r.client.exists(`${PREFIX}${sid('b')}`)).toBe(0);
    expect(await call((cb) => r.store.get(sid('a'), cb))).toBeNull();
    expect(await r.client.exists(`${PREFIX}${sid('cur')}`)).toBe(1);
    const rows = await pool.query('SELECT sid, revoked_at FROM device_sessions WHERE user_id = $1', [userId]);
    const by = Object.fromEntries(rows.rows.map((x) => [x.sid, !!x.revoked_at]));
    expect(by[sid('a')]).toBe(true);
    expect(by[sid('cur')]).toBe(false);
  });

  test('empty currentSid (password reset / admin) revokes every session in Redis', async () => {
    await seed(['x', 'y']);
    await revokeAllOtherSessions(userId, '', 'PASSWORD_RESET');
    for (const n of ['x', 'y', 'cur']) expect(await r.client.exists(`${PREFIX}${sid(n)}`)).toBe(0);
  });

  test('revokeDeviceSession removes that one session from Redis', async () => {
    await seed(['one', 'two']);
    const row = await pool.query('SELECT id FROM device_sessions WHERE sid = $1', [sid('one')]);
    expect(await revokeDeviceSession(userId, row.rows[0].id, 'TEST')).toBe(true);
    expect(await r.client.exists(`${PREFIX}${sid('one')}`)).toBe(0);
    expect(await r.client.exists(`${PREFIX}${sid('two')}`)).toBe(1);
  });
});

describe('switching the store Postgres -> Redis (existing sessions)', () => {
  test('a session saved in the Postgres store is NOT visible to the Redis store (user must log in again)', async () => {
    const pgStore = new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true });
    const redis = createRedisSessionStore(URL_, { prefix: `${PREFIX}sw:` });
    const id = `sw-${process.pid}-${Date.now()}`;
    try {
      await call((cb) => pgStore.set(id, mkSess(), cb));
      expect((await call((cb) => pgStore.get(id, cb))).user).toEqual({ id: 1 });
      expect(await call((cb) => redis.store.get(id, cb))).toBeNull();
    } finally {
      await call((cb) => pgStore.destroy(id, cb)).catch(() => {});
      redis.client.disconnect();
      if (pgStore.close) pgStore.close();
    }
  });
});
