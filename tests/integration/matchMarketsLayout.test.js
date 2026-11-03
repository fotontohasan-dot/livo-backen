// tests/integration/matchMarketsLayout.test.js
// ম্যাচ পেজে একাধিক মার্কেট: তৈরি (idempotent), দেখানো আর বাজির অডস একই, এবং
// অ্যাডমিন সেটেল ফর্মের ফিল্ডের নাম সার্ভারের সাথে মেলে।
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { pool } = require('../../db');
const { ensureDefaultMarkets } = require('../../services/autoMarkets');
const { buildMarketView } = require('../../services/marketLayout');
const { resolveOdd } = require('../../services/oddsResolver');

let app;
beforeAll(() => { app = require('../../app'); });

async function makeMatch(over) {
  const m = Object.assign({ title: 'Layout Test', team_a: 'Alpha', team_b: 'Beta', sport: 'cricket', status: 'live', league: '1st Test' }, over);
  const r = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status, league) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [m.title, m.team_a, m.team_b, m.sport, m.status, m.league]
  );
  return r.rows[0].id;
}
const marketsOf = (id) => pool.query('SELECT * FROM markets WHERE match_id=$1 ORDER BY id', [id]).then((r) => r.rows);

describe('ডিফল্ট মার্কেট তৈরি', () => {
  test('ক্রিকেটে Match Winner ছাড়াও Over/Under, Odd/Even, Yes/No তৈরি হয়; দ্বিতীয়বার চালালে ডুপ্লিকেট হয় না', async () => {
    const id = await makeMatch();
    expect(await ensureDefaultMarkets(id, 'live')).toBe(true);
    const first = await marketsOf(id);
    const types = new Set(first.map((m) => m.type));
    expect(first.length).toBeGreaterThan(4);
    ['bookmaker', 'over_under', 'odd_even', 'yes_no'].forEach((t) => expect(types.has(t)).toBe(true));
    expect(first.filter((m) => m.name === 'Match Winner')).toHaveLength(1);

    expect(await ensureDefaultMarkets(id, 'live')).toBe(false);
    expect(await marketsOf(id)).toHaveLength(first.length);
  });

  test('অ্যাডমিনের বদলানো অডস রিসেট হয় না', async () => {
    const id = await makeMatch();
    await ensureDefaultMarkets(id, 'live');
    const ou = (await marketsOf(id)).find((m) => m.type === 'over_under');
    await pool.query(`UPDATE markets SET odds = '{"over":2.5,"under":1.5}'::jsonb WHERE id=$1`, [ou.id]);
    await ensureDefaultMarkets(id, 'live');
    const after = (await marketsOf(id)).find((m) => m.id === ou.id);
    expect(after.odds.over).toBe(2.5);
  });

  test('শেষ হওয়া ম্যাচে কিছু তৈরি হয় না', async () => {
    const id = await makeMatch({ status: 'finished' });
    expect(await ensureDefaultMarkets(id, 'finished')).toBe(false);
    expect(await marketsOf(id)).toHaveLength(0);
  });

  test('ফুটবলে 1X2, Double Chance, Total Goals, BTTS', async () => {
    const id = await makeMatch({ sport: 'football', league: 'Premier League' });
    await ensureDefaultMarkets(id, 'live');
    const names = (await marketsOf(id)).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining([
      'Match Winner', 'Match Result (1X2)', 'Double Chance', 'Total Goals Over/Under 2.5', 'Both Teams To Score — Yes/No'
    ]));
  });
});

describe('দেখানো অডস = সার্ভারের অডস', () => {
  test('প্রতিটা মার্কেটের প্রতিটা রানারের দেখানো অডস resolveOdd()-এর সমান', async () => {
    for (const sport of ['cricket', 'football']) {
      const id = await makeMatch({ sport });
      await ensureDefaultMarkets(id, 'live');
      const rows = await marketsOf(id);
      const view = buildMarketView(rows, { sport, teams: ['Alpha', 'Beta'] });
      expect(view.markets.length).toBe(rows.length);
      for (const vm of view.markets) {
        const row = rows.find((r) => r.id === vm.id);
        for (const r of vm.runners) {
          expect(resolveOdd(row, r.key)).toBe(r.odd);
        }
        expect(resolveOdd(row, 'no-such-runner')).toBeNull();
      }
    }
  });
});

describe('ম্যাচ পেজ', () => {
  test('ট্যাব, ভাঁজযোগ্য কার্ড ও বেট স্লিপ রেন্ডার হয়; ব্রাউজারের prompt/confirm নেই', async () => {
    const id = await makeMatch();
    await ensureDefaultMarkets(id, 'live');
    const res = await request(app).get(`/matches/${id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('md-tabs');
    expect(res.text).toContain('data-tab="innings"');
    expect(res.text).toContain('Alpha Total Runs Over/Under');
    expect(res.text).toContain('id="bsOverlay"');
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/views/match-detail.js'), 'utf8');
    expect(js).not.toMatch(/\b(prompt|confirm|alert)\(/);
  });
});

describe('অ্যাডমিন সেটেল ফর্ম', () => {
  test('ফিল্ডের নাম winning_runner (সার্ভার যা পড়ে), result নয়', () => {
    const view = fs.readFileSync(path.join(__dirname, '../../views/admin/markets.ejs'), 'utf8');
    const route = fs.readFileSync(path.join(__dirname, '../../routes/admin.js'), 'utf8');
    expect(route).toMatch(/const \{ winning_runner \} = req\.body/);
    expect(view).toContain('name="winning_runner"');
    expect(view).not.toContain('name="result"');
  });
});
