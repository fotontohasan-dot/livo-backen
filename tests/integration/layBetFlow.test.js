// End-to-end Back/Lay flow against the real database:
// migration objects, atomic wallet deduction, liability, settlement, ledger and My Bets.
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { settleMarketBets } = require('../../services/settlement');

const PASSWORD = 'Passw0rd!Lay1';
let agent, token, userId, matchId, marketId, h2hId;
let offset = 0; // coins - ledger sum, re-based whenever the test writes the balance directly
async function ledgerSum() { return Number((await pool.query('SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id=$1', [userId])).rows[0].s); }

async function coins() { return Number((await pool.query('SELECT coins FROM users WHERE id=$1', [userId])).rows[0].coins); }
async function bet(body) {
  return agent.post(`/matches/${matchId}/bet`).set('User-Agent', REALISTIC_UA).type('form').send({ _csrf: token, ...body });
}
async function settle(mid, winner) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await settleMarketBets(c, mid, winner);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

beforeAll(async () => {
  const g = await getCsrfAgent('/register');
  agent = g.agent; token = g.token;
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: PASSWORD, confirmPassword: PASSWORD, _csrf: token
  });
  const u = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  userId = u.rows[0].id;
  await pool.query('UPDATE users SET coins = 1000 WHERE id=$1', [userId]);

  matchId = (await pool.query(
    `INSERT INTO matches (sport, team_a, team_b, title, league, status) VALUES ('cricket','Alpha','Beta','Alpha vs Beta','Test League','live') RETURNING id`)).rows[0].id;
  marketId = (await pool.query(
    `INSERT INTO markets (match_id, market_key, type, name, odds, depth, status, runner_status)
     VALUES ($1,'mw','bookmaker','Match Winner',$2,$3,'open','{}') RETURNING id`,
    [matchId, { 0: 2.0, 1: 3.0 }, { 0: { lay: 2.5, back_size: 900, lay_size: 400 }, 1: { lay: 3.2 } }])).rows[0].id;
  h2hId = (await pool.query(
    `INSERT INTO markets (match_id, market_key, type, name, odds, depth, status)
     VALUES ($1,'h2h','player_h2h','Head to Head: Kohli vs Rohit',$2,$3,'open') RETURNING id`,
    [matchId, { 0: 1.8, 1: 2.0 }, { 0: { name: 'V Kohli', lay: 1.9 }, 1: { name: 'R Sharma', lay: 2.1 } }])).rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM bets WHERE user_id=$1', [userId]).catch(() => {});
  await pool.query('DELETE FROM matches WHERE id=$1', [matchId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
});

describe('migration objects', () => {
  test('bets has bet_type/liability/potential_payout and rejects an invalid bet_type', async () => {
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='bets'`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['bet_type', 'liability', 'potential_payout']));
    await expect(pool.query(
      `INSERT INTO bets (user_id, match_id, market_id, runner, odd, stake, status, bet_type) VALUES ($1,$2,$3,'0',2,10,'pending','exchange')`,
      [userId, matchId, marketId])).rejects.toThrow(/bets_bet_type_check|too long/);
  });
  test('ledger unique index and immutability trigger exist', async () => {
    const idx = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname='uq_coin_tx_bet_ref'`);
    const trg = await pool.query(`SELECT 1 FROM pg_trigger WHERE tgname='trg_coin_tx_block_update'`);
    expect(idx.rowCount).toBe(1);
    expect(trg.rowCount).toBe(1);
  });
});

describe('placing bets', () => {
  test('BACK bet deducts the stake only', async () => {
    const res = await bet({ market_id: marketId, runner: '0', stake: 100, bet_type: 'back' });
    expect(res.body.success).toBe(true);
    const b = (await pool.query(`SELECT * FROM bets WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [userId])).rows[0];
    expect(b).toMatchObject({ bet_type: 'back', liability: 0, potential_payout: 200 });
    // ledger row is the exact, race-free record (other hooks such as the first-bet badge credit coins asynchronously)
    const tx = (await pool.query(`SELECT amount FROM coin_transactions WHERE ref_bet_id=$1 AND type='bet'`, [b.id])).rows[0];
    expect(Number(tx.amount)).toBe(-100);
  });

  test('LAY bet deducts the LIABILITY (stake x (lay odd - 1)), not the stake', async () => {
    const res = await bet({ market_id: marketId, runner: '0', stake: 100, bet_type: 'lay' }); // lay odd 2.5 -> liability 150
    expect(res.body).toMatchObject({ success: true, betType: 'lay', liability: 150, potentialPayout: 250 });
    const b = (await pool.query(`SELECT * FROM bets WHERE user_id=$1 AND bet_type='lay' ORDER BY id DESC LIMIT 1`, [userId])).rows[0];
    expect(Number(b.odd)).toBe(2.5);
    const tx = (await pool.query(`SELECT * FROM coin_transactions WHERE ref_bet_id=$1 AND type='lay_bet'`, [b.id])).rows[0];
    expect(Number(tx.amount)).toBe(-150);
  });

  test('LAY is rejected when balance covers the stake but NOT the liability', async () => {
    await pool.query('UPDATE users SET coins = 120 WHERE id=$1', [userId]);
    const res = await bet({ market_id: marketId, runner: '1', stake: 100, bet_type: 'lay' }); // liability 220 > 120
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
    expect(await coins()).toBe(120); // untouched
    await new Promise((r) => setTimeout(r, 300));
    await pool.query('UPDATE users SET coins = 1000 WHERE id=$1', [userId]);
    offset = 1000 - (await ledgerSum()); // re-base: everything after this point must be fully ledgered
  });

  test('client-supplied odds are ignored; lay without a feed lay price is rejected', async () => {
    await pool.query(`UPDATE markets SET depth='{}'::jsonb WHERE id=$1 AND false`, [marketId]);
    const noLay = await pool.query(
      `INSERT INTO markets (match_id, market_key, type, name, odds, depth, status) VALUES ($1,'nolay','bookmaker','No Lay',$2,'{}','open') RETURNING id`,
      [matchId, { 0: 2.0, 1: 2.0 }]);
    const res = await bet({ market_id: noLay.rows[0].id, runner: '0', stake: 10, bet_type: 'lay', odd: 99 });
    expect(res.body.success).toBe(false);
  });

  test('suspended runner is rejected for back and lay; other runner still open', async () => {
    await pool.query(`UPDATE markets SET runner_status='{"1":"suspended"}'::jsonb WHERE id=$1`, [marketId]);
    const a = await bet({ market_id: marketId, runner: '1', stake: 10, bet_type: 'back' });
    const b = await bet({ market_id: marketId, runner: '1', stake: 10, bet_type: 'lay' });
    expect(a.body.success).toBe(false);
    expect(b.body.success).toBe(false);
    const ok = await bet({ market_id: marketId, runner: '0', stake: 10, bet_type: 'back' });
    expect(ok.body.success).toBe(true);
    await pool.query(`UPDATE markets SET runner_status='{}'::jsonb WHERE id=$1`, [marketId]);
  });

  test('player head-to-head market: Back and Lay both work, label comes from the feed', async () => {
    const r1 = await bet({ market_id: h2hId, runner: '0', stake: 50, bet_type: 'lay' }); // lay 1.9 -> liability 45
    expect(r1.body).toMatchObject({ success: true, liability: 45 });
    const mb = await agent.get('/matches/api/my-bets').set('Accept', 'application/json');
    const row = mb.body.bets.find((b) => b.market.startsWith('Head to Head'));
    expect(row).toMatchObject({ selection: 'V Kohli', betType: 'lay', liability: 45, status: 'pending', stake: 50 });
  });
});

describe('settlement + ledger', () => {
  test('runner 0 wins: BACK wins, LAY loses (house keeps liability); ledger rows written', async () => {
    await new Promise((r) => setTimeout(r, 300)); // let async reward hooks finish so balance deltas are exact
    const before = await coins();
    const r = await settle(marketId, '0');
    expect(r.total).toBeGreaterThanOrEqual(2);
    // back 100 @2.0 -> +200 ; lay lost -> +0 ; extra back 10 @2.0 -> +20
    expect(await coins()).toBe(before + 200 + 20);
    const types = (await pool.query(
      `SELECT t.type, t.amount FROM coin_transactions t JOIN bets b ON b.id=t.ref_bet_id WHERE b.user_id=$1 AND b.market_id=$2 AND t.type IN ('bet_win','lay_loss')`,
      [userId, marketId])).rows;
    expect(types.map((t) => t.type).sort()).toEqual(['bet_win', 'bet_win', 'lay_loss']);
    expect(Number(types.find((t) => t.type === 'lay_loss').amount)).toBe(0);
  });

  test('settling the same market twice never double-credits', async () => {
    const before = await coins();
    const again = await settle(marketId, '0');
    expect(again.total).toBe(0);
    expect(await coins()).toBe(before);
  });

  test('LAY WINS when its runner loses: stake + liability credited', async () => {
    const before = await coins();
    await settle(h2hId, '1'); // lay was on runner 0 (Kohli) who did not win
    expect(await coins()).toBe(before + 50 + 45);
    const tx = (await pool.query(
      `SELECT t.amount FROM coin_transactions t JOIN bets b ON b.id=t.ref_bet_id WHERE b.market_id=$1 AND t.type='lay_win'`, [h2hId])).rows[0];
    expect(Number(tx.amount)).toBe(95);
  });

  test('ledger rows tied to a bet are immutable; duplicate (ref_bet_id,type) is refused', async () => {
    const row = (await pool.query(`SELECT id, ref_bet_id, type FROM coin_transactions WHERE ref_bet_id IS NOT NULL AND user_id=$1 LIMIT 1`, [userId])).rows[0];
    await expect(pool.query('UPDATE coin_transactions SET amount = 999999 WHERE id=$1', [row.id])).rejects.toThrow(/immutable/);
    await expect(pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description, ref_bet_id) VALUES ($1,1,$2,'dup',$3)`,
      [userId, row.type, row.ref_bet_id])).rejects.toThrow(/uq_coin_tx_bet_ref|duplicate/);
  });

  test('concurrent settlement of the same market credits exactly once', async () => {
    const mid = (await pool.query(
      `INSERT INTO markets (match_id, market_key, type, name, odds, depth, status) VALUES ($1,'race','bookmaker','Race',$2,$3,'open') RETURNING id`,
      [matchId, { 0: 2.0, 1: 2.0 }, { 0: { lay: 2.2 } }])).rows[0].id;
    expect((await bet({ market_id: mid, runner: '0', stake: 100, bet_type: 'back' })).body.success).toBe(true);
    const before = await coins();
    await Promise.all([settle(mid, '0'), settle(mid, '0'), settle(mid, '0')]);
    expect(await coins()).toBe(before + 200);
  });
});

describe('wallet invariant', () => {
  test('after the re-base, coins always equals offset + ledger sum (every debit/credit is ledgered)', async () => {
    await new Promise((r) => setTimeout(r, 300));
    expect(await coins()).toBe(offset + (await ledgerSum()));
  });
});
