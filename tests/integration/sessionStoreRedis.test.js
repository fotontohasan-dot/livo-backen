// আসল Redis-এ সেশন-স্টোর: save / load / touch(TTL) / destroy / দুই আলাদা instance থেকে পড়া।
// TEST_REDIS_URL না থাকলে স্থানীয় ডিফল্ট; Redis না পেলে টেস্ট ব্যর্থ হয় (skip নয়)।
const { createRedisSessionStore } = require('../../services/sessionStore');

const URL_ = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const PREFIX = `test:sess:${process.pid}:`;
const call = (fn) => new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v))));
const mkSess = (ms = 60000, extra = {}) => ({
  cookie: { originalMaxAge: ms, expires: new Date(Date.now() + ms).toISOString(), httpOnly: true },
  user: { id: 42, role: 'user' }, ...extra
});

describe('Redis session store (real Redis)', () => {
  let a, b;
  beforeAll(() => { a = createRedisSessionStore(URL_, { prefix: PREFIX }); b = createRedisSessionStore(URL_, { prefix: PREFIX }); });
  afterAll(async () => {
    const keys = await a.client.keys(`${PREFIX}*`);
    if (keys.length) await a.client.del(...keys);
    a.client.disconnect(); b.client.disconnect();
  });

  test('save then load returns same session; stored as JSON with prefix and TTL', async () => {
    const s = mkSess();
    await call((cb) => a.store.set('sid-1', s, cb));
    const got = await call((cb) => a.store.get('sid-1', cb));
    expect(got.user).toEqual({ id: 42, role: 'user' });
    const raw = await a.client.get(`${PREFIX}sid-1`);
    expect(JSON.parse(raw).user.id).toBe(42);
    const ttl = await a.client.ttl(`${PREFIX}sid-1`);
    expect(ttl).toBeGreaterThan(50); expect(ttl).toBeLessThanOrEqual(60);
  });

  test('touch refreshes TTL', async () => {
    await call((cb) => a.store.set('sid-2', mkSess(10000), cb));
    const longer = mkSess(120000);
    await call((cb) => a.store.touch('sid-2', longer, cb));
    expect(await a.client.ttl(`${PREFIX}sid-2`)).toBeGreaterThan(100);
  });

  test('destroy removes the session', async () => {
    await call((cb) => a.store.set('sid-3', mkSess(), cb));
    await call((cb) => a.store.destroy('sid-3', cb));
    expect(await call((cb) => a.store.get('sid-3', cb))).toBeNull();
    expect(await a.client.exists(`${PREFIX}sid-3`)).toBe(0);
  });

  test('session saved by instance A is readable and destroyable from instance B', async () => {
    await call((cb) => a.store.set('sid-4', mkSess(60000, { cart: [1, 2] }), cb));
    const got = await call((cb) => b.store.get('sid-4', cb));
    expect(got.cart).toEqual([1, 2]);
    await call((cb) => b.store.destroy('sid-4', cb));
    expect(await call((cb) => a.store.get('sid-4', cb))).toBeNull();
  });

  test('expired-cookie session is not kept', async () => {
    await call((cb) => a.store.set('sid-5', mkSess(-1000), cb));
    expect(await a.client.exists(`${PREFIX}sid-5`)).toBe(0);
  });

  test('ids() lists stored sessions (scan path)', async () => {
    await call((cb) => a.store.set('sid-6', mkSess(), cb));
    expect(await call((cb) => a.store.ids(cb))).toContain('sid-6');
  });
});
