// tests/integration/matchIdempotency.test.js
// ---------------------------------------------------------------------------
// ম্যাচ ডেটা ইন্টিগ্রিটি — ডুপ্লিকেট প্রতিরোধ ও idempotent সিঙ্ক।
//
// আগের বাগ: services/matchUpdater.js `INSERT ... ON CONFLICT DO NOTHING` চালাত,
// কিন্তু matches টেবিলে কোনো UNIQUE কনস্ট্রেইন্টই ছিল না। ফলে কনফ্লিক্ট কখনো ঘটত না
// এবং প্রতি ১৫ মিনিটের প্রতিটা পোলে একই ম্যাচের নতুন রো ঢুকত (দিনে ৯৬ বার)।
// এখন (provider, external_id) এর উপর partial unique index আছে ও সত্যিকারের UPSERT হয়।
//
// এখানে বিশেষভাবে যাচাই করা হচ্ছে যে ম্যাচের `id` কখনো বদলায় না — কারণ
// markets.match_id ও bets.match_id ওই id-তে ফরেন কী দিয়ে বাঁধা। id বদলে গেলে
// বেট, মার্কেট, সেটলমেন্ট ও ইউজারের বেট হিস্ট্রি সব ভেঙে যেত।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { upsertMatch, syncOnce, findLegacyDuplicateMatches } = require('../../services/matchUpdater');
const request = require('supertest');
// supertest-কে সরাসরি express অ্যাপ না দিয়ে helpers/app.js-এর শেয়ার্ড listening
// সার্ভার দেওয়া হচ্ছে — নাহলে supertest প্রতি রিকোয়েস্টে নিজে listen/close করে,
// যা সমান্তরাল রিকোয়েস্টে ECONNRESET তৈরি করত (helpers/app.js-এর ব্যাখ্যা দেখো)।
// মডিউল-স্কোপে require করা আবশ্যক: হেল্পার beforeAll/afterAll রেজিস্টার করে,
// আর Jest টেস্টের ভেতরে হুক ডিফাইন করতে দেয় না।
const { app } = require('../helpers/app');

const TEST_PROVIDER = 'test-provider';

function makeMatch(overrides = {}) {
  return {
    provider: TEST_PROVIDER,
    externalId: 'ext-100',
    sport: 'cricket',
    title: 'India vs Australia',
    league: null,
    teamA: 'India',
    teamB: 'Australia',
    status: 'upcoming',
    scoreA: null,
    scoreB: null,
    overs: null,
    startTime: null,
    metadata: null,
    ...overrides
  };
}

async function countByExternalId(provider, externalId) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS c FROM matches WHERE provider = $1 AND external_id = $2',
    [provider, externalId]
  );
  return r.rows[0].c;
}

afterEach(async () => {
  await pool.query("DELETE FROM matches WHERE provider LIKE 'test-%' OR provider = $1", [TEST_PROVIDER]);
});

describe('ম্যাচ idempotency', () => {
  test('একই ম্যাচ দুইবার আনলে একটাই রো থাকে', async () => {
    const m = makeMatch();
    const first = await upsertMatch(m);
    const second = await upsertMatch(m);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await countByExternalId(TEST_PROVIDER, 'ext-100')).toBe(1);
  });

  test('বারবার (১০ বার) সিঙ্ক করলেও একটাই রো থাকে', async () => {
    const m = makeMatch({ externalId: 'ext-repeat' });
    for (let i = 0; i < 10; i += 1) await upsertMatch(m);
    expect(await countByExternalId(TEST_PROVIDER, 'ext-repeat')).toBe(1);
  });

  test('একসাথে (concurrent) সিঙ্ক করলেও ডুপ্লিকেট হয় না', async () => {
    const m = makeMatch({ externalId: 'ext-concurrent' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => upsertMatch(m)));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    expect(await countByExternalId(TEST_PROVIDER, 'ext-concurrent')).toBe(1);
  });

  test('ভিন্ন প্রোভাইডারের একই external ID আলাদা ম্যাচ থাকে (সংঘর্ষ হয় না)', async () => {
    const a = await upsertMatch(makeMatch({ provider: 'test-provider', externalId: 'shared-id' }));
    const b = await upsertMatch(makeMatch({ provider: 'test-other', externalId: 'shared-id', sport: 'football' }));

    expect(b.id).not.toBe(a.id);
    expect(await countByExternalId('test-provider', 'shared-id')).toBe(1);
    expect(await countByExternalId('test-other', 'shared-id')).toBe(1);
  });

  test('ভিন্ন external ID আলাদা ম্যাচ হিসেবেই থাকে', async () => {
    const a = await upsertMatch(makeMatch({ externalId: 'ext-a' }));
    const b = await upsertMatch(makeMatch({ externalId: 'ext-b' }));
    expect(a.id).not.toBe(b.id);
  });

  test('একই দুই দলের দুটো আলাদা ম্যাচ (যেমন সিরিজের দুই খেলা) আলাদা থাকে', async () => {
    const g1 = await upsertMatch(makeMatch({ externalId: 'game-1', title: 'IND vs AUS, 1st ODI' }));
    const g2 = await upsertMatch(makeMatch({ externalId: 'game-2', title: 'IND vs AUS, 2nd ODI' }));
    expect(g1.id).not.toBe(g2.id);

    const r = await pool.query(
      'SELECT COUNT(*)::int AS c FROM matches WHERE provider = $1 AND team_a = $2 AND team_b = $3',
      [TEST_PROVIDER, 'India', 'Australia']
    );
    expect(r.rows[0].c).toBe(2);
  });
});

describe('বিদ্যমান ম্যাচ আপডেট', () => {
  test('স্কোর/স্ট্যাটাস আপডেট হয়, নতুন রো তৈরি হয় না', async () => {
    const created = await upsertMatch(makeMatch({ externalId: 'ext-update' }));
    await upsertMatch(makeMatch({
      externalId: 'ext-update', status: 'live', scoreA: '250/4', scoreB: '211/10', overs: '45.2'
    }));

    const r = await pool.query('SELECT status, score_a, score_b, overs FROM matches WHERE id = $1', [created.id]);
    expect(r.rows[0]).toMatchObject({ status: 'live', score_a: '250/4', score_b: '211/10', overs: '45.2' });
    expect(await countByExternalId(TEST_PROVIDER, 'ext-update')).toBe(1);
  });

  test('পরের সিঙ্কে ফিল্ড অনুপস্থিত থাকলে পুরনো মান মুছে যায় না', async () => {
    const created = await upsertMatch(makeMatch({ externalId: 'ext-keep', scoreA: '100/2', league: 'Test Series' }));
    await upsertMatch(makeMatch({ externalId: 'ext-keep', scoreA: null, league: null, status: 'live' }));

    const r = await pool.query('SELECT score_a, league, status FROM matches WHERE id = $1', [created.id]);
    expect(r.rows[0].score_a).toBe('100/2');   // COALESCE — হারায় না
    expect(r.rows[0].league).toBe('Test Series');
    expect(r.rows[0].status).toBe('live');     // status সবসময় সর্বশেষটাই
  });

  test('আপডেটে ম্যাচ id অপরিবর্তিত থাকে — bets/markets ফরেন কী অক্ষত', async () => {
    const created = await upsertMatch(makeMatch({ externalId: 'ext-fk' }));

    const market = await pool.query(
      `INSERT INTO markets (match_id, type, name, odds) VALUES ($1, '1x2', 'Match Winner', '{}') RETURNING id`,
      [created.id]
    );

    // ম্যাচ কয়েকবার রি-সিঙ্ক হলো
    await upsertMatch(makeMatch({ externalId: 'ext-fk', status: 'live', scoreA: '10/0' }));
    await upsertMatch(makeMatch({ externalId: 'ext-fk', status: 'finished', scoreA: '300/8' }));

    const stillLinked = await pool.query(
      'SELECT m.id FROM markets m JOIN matches mt ON mt.id = m.match_id WHERE m.id = $1',
      [market.rows[0].id]
    );
    expect(stillLinked.rows.length).toBe(1);

    await pool.query('DELETE FROM markets WHERE id = $1', [market.rows[0].id]);
  });
});

describe('সিঙ্ক রানার ও legacy ডুপ্লিকেট রিপোর্ট', () => {
  test('কোনো প্রোভাইডার কনফিগার করা না থাকলে সিঙ্ক নিরাপদে স্কিপ করে', async () => {
    const saved = { r: process.env.RAPIDAPI_KEY, c: process.env.CRICKET_API_KEY };
    delete process.env.RAPIDAPI_KEY;
    delete process.env.CRICKET_API_KEY;

    const result = await syncOnce();
    expect(result).toMatchObject({ inserted: 0, updated: 0, providers: [] });

    if (saved.r !== undefined) process.env.RAPIDAPI_KEY = saved.r;
    if (saved.c !== undefined) process.env.CRICKET_API_KEY = saved.c;
  });

  test('legacy ডুপ্লিকেট রিপোর্ট শুধু পড়ে — কিছু মুছে না', async () => {
    // provider/external_id ছাড়া দুটো রো = পুরনো বাগে তৈরি হওয়া ডুপ্লিকেটের অনুরূপ
    await pool.query(
      `INSERT INTO matches (title, sport, team_a, team_b, status) VALUES
       ('Legacy Dup','cricket','LegacyA','LegacyB','upcoming'),
       ('Legacy Dup','cricket','LegacyA','LegacyB','upcoming')`
    );

    const before = await pool.query("SELECT COUNT(*)::int c FROM matches WHERE team_a = 'LegacyA'");
    const dups = await findLegacyDuplicateMatches();
    const after = await pool.query("SELECT COUNT(*)::int c FROM matches WHERE team_a = 'LegacyA'");

    expect(after.rows[0].c).toBe(before.rows[0].c); // রিপোর্ট ধ্বংসাত্মক নয়
    const entry = dups.find((d) => d.team_a === 'LegacyA');
    expect(entry).toBeDefined();
    expect(entry.copies).toBeGreaterThanOrEqual(2);
    expect(entry.canonical_id).toBe(Math.min(...entry.match_ids));

    await pool.query("DELETE FROM matches WHERE team_a = 'LegacyA'");
  });
});

describe('বিদ্যমান ফ্রন্টএন্ড কনট্র্যাক্ট', () => {
  test('/matches/api/live সত্যিই ম্যাচ ফেরত দেয় (নীরব খালি ফল নয়)', async () => {
    await upsertMatch(makeMatch({ externalId: 'ext-live-cricket', status: 'live', scoreA: '120/3' }));
    await upsertMatch(makeMatch({
      externalId: 'ext-live-football', sport: 'football',
      teamA: 'Real', teamB: 'Barca', title: 'Real vs Barca', status: 'live'
    }));

    const res = await request(app).get('/matches/api/live');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // আগে কোয়েরিটা অস্তিত্বহীন কলামে ভেঙে যেত এবং catch ব্লক খালি অ্যারে দিত —
    // অর্থাৎ ম্যাচ পেজ সবসময় ফাঁকা থাকত, অথচ HTTP 200 আসত। এটাই সেই রিগ্রেশন গার্ড।
    expect(res.body.cricket.length + res.body.football.length).toBeGreaterThan(0);
    expect(res.body.cricket.some((m) => m.teams.includes('India'))).toBe(true);
    expect(res.body.football.some((m) => m.teams.includes('Real'))).toBe(true);

    const cricketMatch = res.body.cricket.find((m) => m.teams.includes('India'));
    expect(cricketMatch).toMatchObject({ status: 'live', homeScore: '120/3' });
  });

  test('/matches/api/live যে কলামগুলো পড়ে সেগুলো এখনো আছে', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'matches'`
    );
    const cols = r.rows.map((x) => x.column_name);
    for (const c of ['id', 'title', 'team_a', 'team_b', 'sport', 'league', 'status',
      'start_time', 'score_a', 'score_b', 'overs']) {
      expect(cols).toContain(c);
    }
    // নতুন কলামগুলোও যোগ হয়েছে
    for (const c of ['provider', 'external_id', 'provider_metadata', 'synced_at']) {
      expect(cols).toContain(c);
    }
  });

  test('idempotency ইনডেক্সটা সত্যিই বিদ্যমান', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'matches' AND indexname = 'uniq_matches_provider_external'`
    );
    expect(r.rows.length).toBe(1);
  });
});
