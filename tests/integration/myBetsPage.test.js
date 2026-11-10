// My Bets page + GET /matches/api/my-bets (tabs, counts, pagination, ownership) against the real DB,
// using the real bet-placement route and the real settlement service (no mocked money logic).
const request = require('supertest');
const { pool } = require('../../db');
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');
const { settleMarketBets, voidBet } = require('../../services/settlement');

const PASSWORD = 'Passw0rd!MyBets1';
const userIds = [];
let matchId, marketId;

async function player(coins = 1000) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: PASSWORD, confirmPassword: PASSWORD, _csrf: token });
  const u = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const id = u.rows[0].id;
  userIds.push(id);
  await pool.query('UPDATE users SET coins = $2 WHERE id = $1', [id, coins]);
  return { agent, token, id };
}
const place = (p, body, key) => {
  let r = p.agent.post(`/matches/${matchId}/bet`).set('User-Agent', REALISTIC_UA);
  if (key) r = r.set('Idempotency-Key', key);
  return r.type('form').send({ _csrf: p.token, ...body });
};
const myBets = (p, qs = '') => p.agent.get('/matches/api/my-bets' + qs);
const coinsOf = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id = $1', [id])).rows[0].coins);
async function insertBet(userId, status, extra = {}) {
  const r = await pool.query(
    `INSERT INTO bets (user_id, match_id, market_id, market_type, runner, odd, stake, status, bet_type, liability, potential_payout)
     VALUES ($1,$2,$3,'bookmaker','0',2.00,$4,$5,$6,$7,$8) RETURNING id`,
    [userId, matchId, marketId, extra.stake || 50, status, extra.betType || 'back', extra.liability || 0, extra.potential || 100]);
  return r.rows[0].id;
}

beforeAll(async () => {
  matchId = (await pool.query(
    `INSERT INTO matches (sport, team_a, team_b, title, league, status, start_time)
     VALUES ('cricket','Alpha','Beta','Alpha vs Beta','MyBets League','live', NOW() + interval '1 day') RETURNING id`)).rows[0].id;
  marketId = (await pool.query(
    `INSERT INTO markets (match_id, market_key, type, name, odds, depth, status, runner_status)
     VALUES ($1,'mw','bookmaker','Match Winner',$2,$3,'open','{}') RETURNING id`,
    [matchId, { 0: 2.0, 1: 3.0 }, { 0: { lay: 2.5 }, 1: { lay: 3.2 } }])).rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM coin_transactions WHERE ref_bet_id IN (SELECT id FROM bets WHERE match_id = $1)', [matchId]).catch(() => {});
  await pool.query('DELETE FROM bets WHERE match_id = $1', [matchId]).catch(() => {});
  await pool.query('DELETE FROM markets WHERE match_id = $1', [matchId]).catch(() => {});
  await pool.query('DELETE FROM matches WHERE id = $1', [matchId]).catch(() => {});
  await cleanupUsers(userIds);
});

describe('GET /my-bets (page)', () => {
  test('logged-out visitors never get the page', async () => {
    const res = await request(app).get('/my-bets').redirects(0);
    expect(res.status).not.toBe(200);
  });

  test('logged-in user gets the page shell with all five tabs and no inline script/handlers', async () => {
    const p = await player();
    const res = await p.agent.get('/my-bets');
    expect(res.status).toBe(200);
    for (const t of ['all', 'open', 'won', 'lost', 'void']) expect(res.text).toContain(`data-tab="${t}"`);
    expect(res.text).toContain('/js/views/my-bets.js');
    expect(res.text).not.toMatch(/\son(click|load|error)=/i);
  });
});

describe('placing a bet -> My Bets', () => {
  test('a placed bet appears with every ticket field; the wallet is charged exactly once', async () => {
    const p = await player(1000);
    const res = await place(p, { market_id: marketId, runner: '0', stake: 100, bet_type: 'back' }, 'mybets-key-0001');
    expect(res.body.success).toBe(true);

    const r = await myBets(p);
    expect(r.status).toBe(200);
    expect(r.body.bets).toHaveLength(1);
    const b = r.body.bets[0];
    expect(b).toMatchObject({
      matchName: 'Alpha vs Beta', teamA: 'Alpha', teamB: 'Beta', league: 'MyBets League', sport: 'cricket',
      market: 'Match Winner', betType: 'back', odd: 2, stake: 100, potentialReturn: 200,
      status: 'pending', statusGroup: 'open', payout: null, demo: false
    });
    expect(b.id).toBeGreaterThan(0);
    expect(b.selection).toBeTruthy();
    expect(new Date(b.startTime).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(b.createdAt).getTime()).not.toBeNaN();
    expect(r.body.counts).toEqual({ total: 1, open: 1, won: 0, lost: 0, void: 0 });

    const tx = await pool.query(`SELECT amount FROM coin_transactions WHERE ref_bet_id = $1 AND type = 'bet'`, [b.id]);
    expect(tx.rowCount).toBe(1);
    expect(Number(tx.rows[0].amount)).toBe(-100);
  });

  test('re-submitting the same idempotency key creates no second ticket and no second deduction', async () => {
    const p = await player(1000);
    const first = await place(p, { market_id: marketId, runner: '0', stake: 100, bet_type: 'back' }, 'mybets-dupe-0001');
    const again = await place(p, { market_id: marketId, runner: '0', stake: 100, bet_type: 'back' }, 'mybets-dupe-0001');
    expect(first.body.success).toBe(true);
    expect(again.body).toMatchObject({ success: true, duplicate: true, betId: expect.any(Number) });

    const rows = await pool.query('SELECT id FROM bets WHERE user_id = $1', [p.id]);
    expect(rows.rowCount).toBe(1);
    const tx = await pool.query(`SELECT COUNT(*)::int AS n FROM coin_transactions WHERE user_id = $1 AND type = 'bet'`, [p.id]);
    expect(tx.rows[0].n).toBe(1);
    expect((await myBets(p)).body.bets).toHaveLength(1);
  });

  test('a stake above the balance is rejected: no ticket, balance never negative', async () => {
    const p = await player(50);
    const res = await place(p, { market_id: marketId, runner: '0', stake: 100, bet_type: 'back' }, 'mybets-poor-0001');
    expect(res.body.success).toBe(false);
    expect(await coinsOf(p.id)).toBe(50);
    expect((await myBets(p)).body.bets).toHaveLength(0);
  });
});

describe('ownership', () => {
  test("a user never sees another user's tickets, in any tab or via the cursor", async () => {
    const a = await player();
    const b = await player();
    const aId = await insertBet(a.id, 'pending');
    const bId = await insertBet(b.id, 'won');
    for (const qs of ['', '?status=open', '?status=won', `?before=${bId + 1000}`]) {
      const ids = (await myBets(a, qs)).body.bets.map((x) => x.id);
      expect(ids).not.toContain(bId);
    }
    expect((await myBets(a)).body.bets.map((x) => x.id)).toEqual([aId]);
    expect((await myBets(b)).body.counts).toMatchObject({ total: 1, won: 1, open: 0 });
  });
});

describe('tabs and settlement', () => {
  test('won/lost/void/cancelled tickets land in the right tabs and the counts agree', async () => {
    const p = await player();
    const open = await insertBet(p.id, 'pending');
    const won = await insertBet(p.id, 'won', { stake: 50, potential: 100 });
    const lost = await insertBet(p.id, 'lost');
    const voided = await insertBet(p.id, 'void', { stake: 70 });
    const cancelled = await insertBet(p.id, 'cancelled', { stake: 30 });
    const ids = async (qs) => (await myBets(p, qs)).body.bets.map((x) => x.id).sort((x, y) => x - y);

    expect(await ids('')).toEqual([open, won, lost, voided, cancelled].sort((x, y) => x - y));
    expect(await ids('?status=open')).toEqual([open]);
    expect(await ids('?status=won')).toEqual([won]);
    expect(await ids('?status=lost')).toEqual([lost]);
    expect(await ids('?status=void')).toEqual([voided, cancelled].sort((x, y) => x - y));
    expect((await myBets(p)).body.counts).toEqual({ total: 5, open: 1, won: 1, lost: 1, void: 2 });

    const byId = Object.fromEntries((await myBets(p)).body.bets.map((x) => [x.id, x]));
    expect(byId[won]).toMatchObject({ statusGroup: 'won', payout: 100 });
    expect(byId[lost]).toMatchObject({ statusGroup: 'lost', payout: 0 });
    expect(byId[voided]).toMatchObject({ statusGroup: 'void', payout: 70 }); // Back void = stake refunded
  });

  test('an unknown status value falls back to all tickets (no error, no SQL injection surface)', async () => {
    const p = await player();
    await insertBet(p.id, 'pending');
    const r = await myBets(p, "?status=won'%20OR%201=1--");
    expect(r.status).toBe(200);
    expect(r.body.bets).toHaveLength(1);
  });

  test('a Lay void reports the liability (not the stake) as the refunded amount', async () => {
    const p = await player();
    const id = await insertBet(p.id, 'void', { betType: 'lay', stake: 100, liability: 150, potential: 250 });
    const b = (await myBets(p, '?status=void')).body.bets.find((x) => x.id === id);
    expect(b).toMatchObject({ betType: 'lay', liability: 150, payout: 150 });
  });

  test('the real settlement service moves a placed ticket from Open to Won/Lost and the page data follows', async () => {
    const m = (await pool.query(`INSERT INTO matches (sport, team_a, team_b, title, status) VALUES ('cricket','Gamma','Delta','Gamma vs Delta','live') RETURNING id`)).rows[0].id;
    const mk = (await pool.query(
      `INSERT INTO markets (match_id, market_key, type, name, odds, depth, status, runner_status)
       VALUES ($1,'mw','bookmaker','Match Winner',$2,$3,'open','{}') RETURNING id`,
      [m, { 0: 2.0, 1: 3.0 }, { 0: { lay: 2.5 }, 1: { lay: 3.2 } }])).rows[0].id;
    try {
      const p = await player(1000);
      const win = await p.agent.post(`/matches/${m}/bet`).set('User-Agent', REALISTIC_UA).type('form')
        .send({ _csrf: p.token, market_id: mk, runner: '0', stake: 100, bet_type: 'back' });
      const lose = await p.agent.post(`/matches/${m}/bet`).set('User-Agent', REALISTIC_UA).type('form')
        .send({ _csrf: p.token, market_id: mk, runner: '1', stake: 40, bet_type: 'back' });
      expect(win.body.success && lose.body.success).toBe(true);
      expect((await myBets(p, '?status=open')).body.bets).toHaveLength(2);

      const c = await pool.connect();
      try { await c.query('BEGIN'); await settleMarketBets(c, mk, '0'); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

      const after = await myBets(p);
      expect(after.body.counts).toMatchObject({ total: 2, open: 0, won: 1, lost: 1 });
      expect((await myBets(p, '?status=open')).body.bets).toHaveLength(0);
      const w = (await myBets(p, '?status=won')).body.bets[0];
      expect(w).toMatchObject({ stake: 100, status: 'won', payout: 200 });
      expect((await myBets(p, '?status=lost')).body.bets[0]).toMatchObject({ stake: 40, payout: 0 });
    } finally {
      await pool.query('DELETE FROM coin_transactions WHERE ref_bet_id IN (SELECT id FROM bets WHERE match_id = $1)', [m]).catch(() => {});
      await pool.query('DELETE FROM bets WHERE match_id = $1', [m]).catch(() => {});
      await pool.query('DELETE FROM markets WHERE match_id = $1', [m]).catch(() => {});
      await pool.query('DELETE FROM matches WHERE id = $1', [m]).catch(() => {});
    }
  });
});

describe('pagination', () => {
  test('cursor pages never overlap, hasMore/nextBefore are correct, counts only on the first page', async () => {
    const p = await player();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await insertBet(p.id, 'pending'));
    const p1 = (await myBets(p, '?limit=2')).body;
    expect(p1.bets).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.counts.total).toBe(5);
    const p2 = (await myBets(p, `?limit=2&before=${p1.nextBefore}`)).body;
    expect(p2.counts).toBeUndefined();
    const p3 = (await myBets(p, `?limit=2&before=${p2.nextBefore}`)).body;
    expect(p3.hasMore).toBe(false);
    const all = [...p1.bets, ...p2.bets, ...p3.bets].map((x) => x.id);
    expect(new Set(all).size).toBe(5);
    expect(all).toEqual([...made].sort((x, y) => y - x));
  });
});
