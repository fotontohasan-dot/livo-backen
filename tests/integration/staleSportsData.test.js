// ==================== Step 4B — A1: বাসি (stale) স্পোর্টস ডেটা — fail-closed ====================
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { pool } = require('../../db');
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const accumulator = require('../../services/accumulator');
const fresh = require('../../services/dataFreshness');

const HOUR = 60 * 60 * 1000;
const DEPTH = { A: { name: 'Alpha', back: 2.0, lay: 2.5 }, B: { name: 'Beta', back: 3.0, lay: 3.4 } };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const u = await pool.query('UPDATE users SET coins = $1 WHERE username = $2 RETURNING id', [coins, username]);
  return { agent, token, userId: u.rows[0].id };
}

// provider/syncedAgoMs: null provider = হাতে তৈরি ম্যাচ; syncedAgoMs null = কখনো সিঙ্ক হয়নি
async function makeMarket({ provider = 'cricket-cricapi', syncedAgoMs = 0, sport = 'cricket' } = {}) {
  const syncedAt = syncedAgoMs === null ? null : new Date(Date.now() - syncedAgoMs);
  const m = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status, provider, synced_at)
     VALUES ('StaleTest','Alpha','Beta',$1,'live',$2,$3) RETURNING id`, [sport, provider, syncedAt]);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,'open') RETURNING id`,
    [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH)]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
const bet = (u, matchId, body) =>
  u.agent.post(`/matches/${matchId}/bet`).set('X-CSRF-Token', u.token).type('form').send(body);
const betRows = async (userId) => (await pool.query('SELECT 1 FROM bets WHERE user_id = $1', [userId])).rowCount;
const betNet = async (id) => Number((await pool.query(
  'SELECT COALESCE(SUM(amount),0) AS n FROM coin_transactions WHERE user_id=$1 AND ref_bet_id IS NOT NULL', [id])).rows[0].n);

afterAll(async () => { await pool.query("UPDATE matches SET status = 'finished' WHERE title = 'StaleTest'"); });

describe('dataFreshness — নিয়ম', () => {
  test('provider-সিঙ্ক ম্যাচ: সীমার ভেতরে fresh, বাইরে বা কখনো-সিঙ্ক-নয় হলে stale; হাতে তৈরি ম্যাচ প্রযোজ্য নয়', () => {
    const now = Date.now();
    const max = fresh.maxAgeMs();
    expect(fresh.assessMatchFreshness({ provider: 'p', synced_at: new Date(now - 1000) }, now).stale).toBe(false);
    expect(fresh.assessMatchFreshness({ provider: 'p', synced_at: new Date(now - max - 1000) }, now)).toMatchObject({ stale: true, reason: 'older_than_limit' });
    expect(fresh.assessMatchFreshness({ provider: 'p', synced_at: null }, now)).toMatchObject({ stale: true, reason: 'never_synced' });
    expect(fresh.assessMatchFreshness({ provider: null, synced_at: null }, now).stale).toBe(false);
    expect(() => fresh.assertMatchFresh({ id: 7, provider: 'p', synced_at: null })).toThrow(fresh.StaleDataError);
  });

  test('assertFreshProviderData: stale চিহ্নিত ডেটা ফেলে দেয়; সেটলমেন্টের উৎস শুধু admin বা fresh provider', () => {
    const staleArr = []; Object.defineProperty(staleArr, 'stale', { value: true, enumerable: false });
    expect(() => fresh.assertFreshProviderData(staleArr)).toThrow(/stale/);
    expect(fresh.assertFreshProviderData([])).toEqual([]);
    expect(fresh.assertSettlementSource({ source: 'admin' })).toBe(true);
    expect(fresh.assertSettlementSource({ source: 'provider', data: [] })).toBe(true);
    expect(() => fresh.assertSettlementSource({ source: 'provider', data: staleArr })).toThrow(fresh.StaleDataError);
    expect(() => fresh.assertSettlementSource({ source: 'cache' })).toThrow(fresh.StaleDataError);
    expect(() => fresh.assertSettlementSource({})).toThrow(fresh.StaleDataError);
  });
});

describe('বাজি গ্রহণ: বাসি ডেটায় প্রত্যাখ্যান (fail-closed)', () => {
  test('বাসি (২ ঘণ্টা আগে সিঙ্ক) ম্যাচে বাজি → ৫০৩ STALE_ODDS, বাজি/কয়েন-কাটা নেই', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket({ syncedAgoMs: 2 * HOUR });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ success: false, code: 'STALE_ODDS' });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[STALE_DATA]'))).toBe(true); // পরিষ্কার অভ্যন্তরীণ এরর লগ
    errSpy.mockRestore();
    expect(await betRows(u.userId)).toBe(0);
    expect(await betNet(u.userId)).toBe(0);
  });

  test('কখনো সিঙ্ক হয়নি (synced_at NULL, provider আছে) → প্রত্যাখ্যান', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket({ syncedAgoMs: null });
    const r = await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('STALE_ODDS');
  });

  test('Lay বাজিও বাসি ডেটায় প্রত্যাখ্যাত', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket({ syncedAgoMs: 2 * HOUR });
    const r = await bet(u, matchId, { market_id: marketId, runner: 'A', bet_type: 'lay', stake: '100' });
    expect(r.status).toBe(503);
    expect(await betRows(u.userId)).toBe(0);
  });

  test('তাজা সিঙ্ক → বাজি গৃহীত; হাতে তৈরি ম্যাচ (provider NULL) → গৃহীত', async () => {
    const u = await makeUser(1000);
    const a = await makeMarket({ syncedAgoMs: 1000 });
    expect((await bet(u, a.matchId, { market_id: a.marketId, runner: 'A', side: 'back', stake: '100' })).status).toBe(200);
    const b = await makeMarket({ provider: null, syncedAgoMs: null });
    expect((await bet(u, b.matchId, { market_id: b.marketId, runner: 'A', side: 'back', stake: '100' })).status).toBe(200);
  });

  test('ম্যাচ বাসি হয়ে গেলে আগে-তাজা ম্যাচও থেমে যায়; আবার সিঙ্ক হলে খোলে', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket({ syncedAgoMs: 1000 });
    await pool.query('UPDATE matches SET synced_at = $1 WHERE id = $2', [new Date(Date.now() - 3 * HOUR), matchId]);
    expect((await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' })).status).toBe(503);
    await pool.query('UPDATE matches SET synced_at = NOW() WHERE id = $1', [matchId]);
    expect((await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' })).status).toBe(200);
  });

  test('accumulator: বাসি ম্যাচের সিলেকশন থাকলে পুরো acca প্রত্যাখ্যাত, কয়েন অক্ষত', async () => {
    const u = await makeUser(5000);
    const good = await makeMarket({ syncedAgoMs: 1000 });
    const old = await makeMarket({ syncedAgoMs: 2 * HOUR });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await accumulator.placeAccumulator(u.userId, 100, [
      { match_id: good.matchId, market_id: good.marketId, runner: 'A' },
      { match_id: old.matchId, market_id: old.marketId, runner: 'A' }
    ], 'en');
    errSpy.mockRestore();
    expect(r.success).toBe(false);
    expect(r.code).toBe('STALE_ODDS');
    const c = await pool.query('SELECT coins FROM users WHERE id = $1', [u.userId]);
    expect(Number(c.rows[0].coins)).toBe(5000);
    expect((await pool.query('SELECT 1 FROM accumulators WHERE user_id = $1', [u.userId])).rowCount).toBe(0);
  });
});

describe('সিঙ্ক: বাসি প্রোভাইডার ডেটা DB-তে তাজা সেজে ঢোকে না', () => {
  const sportsAPI = require('../../services/sportsAPI');
  const cric = require('../../services/providers/cricApi');
  const rapid = require('../../services/providers/footballRapidApi');
  const raw = { id: 'stale-test-1', name: 'Alpha vs Beta', matchType: 't20', status: 'Match started', teams: ['Alpha', 'Beta'], score: [], dateTimeGMT: new Date().toISOString() };
  const markStale = (arr) => { Object.defineProperty(arr, 'stale', { value: true, enumerable: false }); Object.defineProperty(arr, 'staleSince', { value: new Date().toISOString(), enumerable: false }); return arr; };
  let envBackup;
  beforeEach(() => { envBackup = { c: process.env.CRICKET_API_KEY, r: process.env.RAPIDAPI_KEY }; process.env.CRICKET_API_KEY = 'test-not-a-real-key'; process.env.RAPIDAPI_KEY = 'test-not-a-real-key'; });
  afterEach(() => { process.env.CRICKET_API_KEY = envBackup.c; process.env.RAPIDAPI_KEY = envBackup.r; if (envBackup.c === undefined) delete process.env.CRICKET_API_KEY; if (envBackup.r === undefined) delete process.env.RAPIDAPI_KEY; jest.restoreAllMocks(); });

  test('cricApi/footballRapidApi: stale হলে খালি তালিকা (fresh হলে স্বাভাবিক)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(sportsAPI, 'getCricketCurrentMatches').mockResolvedValue(markStale([raw]));
    expect(await cric.fetchMatches()).toEqual([]);
    jest.spyOn(sportsAPI, 'getFootballLiveScores').mockResolvedValue(markStale([{ fixture: { id: 1 } }]));
    expect(await rapid.fetchMatches()).toEqual([]);
    sportsAPI.getCricketCurrentMatches.mockResolvedValue([raw]);
    expect((await cric.fetchMatches()).length).toBe(1);
  });

  test('syncOnce: বাসি ডেটায় বিদ্যমান ম্যাচের synced_at বদলায় না (তাই বাজি গার্ড কাজ করে)', async () => {
    const { syncOnce } = require('../../services/matchUpdater');
    const norm = cric.normalizeOne(raw);
    expect(norm).toBeTruthy();
    const old = new Date(Date.now() - 2 * HOUR);
    await pool.query(`DELETE FROM matches WHERE provider = $1 AND external_id = $2`, [norm.provider, norm.externalId]);
    const ins = await pool.query(
      `INSERT INTO matches (title, team_a, team_b, sport, status, provider, external_id, synced_at)
       VALUES ('StaleTest','Alpha','Beta','cricket','live',$1,$2,$3) RETURNING id`, [norm.provider, norm.externalId, old]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(sportsAPI, 'getFootballLiveScores').mockResolvedValue([]);
    jest.spyOn(sportsAPI, 'getCricketCurrentMatches').mockResolvedValue(markStale([raw]));
    await syncOnce();
    const row = (await pool.query('SELECT synced_at FROM matches WHERE id = $1', [ins.rows[0].id])).rows[0];
    expect(new Date(row.synced_at).getTime()).toBe(old.getTime()); // অপরিবর্তিত

    // তাজা ডেটা এলে সিঙ্ক হয় ও synced_at এগোয়
    sportsAPI.getCricketCurrentMatches.mockResolvedValue([raw]);
    await syncOnce();
    const row2 = (await pool.query('SELECT synced_at FROM matches WHERE id = $1', [ins.rows[0].id])).rows[0];
    expect(new Date(row2.synced_at).getTime()).toBeGreaterThan(old.getTime());
  });
});

describe('সেটলমেন্ট: বাসি ক্যাশ/প্রোভাইডার ডেটা পড়ার কোনো পথ নেই', () => {
  const importsProviderData = (src) => /require\(['"][^'"]*(sportsAPI|providers|matchUpdater)[^'"]*['"]\)/.test(src);

  test('সেটলমেন্ট-সংশ্লিষ্ট কোনো ফাইল sportsAPI / providers / matchUpdater import করে না', () => {
    for (const f of ['services/settlement.js', 'services/accumulator.js', 'routes/admin.js', 'routes/accumulator.js']) {
      expect({ file: f, importsProviderData: importsProviderData(read(f)) }).toEqual({ file: f, importsProviderData: false });
    }
  });

  test('শুধু ম্যাচ-সিঙ্ক (matchUpdater ← providers ← sportsAPI) প্রোভাইডার ডেটা পড়ে; বাজি-গ্রহণ ফাইলও পড়ে না', () => {
    for (const f of ['routes/matches.js', 'services/accumulator.js']) expect(importsProviderData(read(f))).toBe(false);
    expect(read('services/settlement.js')).not.toMatch(/stale|synced_at/); // ফলাফল আসে শুধু অ্যাডমিনের winning_runner থেকে
  });

  test('অ্যাডমিন-নিশ্চিত ফলাফলে সেটল হয় — ম্যাচের প্রোভাইডার ডেটা বাসি হলেও (ফলাফল ক্যাশ থেকে আসে না)', async () => {
    const { settleMarketBets } = require('../../services/settlement');
    const { matchId, marketId } = await makeMarket({ syncedAgoMs: 5 * HOUR });
    const u = await makeUser(1000);
    await pool.query(`UPDATE matches SET provider = NULL, synced_at = NULL WHERE id = $1`, [matchId]); // বেট বসানোর জন্য
    expect((await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' })).status).toBe(200);
    await pool.query(`UPDATE matches SET provider = 'cricket-cricapi', synced_at = $2 WHERE id = $1`, [matchId, new Date(Date.now() - 5 * HOUR)]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await settleMarketBets(client, marketId, 'A');
      await client.query('COMMIT');
    } finally { client.release(); }
    const b = await pool.query('SELECT status FROM bets WHERE user_id = $1', [u.userId]);
    expect(b.rows[0].status).toBe('won');
  });
});

describe('বাসি-পতাকা যেখানে ডেটা দেখানো হয়', () => {
  test('/matches/api/live: প্রতিটা ম্যাচে data_stale + synced_at; বাসিতে লেবেল', async () => {
    const stale = await makeMarket({ syncedAgoMs: 2 * HOUR, sport: 'football' });
    const ok = await makeMarket({ syncedAgoMs: 1000, sport: 'football' });
    await require('../../services/cache').del('matches:live');
    const res = await request(app).get('/matches/api/live').set('User-Agent', REALISTIC_UA);
    expect(res.status).toBe(200);
    const all = Object.values(res.body).flat ? Object.values(res.body).flat() : [];
    const list = Array.isArray(res.body) ? res.body : (res.body.matches || res.body.data || all);
    const find = (id) => (Array.isArray(list) ? list : Object.values(list).flat()).find((m) => m && m.id === id);
    const s = find(stale.matchId); const f = find(ok.matchId);
    expect(s).toBeTruthy();
    expect(s.data_stale).toBe(true);
    expect(s.stale_label).toBeTruthy();
    expect(typeof s.synced_at).toBe('string');
    if (f) expect(f.data_stale).toBe(false);
  });

  test('/matches/:id/markets JSON ও ম্যাচ-পেজে বাসি-পতাকা', async () => {
    const stale = await makeMarket({ syncedAgoMs: 2 * HOUR });
    const ok = await makeMarket({ syncedAgoMs: 1000 });
    const j1 = await request(app).get(`/matches/${stale.matchId}/markets`).set('User-Agent', REALISTIC_UA);
    expect(j1.body.data_stale).toBe(true);
    const j2 = await request(app).get(`/matches/${ok.matchId}/markets`).set('User-Agent', REALISTIC_UA);
    expect(j2.body.data_stale).toBe(false);
    const p1 = await request(app).get(`/matches/${stale.matchId}`).set('User-Agent', REALISTIC_UA);
    expect(p1.text).toContain('md-stale');
    const p2 = await request(app).get(`/matches/${ok.matchId}`).set('User-Agent', REALISTIC_UA);
    expect(p2.text).not.toContain('md-stale');
  });

  test('ক্লায়েন্ট রেন্ডারারগুলো data_stale দেখায়', () => {
    for (const f of ['public/js/views/matches.js', 'public/js/views/home-matches.js', 'public/js/views/sports-index.js']) {
      expect(read(f)).toMatch(/data_stale/);
    }
  });
});
