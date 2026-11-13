// ==================== placeAccumulator: শেষ/বাতিল ম্যাচের লেগ প্রত্যাখ্যান (একক বাজির মতো) ====================
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const accumulator = require('../../services/accumulator');

const DEPTH = { A: { name: 'Alpha', back: 2.0, lay: 2.5 }, B: { name: 'Beta', back: 3.0, lay: 3.4 } };

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const u = await pool.query('UPDATE users SET coins = $1 WHERE username = $2 RETURNING id', [coins, username]);
  return u.rows[0].id;
}

// provider = null: হাতে তৈরি ম্যাচ, তাই stale নিয়ম প্রযোজ্য নয় — শুধু status নিয়ম পরীক্ষা হয়
async function makeMarket(status) {
  const m = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status, provider, synced_at)
     VALUES ('AccaStatusTest','Alpha','Beta','cricket',$1,NULL,NULL) RETURNING id`, [status]);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,'open') RETURNING id`,
    [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH)]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}

afterAll(async () => { await pool.query("UPDATE matches SET status = 'finished' WHERE title = 'AccaStatusTest'"); });

describe('placeAccumulator — ম্যাচ স্ট্যাটাস', () => {
  test.each(['finished', 'cancelled'])('%s ম্যাচের লেগ থাকলে পুরো acca প্রত্যাখ্যাত (MATCH_CLOSED), কয়েন অক্ষত', async (status) => {
    const userId = await makeUser(5000);
    const open = await makeMarket('live');
    const closed = await makeMarket(status);
    const r = await accumulator.placeAccumulator(userId, 100, [
      { match_id: open.matchId, market_id: open.marketId, runner: 'A' },
      { match_id: closed.matchId, market_id: closed.marketId, runner: 'A' }
    ], 'en');
    expect(r.success).toBe(false);
    expect(r.code).toBe('MATCH_CLOSED');
    const c = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    expect(Number(c.rows[0].coins)).toBe(5000);
    expect((await pool.query('SELECT 1 FROM accumulators WHERE user_id = $1', [userId])).rowCount).toBe(0);
  });
});
