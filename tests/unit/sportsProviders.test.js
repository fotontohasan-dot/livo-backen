// tests/unit/sportsProviders.test.js
// ---------------------------------------------------------------------------
// প্রোভাইডার অ্যাডাপ্টারের ইউনিট টেস্ট — কোনো নেটওয়ার্ক কল ছাড়াই।
//
// অ্যাডাপ্টারগুলোর normalizeOne() আলাদা করে export করা হয়েছে ঠিক এই কারণেই:
// প্রোভাইডারের কাঁচা রেসপন্স আকার বদলালে বা অপ্রত্যাশিত ডেটা এলে কোর অ্যাপ যেন
// ক্র্যাশ না করে, বরং খারাপ রেকর্ডটা skip করে।
// ---------------------------------------------------------------------------

const football = require('../../services/providers/footballRapidApi');
const cricket = require('../../services/providers/cricApi');
const { buildNormalizedMatch } = require('../../services/providers/normalizedMatch');
const registry = require('../../services/providers');

describe('normalizedMatch contract', () => {
  test('provider/externalId/sport ছাড়া রেকর্ড বাতিল হয়', () => {
    expect(buildNormalizedMatch(null)).toBeNull();
    expect(buildNormalizedMatch({})).toBeNull();
    expect(buildNormalizedMatch({ provider: 'p', sport: 'cricket' })).toBeNull();
    expect(buildNormalizedMatch({ provider: 'p', externalId: '1' })).toBeNull();
  });

  test('অজানা status নিরাপদে upcoming হয়ে যায়', () => {
    const m = buildNormalizedMatch({ provider: 'p', externalId: '1', sport: 'cricket', status: 'weird' });
    expect(m.status).toBe('upcoming');
  });

  test('ফাঁকা স্ট্রিং null-এ পরিণত হয়, টিম না থাকলে TBA', () => {
    const m = buildNormalizedMatch({ provider: 'p', externalId: '1', sport: 'cricket', league: '   ', teamA: '' });
    expect(m.league).toBeNull();
    expect(m.teamA).toBe('TBA');
  });

  test('অবৈধ তারিখ null হয়, বৈধ তারিখ Date হয়', () => {
    expect(buildNormalizedMatch({ provider: 'p', externalId: '1', sport: 'x', startTime: 'not-a-date' }).startTime).toBeNull();
    expect(buildNormalizedMatch({ provider: 'p', externalId: '1', sport: 'x', startTime: '2026-05-01T10:00:00Z' }).startTime)
      .toBeInstanceOf(Date);
  });
});

describe('football অ্যাডাপ্টার (RapidAPI)', () => {
  test('বৈধ রেসপন্স normalize হয়', () => {
    const m = football.normalizeOne({
      id: 'fb-99', name: 'Real vs Barca', homeTeam: 'Real', awayTeam: 'Barca',
      league: 'La Liga', status: 'upcoming', homeScore: null, awayScore: null, date: '2026-05-01'
    });
    expect(m).toMatchObject({
      provider: 'football-rapidapi', externalId: 'fb-99', sport: 'football',
      teamA: 'Real', teamB: 'Barca', league: 'La Liga', status: 'upcoming'
    });
    expect(m.overs).toBeNull(); // ফুটবলে ওভার প্রযোজ্য নয়
  });

  test('external id না থাকলে রেকর্ড বাদ পড়ে (ডুপ্লিকেট ঠেকাতে)', () => {
    expect(football.normalizeOne({ homeTeam: 'A', awayTeam: 'B' })).toBeNull();
    expect(football.normalizeOne({ id: '   ', homeTeam: 'A' })).toBeNull();
  });

  test('malformed ইনপুটে throw করে না', () => {
    expect(football.normalizeOne(null)).toBeNull();
    expect(football.normalizeOne('string')).toBeNull();
    expect(football.normalizeOne(42)).toBeNull();
  });

  test('status ম্যাপিং বিদ্যমান আচরণ ধরে রাখে', () => {
    expect(football.mapStatus('1H')).toBe('live');
    expect(football.mapStatus('live')).toBe('live');
    expect(football.mapStatus('FT')).toBe('finished');
    expect(football.mapStatus('upcoming')).toBe('upcoming');
    expect(football.mapStatus(undefined)).toBe('upcoming');
  });

  test('API key না থাকলে নিষ্ক্রিয় ও খালি ফল', async () => {
    const saved = process.env.RAPIDAPI_KEY;
    delete process.env.RAPIDAPI_KEY;
    expect(football.isEnabled()).toBe(false);
    await expect(football.fetchMatches()).resolves.toEqual([]);
    if (saved !== undefined) process.env.RAPIDAPI_KEY = saved;
  });
});

describe('cricket অ্যাডাপ্টার (CricAPI)', () => {
  const rawMatch = {
    id: 'ck-1', name: 'IND vs AUS, 3rd ODI', status: 'India need 40 runs',
    teams: ['India', 'Australia'],
    score: [{ r: 250, w: 4, o: 45.2 }, { r: 211, w: 10, o: 49 }],
    matchType: 'odi', series_id: 'series-uuid', venue: 'Eden Gardens',
    dateTimeGMT: '2026-05-01T09:00:00'
  };

  test('বৈধ রেসপন্স normalize হয় — স্কোর ও ওভারসহ', () => {
    const m = cricket.normalizeOne(rawMatch);
    expect(m).toMatchObject({
      provider: 'cricket-cricapi', externalId: 'ck-1', sport: 'cricket',
      teamA: 'India', teamB: 'Australia', status: 'live',
      scoreA: '250/4', scoreB: '211/10', overs: '45.2'
    });
  });

  test('প্রোভাইডার সিরিজের নাম দিলে league সেট হয়', () => {
    const m = cricket.normalizeOne({ ...rawMatch, series: 'Border-Gavaskar Trophy' });
    expect(m.league).toBe('Border-Gavaskar Trophy');
  });

  test('সিরিজের নাম না থাকলে league null থাকে — বানানো হয় না', () => {
    const m = cricket.normalizeOne(rawMatch);
    expect(m.league).toBeNull();
    // series_id একটা UUID, লিগ নাম নয় — তাই league-এ নয়, metadata-তে রাখা হয়
    expect(m.metadata.series_id).toBe('series-uuid');
    expect(m.metadata.match_type).toBe('odi');
  });

  test('ঐচ্ছিক ফিল্ড না থাকলেও ভাঙে না', () => {
    const m = cricket.normalizeOne({ id: 'ck-2', teams: [], score: [] });
    expect(m).not.toBeNull();
    expect(m.teamA).toBe('TBA');
    expect(m.teamB).toBe('TBA');
    expect(m.scoreA).toBeNull();
    expect(m.overs).toBeNull();
    expect(m.metadata).toBeNull();
  });

  test('status ম্যাপিং বিদ্যমান আচরণ ধরে রাখে', () => {
    expect(cricket.mapStatus('India won by 5 wickets')).toBe('finished');
    expect(cricket.mapStatus('Match drawn')).toBe('finished');
    expect(cricket.mapStatus('Innings break')).toBe('live');
    expect(cricket.mapStatus('India opt to bat')).toBe('live');
    expect(cricket.mapStatus('Match not started')).toBe('upcoming');
  });

  test('malformed ইনপুটে throw করে না', () => {
    expect(cricket.normalizeOne(null)).toBeNull();
    expect(cricket.normalizeOne({ teams: ['A'] })).toBeNull(); // id নেই
    expect(cricket.formatScore(null)).toBeNull();
    expect(cricket.formatScore({})).toBeNull();
  });
});

describe('প্রোভাইডার রেজিস্ট্রি', () => {
  const savedRapid = process.env.RAPIDAPI_KEY;
  const savedCricket = process.env.CRICKET_API_KEY;
  const savedList = process.env.SPORTS_PROVIDERS;

  afterEach(() => {
    for (const [k, v] of [['RAPIDAPI_KEY', savedRapid], ['CRICKET_API_KEY', savedCricket], ['SPORTS_PROVIDERS', savedList]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('ক্রেডেনশিয়াল না থাকলে কোনো প্রোভাইডার সক্রিয় হয় না', () => {
    delete process.env.RAPIDAPI_KEY;
    delete process.env.CRICKET_API_KEY;
    delete process.env.SPORTS_PROVIDERS;
    expect(registry.getEnabledProviders()).toEqual([]);
  });

  test('ক্রেডেনশিয়াল থাকলে সংশ্লিষ্ট প্রোভাইডার সক্রিয় হয়', () => {
    process.env.RAPIDAPI_KEY = 'x';
    process.env.CRICKET_API_KEY = 'y';
    delete process.env.SPORTS_PROVIDERS;
    const names = registry.getEnabledProviders().map((p) => p.name);
    expect(names).toContain('football-rapidapi');
    expect(names).toContain('cricket-cricapi');
  });

  test('SPORTS_PROVIDERS allow-list দিয়ে নির্দিষ্ট প্রোভাইডার বেছে নেওয়া যায়', () => {
    process.env.RAPIDAPI_KEY = 'x';
    process.env.CRICKET_API_KEY = 'y';
    process.env.SPORTS_PROVIDERS = 'cricket-cricapi';
    const names = registry.getEnabledProviders().map((p) => p.name);
    expect(names).toEqual(['cricket-cricapi']);
  });

  test('প্রতিটা অ্যাডাপ্টার প্রয়োজনীয় ইন্টারফেস মেনে চলে', () => {
    for (const adapter of registry.ADAPTERS) {
      expect(typeof adapter.name).toBe('string');
      expect(typeof adapter.sport).toBe('string');
      expect(typeof adapter.isEnabled).toBe('function');
      expect(typeof adapter.fetchMatches).toBe('function');
    }
    // প্রোভাইডারের নাম অনন্য — না হলে (provider, external_id) পরিচয় অস্পষ্ট হয়ে যেত
    const names = registry.ADAPTERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('সিঙ্ক ইন্টারভাল ডিফল্ট ১৫ মিনিট এবং অনিরাপদ মান প্রত্যাখ্যাত হয়', () => {
    const saved = process.env.MATCH_SYNC_INTERVAL_MINUTES;
    delete process.env.MATCH_SYNC_INTERVAL_MINUTES;
    expect(registry.getSyncIntervalMs()).toBe(15 * 60 * 1000);
    process.env.MATCH_SYNC_INTERVAL_MINUTES = '1'; // rate limit ভাঙার মতো ছোট
    expect(registry.getSyncIntervalMs()).toBe(15 * 60 * 1000);
    process.env.MATCH_SYNC_INTERVAL_MINUTES = '30';
    expect(registry.getSyncIntervalMs()).toBe(30 * 60 * 1000);
    if (saved === undefined) delete process.env.MATCH_SYNC_INTERVAL_MINUTES;
    else process.env.MATCH_SYNC_INTERVAL_MINUTES = saved;
  });
});
