// tests/integration/betSafety.test.js
// Audit fixes: bet contract, match-status gate, idempotency, row locks, void/refund, winning_runner
// validation, My Bets contract, feed cannot revive a cancelled match, env validators.
const crypto = require('crypto');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { validatePort, validateFeedKey } = require('../../services/envValidator');
const { settleMarketBets, voidMarketBets, isValidWinningRunner } = require('../../services/settlement');

const DEPTH = {
  A: { name: 'Alpha', back: 2.0, lay: 2.5 },
  B: { name: 'Beta', back: 3.0, lay: 3.4 }
};

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const u = await pool.query('UPDATE users SET coins = $1 WHERE username = $2 RETURNING id', [coins, username]);
  return { agent, token, userId: u.rows[0].id, username };
}
async function makeAdmin() {
  const a = await makeUser(0);
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [a.userId]);
  return a;
}
async function makeMarket({ matchStatus = 'live', marketStatus = 'open' } = {}) {
  const m = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status) VALUES ('Safety','Alpha','Beta','cricket',$1) RETURNING id`, [matchStatus]);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,$4) RETURNING id`,
    [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH), marketStatus]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
afterAll(async () => { await pool.query("UPDATE matches SET status = 'finished' WHERE title = 'Safety'"); });
const post = (u, path, body, headers = {}) => {
  let r = u.agent.post(path).set('X-CSRF-Token', u.token);
  Object.entries(headers).forEach(([k, v]) => { r = r.set(k, v); });
  return r.type('form').send(body);
};
const bet = (u, matchId, body, headers) => post(u, `/matches/${matchId}/bet`, body, headers);
const coins = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
// Wallet side effects unrelated to the bet (cashback, missions, loyalty…) run fire-and-forget after a
// bet, so exact wallet totals are noisy. The bet-linked ledger rows are the precise, auditable record.
const betNet = async (id) => Number((await pool.query(
  'SELECT COALESCE(SUM(amount),0) AS n FROM coin_transactions WHERE user_id=$1 AND ref_bet_id IS NOT NULL', [id])).rows[0].n);
const betCount = async (id) => (await pool.query('SELECT 1 FROM bets WHERE user_id=$1', [id])).rowCount;

describe('bet contract (side / bet_type) and validation', () => {
  test('side=lay is a real Lay bet and never silently becomes Back', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const r = await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100' });
    expect(r.status).toBe(200);
    const row = (await pool.query('SELECT bet_type, side, liability FROM bets WHERE user_id=$1', [u.userId])).rows[0];
    expect(row.bet_type).toBe('lay');
    expect(row.side).toBe('lay');
    expect(Number(row.liability)).toBe(150);
    expect(await betNet(u.userId)).toBe(-150);
  });

  test('bet_type=lay works the same; conflicting side/bet_type and unknown values are rejected without charging', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    expect((await bet(u, matchId, { market_id: marketId, runner: 'A', bet_type: 'lay', stake: '100' })).status).toBe(200);
    const clash = await bet(u, matchId, { market_id: marketId, runner: 'A', bet_type: 'back', side: 'lay', stake: '100' });
    expect(clash.status).toBe(400);
    const bad = await bet(u, matchId, { market_id: marketId, runner: 'A', bet_type: 'sideways', stake: '100' });
    expect(bad.status).toBe(400);
    expect(await betCount(u.userId)).toBe(1);
    expect(await betNet(u.userId)).toBe(-150);
  });

  test('a non-numeric match id returns 400, not 500', async () => {
    const u = await makeUser(1000);
    const r = await bet(u, 'abc', { market_id: 1, runner: 'A', stake: '100' });
    expect(r.status).toBe(400);
  });

  test('a market belonging to another match is rejected', async () => {
    const u = await makeUser(1000);
    const a = await makeMarket();
    const b = await makeMarket();
    const r = await bet(u, a.matchId, { market_id: b.marketId, runner: 'A', stake: '100' });
    expect(r.status).toBe(400);
    expect(await betCount(u.userId)).toBe(0);
  });

  test('fractional stake is rejected (no silent truncation)', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const r = await bet(u, matchId, { market_id: marketId, runner: 'A', stake: '100.9' });
    expect(r.status).toBe(400);
    expect(await coins(u.userId)).toBe(1000);
  });
});

describe('match status gate', () => {
  test.each(['finished', 'cancelled', 'Finished', 'completed'])('match "%s" does not accept bets even if its market is open', async (status) => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket({ matchStatus: status });
    const r = await bet(u, matchId, { market_id: marketId, runner: 'A', stake: '100' });
    expect(r.status).toBe(409);
    expect(await betCount(u.userId)).toBe(0);
    expect(await coins(u.userId)).toBe(1000);
  });

  test('an unknown match id returns 404', async () => {
    const u = await makeUser(1000);
    const r = await bet(u, 999999999, { market_id: 1, runner: 'A', stake: '100' });
    expect(r.status).toBe(404);
  });
});

describe('idempotent placement', () => {
  test('same Idempotency-Key twice = one bet, one charge', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const key = crypto.randomBytes(12).toString('hex');
    const body = { market_id: marketId, runner: 'A', stake: '100' };
    const r1 = await bet(u, matchId, body, { 'Idempotency-Key': key });
    const r2 = await bet(u, matchId, body, { 'Idempotency-Key': key });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);
    expect(await betCount(u.userId)).toBe(1);
    expect(await betNet(u.userId)).toBe(-100); // charged once
  });

  test('parallel requests with the same key still produce one bet', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const key = crypto.randomBytes(12).toString('hex');
    const body = { market_id: marketId, runner: 'A', stake: '100' };
    const rs = await Promise.all([1, 2, 3].map(() => bet(u, matchId, body, { 'Idempotency-Key': key })));
    expect(rs.some((r) => r.status === 200)).toBe(true);
    expect(await betCount(u.userId)).toBe(1);
    expect(await betNet(u.userId)).toBe(-100);
  });

  test('different keys are different bets; a malformed key is rejected', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const body = { market_id: marketId, runner: 'A', stake: '100' };
    expect((await bet(u, matchId, body, { 'Idempotency-Key': 'aaaaaaaaaaaa1' })).status).toBe(200);
    expect((await bet(u, matchId, body, { 'Idempotency-Key': 'bbbbbbbbbbbb2' })).status).toBe(200);
    expect((await bet(u, matchId, body, { 'Idempotency-Key': 'bad key!' })).status).toBe(400);
    expect(await betCount(u.userId)).toBe(2);
  });
});

describe('suspension race (row locks)', () => {
  test('a bet that waits behind a suspend sees the suspended market and is refused, balance untouched', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM markets WHERE id=$1 FOR UPDATE', [marketId]);
      await holder.query(`UPDATE markets SET status='suspended' WHERE id=$1`, [marketId]);
      const pending = bet(u, matchId, { market_id: marketId, runner: 'A', stake: '100' }).then((r) => r);
      await new Promise((r) => setTimeout(r, 400)); // the bet is now blocked on FOR SHARE
      await holder.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(400);
    } finally { holder.release(); }
    expect(await betCount(u.userId)).toBe(0);
    expect(await coins(u.userId)).toBe(1000);
  });
});

describe('My Bets API', () => {
  test('returns bet type, liability and the authoritative potential return; only own bets', async () => {
    const u = await makeUser(1000);
    const other = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100' });
    await bet(u, matchId, { market_id: marketId, runner: 'B', side: 'back', stake: '100' });
    await bet(other, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });

    const res = await u.agent.get('/matches/api/my-bets');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.bets).toHaveLength(2);
    const lay = res.body.bets.find((b) => b.betType === 'lay');
    const back = res.body.bets.find((b) => b.betType === 'back');
    expect(lay).toMatchObject({ selection: 'A', odd: 2.5, stake: 100, liability: 150, potentialReturn: 250, status: 'pending' });
    expect(back).toMatchObject({ selection: 'B', odd: 3, stake: 100, liability: 0, potentialReturn: 300, status: 'pending' });
  });

  test('requires login, ignores a user_id parameter, and paginates', async () => {
    const anon = await getCsrfAgent('/login');
    const noAuth = await anon.agent.get('/matches/api/my-bets').set('Accept', 'application/json');
    expect(noAuth.body && noAuth.body.bets).toBeUndefined();

    const u = await makeUser(5000);
    const other = await makeUser(5000);
    const { matchId, marketId } = await makeMarket();
    for (let i = 0; i < 3; i++) await bet(u, matchId, { market_id: marketId, runner: 'A', stake: '100' });
    await bet(other, matchId, { market_id: marketId, runner: 'A', stake: '100' });
    const page1 = await u.agent.get(`/matches/api/my-bets?limit=2&user_id=${other.userId}`);
    expect(page1.body.bets).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await u.agent.get(`/matches/api/my-bets?limit=2&before=${page1.body.nextBefore}`);
    expect(page2.body.bets).toHaveLength(1);
    expect(page2.body.hasMore).toBe(false);
  });
});

describe('settlement: winning_runner validation and double-settle protection', () => {
  const settle = (admin, marketId, winner) => post(admin, `/admin/markets/${marketId}/settle`, { winning_runner: winner });

  test('a typo as winning_runner is refused and every bet stays pending', async () => {
    const u = await makeUser(1000);
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    await settle(admin, marketId, 'Alpah');
    expect((await pool.query('SELECT status FROM bets WHERE user_id=$1', [u.userId])).rows[0].status).toBe('pending');
    expect((await pool.query('SELECT status FROM markets WHERE id=$1', [marketId])).rows[0].status).toBe('open');
  });

  test('settling twice pays once; ledger unique index and update-block trigger hold', async () => {
    const u = await makeUser(1000);
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    await settle(admin, marketId, 'A');
    await settle(admin, marketId, 'A');
    expect(await betNet(u.userId)).toBe(100); // -100 stake + 200 payout, paid once
    const led = await pool.query(`SELECT id, ref_bet_id, type FROM coin_transactions WHERE user_id=$1 AND type='bet_win'`, [u.userId]);
    expect(led.rowCount).toBe(1);
    await expect(pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description, ref_bet_id) VALUES ($1,1,'bet_win','dup',$2)`,
      [u.userId, led.rows[0].ref_bet_id])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`UPDATE coin_transactions SET amount = 999999 WHERE id=$1`, [led.rows[0].id]))
      .rejects.toThrow(/immutable/);
  });

  test('service level: re-running settlement on a settled market finds nothing pending', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const first = await settleMarketBets(c, marketId, 'B');
      const second = await settleMarketBets(c, marketId, 'B');
      await c.query('COMMIT');
      expect(first.total).toBe(1);
      expect(second.total).toBe(0);
    } finally { c.release(); }
    expect(await betNet(u.userId)).toBe(100); // -150 liability + (100 stake + 150 liability) back
  });

  test('isValidWinningRunner', () => {
    expect(isValidWinningRunner({ odds: { A: 2, B: 3 } }, 'A')).toBe(true);
    expect(isValidWinningRunner({ odds: { A: 2, B: 3 } }, 'C')).toBe(false);
    expect(isValidWinningRunner({ odds: {}, depth: null }, 'anything')).toBe(true);
  });
});

describe('void / cancel refunds', () => {
  test('voiding a market refunds Back stake and Lay liability exactly once', async () => {
    const backer = await makeUser(1000);
    const layer = await makeUser(1000);
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    await bet(backer, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    await bet(layer, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100' });
    expect(await betNet(backer.userId)).toBe(-100);
    expect(await betNet(layer.userId)).toBe(-150);

    const r1 = await post(admin, `/admin/markets/${marketId}/void`, {});
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ success: true, voided: 2, refunded: 250 });
    expect(await betNet(backer.userId)).toBe(0); // fully refunded
    expect(await betNet(layer.userId)).toBe(0);

    const r2 = await post(admin, `/admin/markets/${marketId}/void`, {});
    expect([200, 409]).toContain(r2.status);
    expect(r2.body.voided || 0).toBe(0);
    expect(await betNet(backer.userId)).toBe(0); // second void refunds nothing
    expect(await betNet(layer.userId)).toBe(0);

    const st = await pool.query('SELECT status FROM bets WHERE user_id = ANY($1)', [[backer.userId, layer.userId]]);
    expect(st.rows.every((r) => r.status === 'void')).toBe(true);
    const led = await pool.query(`SELECT type, amount FROM coin_transactions WHERE user_id=$1 AND type IN ('bet_void','lay_void')`, [layer.userId]);
    expect(led.rows.map((r) => [r.type, Number(r.amount)])).toEqual([['lay_void', 150]]);
  });

  test('a settled market cannot be voided; a voided market cannot be settled', async () => {
    const u = await makeUser(1000);
    const admin = await makeAdmin();
    const a = await makeMarket();
    await bet(u, a.matchId, { market_id: a.marketId, runner: 'A', side: 'back', stake: '100' });
    await post(admin, `/admin/markets/${a.marketId}/settle`, { winning_runner: 'A' });
    const v = await post(admin, `/admin/markets/${a.marketId}/void`, {});
    expect(v.status).toBe(409);
    expect(await betNet(u.userId)).toBe(100);

    const b = await makeMarket();
    await bet(u, b.matchId, { market_id: b.marketId, runner: 'A', side: 'back', stake: '100' });
    await post(admin, `/admin/markets/${b.marketId}/void`, {});
    await post(admin, `/admin/markets/${b.marketId}/settle`, { winning_runner: 'A' });
    expect(await betNet(u.userId)).toBe(100 + 0); // market A: +100 net; market B: -100 then +100 refund = 0, settle refused
  });

  test('cancelling a match refunds all pending bets, blocks new bets, and a repeat refunds nothing', async () => {
    const backer = await makeUser(1000);
    const layer = await makeUser(1000);
    const late = await makeUser(1000);
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    await bet(backer, matchId, { market_id: marketId, runner: 'B', side: 'back', stake: '200' });
    await bet(layer, matchId, { market_id: marketId, runner: 'B', side: 'lay', stake: '100' }); // liability 240

    const r1 = await post(admin, `/admin/matches/${matchId}/cancel`, {});
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ success: true, voided: 2, refunded: 440 });
    expect(await betNet(backer.userId)).toBe(0);
    expect(await betNet(layer.userId)).toBe(0);
    expect((await pool.query('SELECT status FROM matches WHERE id=$1', [matchId])).rows[0].status).toBe('cancelled');

    const r2 = await post(admin, `/admin/matches/${matchId}/cancel`, {});
    expect(r2.body.refunded || 0).toBe(0);
    expect(await betNet(backer.userId)).toBe(0);

    const blocked = await bet(late, matchId, { market_id: marketId, runner: 'A', stake: '100' });
    expect([400, 409]).toContain(blocked.status);
    expect(await coins(late.userId)).toBe(1000);
  });

  test('service level: voidMarketBets is idempotent', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '50' }); // liability 75
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await voidMarketBets(c, marketId, 'test');
      const b = await voidMarketBets(c, marketId, 'test');
      await c.query('COMMIT');
      expect(a).toMatchObject({ total: 1, refunded: 75 });
      expect(b).toMatchObject({ total: 0, refunded: 0 });
    } finally { c.release(); }
    expect(await betNet(u.userId)).toBe(0);
  });

  test('a normal user cannot void, cancel or settle', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const calls = [
      post(u, `/admin/markets/${marketId}/void`, {}),
      post(u, `/admin/matches/${matchId}/cancel`, {}),
      post(u, `/admin/markets/${marketId}/settle`, { winning_runner: 'A' })
    ];
    for (const r of await Promise.all(calls)) expect(r.status).not.toBe(200);
    expect((await pool.query('SELECT status FROM markets WHERE id=$1', [marketId])).rows[0].status).toBe('open');
  });
});

describe('wallet vs ledger consistency', () => {
  test('after place + settle + void the wallet equals the opening balance plus every ledger row', async () => {
    const u = await makeUser(1000);
    const admin = await makeAdmin();
    const a = await makeMarket();
    const b = await makeMarket();
    await bet(u, a.matchId, { market_id: a.marketId, runner: 'A', side: 'lay', stake: '100' });
    await bet(u, b.matchId, { market_id: b.marketId, runner: 'B', side: 'back', stake: '100' });
    await post(admin, `/admin/markets/${a.marketId}/settle`, { winning_runner: 'B' }); // lay wins
    await post(admin, `/admin/markets/${b.marketId}/void`, {});                       // back refunded
    await new Promise((r) => setTimeout(r, 1200)); // let the fire-and-forget reward hooks finish
    const ledger = Number((await pool.query('SELECT COALESCE(SUM(amount),0) AS n FROM coin_transactions WHERE user_id=$1', [u.userId])).rows[0].n);
    const wallet = await coins(u.userId);
    const bonusRows = Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS n FROM coin_transactions WHERE user_id=$1 AND ref_bet_id IS NULL`, [u.userId])).rows[0].n);
    // every coin movement must be explained by a ledger row (bet-linked or a logged bonus)
    expect(wallet).toBe(1000 + ledger);
    expect(await betNet(u.userId)).toBe(100); // lay win: -150 + 250, back void: -100 + 100
    expect(bonusRows).toBeGreaterThanOrEqual(0);
  });
});

describe('feed ingest', () => {
  const RUN = crypto.randomBytes(4).toString('hex'); // the test DB persists between runs
  const EXT = 'sf-' + RUN;
  const KEY = crypto.randomBytes(32).toString('hex');
  const feed = (agent, body, key = KEY) => agent.post('/api/admin/feed-update').set('x-feed-key', key).send(body);
  const payload = (status) => ({ provider: 'safety_test', matches: [{
    external_id: EXT, sport: 'cricket', team_a: 'A', team_b: 'B', status,
    markets: [{ key: 'mo', type: 'bookmaker', name: 'Match Odds', status: 'open', runners: [{ key: 'A', name: 'A', back: 1.9, lay: 1.95 }] }]
  }] });

  beforeAll(() => { process.env.FEED_API_KEY = KEY; });
  afterAll(async () => {
    delete process.env.FEED_API_KEY;
    await pool.query("UPDATE matches SET status = 'finished' WHERE provider = 'safety_test'");
  });

  test('wrong key is 401, correct key is 200', async () => {
    const { agent } = await getCsrfAgent('/login');
    expect((await feed(agent, payload('live'), 'x'.repeat(40))).status).toBe(401);
    expect((await feed(agent, payload('live'))).status).toBe(200);
  });

  test('a feed update cannot revive a cancelled match', async () => {
    const { agent } = await getCsrfAgent('/login');
    await feed(agent, payload('live'));
    const id = (await pool.query(`SELECT id FROM matches WHERE provider='safety_test' AND external_id=$1`, [EXT])).rows[0].id;
    await pool.query(`UPDATE matches SET status='cancelled' WHERE id=$1`, [id]);
    await feed(agent, payload('live'));
    expect((await pool.query('SELECT status FROM matches WHERE id=$1', [id])).rows[0].status).toBe('cancelled');
  });
});

describe('env validators', () => {
  test('PORT', () => {
    expect(validatePort(undefined).valid).toBe(true);
    expect(validatePort('3000').valid).toBe(true);
    ['0', '70000', 'abc', '80.5', '-1'].forEach((p) => expect(validatePort(p).valid).toBe(false));
  });
  test('FEED_API_KEY strength; messages never echo the value', () => {
    expect(validateFeedKey(undefined).valid).toBe(true); // unset = endpoint disabled (503)
    ['123', 'short', 'a'.repeat(40)].forEach((k) => {
      const r = validateFeedKey(k);
      expect(r.valid).toBe(false);
      expect(JSON.stringify(r)).not.toContain(k);
    });
    expect(validateFeedKey(crypto.randomBytes(32).toString('hex')).valid).toBe(true);
  });
});

describe('admin UI exposes void / cancel', () => {
  test('markets and matches pages render the Void and Cancel forms for an open market/live match', async () => {
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    const mk = await admin.agent.get(`/admin/markets/${matchId}`);
    expect(mk.status).toBe(200);
    expect(mk.text).toContain(`/admin/markets/${marketId}/void`);
    const list = await admin.agent.get('/admin/matches');
    expect(list.status).toBe(200);
    expect(list.text).toContain(`/admin/matches/${matchId}/cancel`);
  });

  test('a browser form post (Accept: text/html) is redirected with a flash, not answered with raw JSON', async () => {
    const u = await makeUser(1000);
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    const r = await admin.agent.post(`/admin/markets/${marketId}/void`).set('X-CSRF-Token', admin.token)
      .set('Accept', 'text/html').type('form').send({}).redirects(0);
    expect(r.status).toBe(302);
    expect(await betNet(u.userId)).toBe(0);
  });
});
