// K10 (ফেইল-ওপেন) — সাসপেন্ড অবস্থা (Postgres, integration_suspend) *পড়তে* ব্যর্থ হলে বাজির পথ চালু থাকে
// (warn লগে কোনো মান নয় + মেট্রিক); পড়া সফল ও সাসপেন্ড থাকলে আগের মতোই 503 STALE_ODDS।
// স্পোর্টস বাসি-ডেটার আলাদা গার্ড (assessMatchFreshness) এই ফেইল-ওপেনে অক্ষত।
process.env.AUTO_SUSPEND_CACHE_TTL_MS = '1';
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { createAutoSuspend } = require('../../services/autoSuspend');
const metrics = require('../../services/metrics');

const SECRET_MARK = 'SECRETVALUE_dsn_postgres://u:p@h/db';
const DEPTH = { A: { name: 'Alpha', back: 2.0, lay: 2.5 }, B: { name: 'Beta', back: 3.0, lay: 3.4 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const u = await pool.query('UPDATE users SET coins = $1 WHERE username = $2 RETURNING id', [coins, username]);
  return { agent, token, userId: u.rows[0].id };
}
async function makeMarket(syncedAt = new Date()) {
  const m = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status, provider, synced_at)
     VALUES ('SuspendFailOpen','Alpha','Beta','cricket','live','cricket-cricapi', $1) RETURNING id`, [syncedAt]);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,'open') RETURNING id`,
    [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH)]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
const bet = (u, matchId, body) => u.agent.post(`/matches/${matchId}/bet`).set('X-CSRF-Token', u.token).type('form').send(body);
const betCount = async (userId) => Number((await pool.query('SELECT COUNT(*)::int AS n FROM bets WHERE user_id = $1', [userId])).rows[0].n);
const setSuspended = () => pool.query(
  `INSERT INTO integration_suspend (name, suspended, source, reason, suspended_at, updated_at)
   VALUES ('sports:cricapi', true, 'auto', 'consecutive_failures', NOW(), NOW())
   ON CONFLICT (name) DO UPDATE SET suspended = true, source = 'auto', reason = 'consecutive_failures', suspended_at = NOW()`);
const clear = () => pool.query("DELETE FROM integration_suspend WHERE name = 'sports:cricapi'");
async function failureCount() {
  const m = metrics.register && metrics.register.getSingleMetric('bet420_auto_suspend_read_failures_total');
  if (!m) return null;
  const { values } = await m.get();
  return values.length ? values[0].value : 0;
}

// integration_suspend পড়ার কোয়েরি ব্যর্থ করে; বাকি সব কোয়েরি (বাজি, ইউজার, ওয়ালেট) যথারীতি চলে।
function breakSuspendReads() {
  const real = pool.query.bind(pool);
  return jest.spyOn(pool, 'query').mockImplementation((text, ...rest) => {
    if (/integration_suspend/i.test(typeof text === 'string' ? text : (text && text.text) || '')) {
      const e = new Error(`connection to ${SECRET_MARK} lost`); e.code = 'ECONNRESET';
      return Promise.reject(e);
    }
    return real(text, ...rest);
  });
}

afterEach(async () => { jest.restoreAllMocks(); await clear(); });
afterAll(async () => { await pool.query("UPDATE matches SET status = 'finished' WHERE title = 'SuspendFailOpen'"); });

describe('সার্ভিস স্তর: পড়া ব্যর্থ → ফেইল-ওপেন, warn (মান ছাড়া) + মেট্রিক', () => {
  test('স্টোর ব্যর্থ: isSuspended=false, getMatchProviderSuspension=null; warn-এ error message/মান নেই; প্রতিবার hook', async () => {
    const warn = jest.fn(); const hook = jest.fn();
    const store = { get: async () => { throw Object.assign(new Error(SECRET_MARK), { code: 'ECONNRESET' }); }, list: async () => { throw new Error(SECRET_MARK); } };
    const svc = createAutoSuspend({ store, env: { AUTO_SUSPEND_CACHE_TTL_MS: '1' }, logger: { warn }, onReadFailure: hook });
    expect(await svc.isSuspended('sports:cricapi')).toBe(false);
    expect(await svc.getMatchProviderSuspension('cricket-cricapi')).toBeNull();
    expect(await svc.listStates()).toEqual([]);
    expect(hook).toHaveBeenCalledTimes(3);              // প্রতিটা ব্যর্থ পড়ায় মেট্রিক
    expect(warn).toHaveBeenCalledTimes(1);              // লগ throttled (৩০ সেকেন্ডে একবার)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRETVALUE'); // কোনো মান/বার্তা নয়
    expect(JSON.stringify(warn.mock.calls)).toContain('ECONNRESET');      // শুধু নিরাপদ কোড
  });

  test('hook নিজে ব্যর্থ হলেও ফেইল-ওপেন বজায় থাকে', async () => {
    const store = { get: async () => { throw new Error('x'); }, list: async () => [] };
    const svc = createAutoSuspend({ store, env: {}, logger: { warn: () => {} }, onReadFailure: () => { throw new Error('metric down'); } });
    await expect(svc.isSuspended('sports:cricapi')).resolves.toBe(false);
  });

  test('পড়া সফল ও সাসপেন্ড থাকলে true; hook ডাকা হয় না', async () => {
    const hook = jest.fn();
    const store = { get: async () => ({ name: 'sports:cricapi', suspended: true, source: 'auto' }), list: async () => [] };
    const svc = createAutoSuspend({ store, env: {}, logger: { warn: () => {} }, onReadFailure: hook });
    expect(await svc.isSuspended('sports:cricapi')).toBe(true);
    expect(await svc.getMatchProviderSuspension('cricket-cricapi')).toBeTruthy();
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('বাজির রুট (আসল Postgres)', () => {
  test('সাসপেন্ড-অবস্থা পড়া ব্যর্থ → বাজি চলে (200, বাজি তৈরি, কয়েন কাটে); warn মান ছাড়া; মেট্রিক বাড়ে', async () => {
    const u = await makeUser(1000);
    const m = await makeMarket();
    await setSuspended();            // DB-তে আসলে সাসপেন্ড — কিন্তু পড়া যাচ্ছে না, তাই ফেইল-ওপেন
    await sleep(10);                 // ক্যাশ TTL (1ms) শেষ
    const before = await failureCount();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    breakSuspendReads();

    const r = await bet(u, m.matchId, { market_id: m.marketId, runner: 'A', side: 'back', stake: '100' });
    expect(r.status).toBe(200);
    expect(await betCount(u.userId)).toBe(1);

    const suspendWarns = warn.mock.calls.filter((c) => String(c[0]).includes('[auto-suspend]'));
    expect(suspendWarns).toHaveLength(1); // এই ফাইলে সিঙ্গেলটনের প্রথম ব্যর্থ পড়া; throttle-এর কারণে একটাই warn
    expect(String(suspendWarns[0][0])).toContain('code=ECONNRESET');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRETVALUE');
    const after = await failureCount();
    expect(metrics.enabled).toBe(true);
    expect(after).toBeGreaterThan(before); // মেট্রিক বেড়েছে
  });

  test('পড়া সফল ও সাসপেন্ড থাকলে → 503 STALE_ODDS (suspended: true), বাজি/কয়েন-কাটা নেই', async () => {
    const u = await makeUser(1000);
    const m = await makeMarket();
    await setSuspended();
    await sleep(10);
    const r = await bet(u, m.matchId, { market_id: m.marketId, runner: 'A', side: 'back', stake: '100' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ success: false, code: 'STALE_ODDS', suspended: true });
    expect(await betCount(u.userId)).toBe(0);
  });

  test('স্পোর্টস বাসি-ডেটার আলাদা গার্ড অক্ষত: ম্যাচ বাসি হলে পড়া ব্যর্থ/সফল দুই ক্ষেত্রেই 503 STALE_ODDS (suspended চিহ্ন ছাড়া)', async () => {
    const u = await makeUser(1000);
    const stale = await makeMarket(new Date(Date.now() - 3 * 60 * 60 * 1000));
    await sleep(10);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // (ক) সাসপেন্ড নেই, পড়া সফল
    const a = await bet(u, stale.matchId, { market_id: stale.marketId, runner: 'A', side: 'back', stake: '100' });
    expect(a.status).toBe(503);
    expect(a.body.code).toBe('STALE_ODDS');
    expect(a.body.suspended).toBeUndefined();

    // (খ) পড়া ব্যর্থ — ফেইল-ওপেন হলেও বাসি গার্ড বাজি আটকায়
    breakSuspendReads();
    const b = await bet(u, stale.matchId, { market_id: stale.marketId, runner: 'A', side: 'back', stake: '100' });
    expect(b.status).toBe(503);
    expect(b.body.code).toBe('STALE_ODDS');
    expect(b.body.suspended).toBeUndefined();
    expect(await betCount(u.userId)).toBe(0);
  });
});
