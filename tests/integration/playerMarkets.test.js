// Player Performance markets (player_runs / player_h2h): tab, labels, Back+Lay, settle, void.
const crypto = require('crypto');
const { pool } = require('../../db');
const { buildMarketView, filterMarketView } = require('../../services/marketLayout');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const u = await pool.query('UPDATE users SET coins=$1 WHERE username=$2 RETURNING id', [coins, username]);
  return { agent, token, userId: u.rows[0].id };
}
const post = (u, path, body) => u.agent.post(path).set('X-CSRF-Token', u.token).type('form').send(body);
const net = async (id) => Number((await pool.query('SELECT COALESCE(SUM(amount),0) n FROM coin_transactions WHERE user_id=$1 AND ref_bet_id IS NOT NULL', [id])).rows[0].n);

const KEY = crypto.randomBytes(32).toString('hex');
beforeAll(() => { process.env.FEED_API_KEY = KEY; });
afterAll(async () => {
  delete process.env.FEED_API_KEY;
  await pool.query("UPDATE matches SET status = 'finished' WHERE provider = 'player_test'"); // bets reference them (FK) — just take them off the live lists
});

const RUN = crypto.randomBytes(4).toString('hex'); // the test DB persists between runs: never reuse an external_id
const feedBody = (ext) => ({ provider: 'player_test', matches: [{
  external_id: ext, sport: 'cricket', team_a: 'PmA' + RUN, team_b: 'PmB' + RUN, status: 'live',
  markets: [
    { key: 'kohli_runs', type: 'player_runs', name: 'Virat Kohli Runs 35.5', status: 'open',
      runners: [{ key: 'over', name: 'Over', back: 1.9, lay: 1.95 }, { key: 'under', name: 'Under', back: 1.9, lay: 1.95 }] },
    { key: 'h2h', type: 'player_h2h', name: 'Kohli vs Smith – top runs', status: 'open',
      runners: [{ key: 'kohli', name: 'Virat Kohli', back: 1.8, lay: 1.85 }, { key: 'smith', name: 'Steve Smith', back: 2.0, lay: 2.05 }] }
  ] }] });

describe('layout', () => {
  test('player markets get the player category, a Player Performance tab and real player names', () => {
    const v = buildMarketView([{ id: 1, type: 'player_h2h', name: 'H2H', status: 'open', odds: { kohli: 1.8, smith: 2.0 },
      depth: { kohli: { name: 'Virat Kohli', back: 1.8, lay: 1.85 }, smith: { name: 'Steve Smith', back: 2, lay: 2.05 } } }],
    { sport: 'cricket', teams: ['India', 'Australia'] });
    expect(v.markets[0].category).toBe('player');
    expect(v.markets[0].runners.map((r) => r.label)).toEqual(['Virat Kohli', 'Steve Smith']);
    expect(v.tabs.map((t) => t.id)).toContain('player');
    expect(filterMarketView(v, 'player')).toHaveLength(1);
  });
  test('no player data => the cricket tab exists but is empty (no fake players)', () => {
    const v = buildMarketView([], { sport: 'cricket', teams: ['A', 'B'] });
    expect(filterMarketView(v, 'player')).toHaveLength(0);
  });
});

describe('end to end', () => {
  test('feed -> Back and Lay on player markets -> settle -> payouts; void refunds', async () => {
    const { agent } = await getCsrfAgent('/login');
    const fr = await agent.post('/api/admin/feed-update').set('x-feed-key', KEY).send(feedBody('pm-' + RUN));
    expect(fr.status).toBe(200);
    const m = (await pool.query(`SELECT id FROM matches WHERE provider='player_test' AND external_id=$1`, ['pm-' + RUN])).rows[0];
    const mks = (await pool.query('SELECT id, type FROM markets WHERE match_id=$1', [m.id])).rows;
    const runs = mks.find((x) => x.type === 'player_runs').id;
    const h2h = mks.find((x) => x.type === 'player_h2h').id;

    const backer = await makeUser(1000);
    const layer = await makeUser(1000);
    const admin = await makeUser(0);
    await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.userId]);

    expect((await post(backer, `/matches/${m.id}/bet`, { market_id: h2h, runner: 'kohli', side: 'back', stake: '100' })).body).toMatchObject({ success: true });
    expect((await post(layer, `/matches/${m.id}/bet`, { market_id: h2h, runner: 'kohli', side: 'lay', stake: '100' })).body).toMatchObject({ success: true });
    expect((await post(backer, `/matches/${m.id}/bet`, { market_id: runs, runner: 'over', side: 'back', stake: '100' })).body).toMatchObject({ success: true });

    const page = await backer.agent.get(`/matches/${m.id}`);
    expect(page.text).toContain('Virat Kohli');
    expect(page.text).toContain('data-tab="player"');

    await post(admin, `/admin/markets/${h2h}/settle`, { winning_runner: 'smith' }); // Kohli lost
    expect(await net(layer.userId)).toBe(100);          // lay wins the 100 stake: -85 + 185
    await post(admin, `/admin/markets/${runs}/void`, {}); // player did not bat -> void
    // backer: h2h back lost (-100) + runs bet voided (-100 + 100) = -100
    expect(await net(backer.userId)).toBe(-100);
  });
});
