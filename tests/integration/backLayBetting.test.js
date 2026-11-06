// tests/integration/backLayBetting.test.js
// Back/Lay এক্সচেঞ্জ গ্রিড: লায়াবিলিটি হিসাব, সার্ভার-নির্ধারিত Lay দাম, রানার/মার্কেট সাসপেনশন,
// Lay সেটেলমেন্ট আর ম্যাচ পেজের রেন্ডার।
const { pool } = require('../../db');
const { liabilityFor, payoutFor, betWins } = require('../../services/layMath');
const { resolveLayOdd, isRunnerSuspended } = require('../../services/oddsResolver');
const { buildMarketView } = require('../../services/marketLayout');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const DEPTH = {
  A: { name: 'Alpha', back: 2.0, lay: 2.5, back_size: 100, lay_size: 200, suspended: false },
  B: { name: 'Beta', back: 3.0, lay: 3.4, back_size: 50, lay_size: 80, suspended: false }
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
async function makeMarket({ status = 'open', depth = DEPTH, odds = { A: 2.0, B: 3.0 } } = {}) {
  const m = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status) VALUES ('BL Test','Alpha','Beta','cricket','live') RETURNING id`);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,$4) RETURNING id`,
    [m.rows[0].id, JSON.stringify(odds), depth ? JSON.stringify(depth) : null, status]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
const bet = (u, matchId, body) =>
  u.agent.post(`/matches/${matchId}/bet`).set('X-CSRF-Token', u.token).type('form').send(body);

describe('লায়াবিলিটি/পেআউট হিসাব (services/layMath.js)', () => {
  test('liability = stake × (odds − 1), দশমিক অডসেও নির্ভুল', () => {
    expect(liabilityFor(100, 2.5)).toBe(150);
    expect(liabilityFor(10, 1.85)).toBe(8.5);
    expect(liabilityFor(50, 3.45)).toBe(122.5);
    expect(liabilityFor(10, 1.01)).toBe(0.1);
  });
  test('Lay জিতলে stake + liability ফেরত; Back জিতলে floor(stake × odd)', () => {
    expect(payoutFor({ side: 'lay', stake: 100, liability: 150, odd: 2.5 })).toBe(250);
    expect(payoutFor({ side: 'back', stake: 50, odd: 1.85 })).toBe(92);
    expect(payoutFor({ stake: 50, odd: 2 })).toBe(100); // পুরনো বাজি (side নেই) = back
  });
  test('Lay সেই রানার না জিতলে জেতে; Back রানার জিতলে', () => {
    expect(betWins({ side: 'lay', runner: 'A' }, 'B')).toBe(true);
    expect(betWins({ side: 'lay', runner: 'A' }, 'A')).toBe(false);
    expect(betWins({ side: 'back', runner: 'A' }, 'A')).toBe(true);
    expect(betWins({ runner: 'A' }, 'B')).toBe(false);
  });
});

describe('রিজলভার ও মার্কেট ভিউ', () => {
  test('Lay দাম শুধু depth থেকে; depth না থাকলে null; রানার সাসপেনশন পড়া হয়', () => {
    expect(resolveLayOdd({ depth: DEPTH }, 'A')).toBe(2.5);
    expect(resolveLayOdd({ depth: DEPTH }, 'Z')).toBeNull();
    expect(resolveLayOdd({ depth: null }, 'A')).toBeNull();
    expect(resolveLayOdd({ depth: { A: { lay: 0.9 } } }, 'A')).toBeNull();
    expect(isRunnerSuspended({ depth: { A: { suspended: true } } }, 'A')).toBe(true);
    expect(isRunnerSuspended({ depth: DEPTH }, 'A')).toBe(false);
    expect(isRunnerSuspended({}, 'A')).toBe(false);
  });
  test('buildMarketView রানারে lay, সাইজ, suspended আর মার্কেটের status দেয়', () => {
    const depth = { ...DEPTH, B: { ...DEPTH.B, suspended: true } };
    const v = buildMarketView(
      [{ id: 1, type: 'bookmaker', name: 'Bookmaker', status: 'suspended', odds: { A: 2.0, B: 3.0 }, depth }],
      { sport: 'cricket', teams: ['Alpha', 'Beta'] });
    const m = v.markets[0];
    expect(m.status).toBe('suspended');
    const a = m.runners.find((r) => r.key === 'A');
    const b = m.runners.find((r) => r.key === 'B');
    expect(a).toMatchObject({ odd: 2, lay: 2.5, backSize: 100, laySize: 200, suspended: false });
    expect(b.suspended).toBe(true);
  });
  test('depth ছাড়া মার্কেটে lay = null (Lay বক্স নিষ্ক্রিয় হবে)', () => {
    const v = buildMarketView([{ id: 2, type: 'bookmaker', name: 'B', status: 'open', odds: { 0: 1.85, 1: 2.1 } }],
      { sport: 'cricket', teams: ['Alpha', 'Beta'] });
    v.markets[0].runners.forEach((r) => expect(r.lay).toBeNull());
  });
});

describe('Lay বাজি (POST /matches/:id/bet)', () => {
  test('লায়াবিলিটি কাটে (স্টেক নয়), দাম সার্ভার থেকে নেয়, side/liability জমা রাখে', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    // ক্লায়েন্টের পাঠানো odd (১০০) উপেক্ষিত হতে হবে
    const res = await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100', odd: '100' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const row = (await pool.query('SELECT * FROM bets WHERE user_id=$1', [u.userId])).rows[0];
    expect(row.side).toBe('lay');
    expect(Number(row.odd)).toBe(2.5);
    expect(Number(row.stake)).toBe(100);
    expect(Number(row.liability)).toBe(150);
    const tx = await pool.query(`SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='bet'`, [u.userId]);
    expect(Number(tx.rows[0].amount)).toBe(-150);
  });

  test('Back বাজি আগের মতো: side=back, liability নেই, স্টেক কাটে', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const res = await bet(u, matchId, { market_id: marketId, runner: 'A', stake: '100' });
    expect(res.status).toBe(200);
    const row = (await pool.query('SELECT * FROM bets WHERE user_id=$1', [u.userId])).rows[0];
    expect(row.side).toBe('back');
    expect(row.liability).toBeNull();
    const tx = await pool.query(`SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='bet'`, [u.userId]);
    expect(Number(tx.rows[0].amount)).toBe(-100);
  });

  test('ঝুঁকি (লায়াবিলিটি) ব্যালেন্সের বেশি হলে প্রত্যাখ্যান — কোনো বাজি/কাটাকাটি হয় না', async () => {
    const u = await makeUser(100);
    const { matchId, marketId } = await makeMarket();
    // স্টেক ১০০ ≤ ব্যালেন্স, কিন্তু লায়াবিলিটি ১৫০ > ১০০
    const res = await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100' });
    expect(res.status).toBe(400);
    expect((await pool.query('SELECT 1 FROM bets WHERE user_id=$1', [u.userId])).rowCount).toBe(0);
  });

  test('মিনিমাম স্টেক ভ্যালিডেশন Lay-তেও প্রযোজ্য', async () => {
    const u = await makeUser(1000);
    const { matchId, marketId } = await makeMarket();
    const res = await bet(u, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '1' });
    expect(res.status).toBe(400);
    expect((await pool.query('SELECT 1 FROM bets WHERE user_id=$1', [u.userId])).rowCount).toBe(0);
  });

  test('Lay দাম না থাকলে (depth নেই) আর অচেনা side হলে প্রত্যাখ্যান', async () => {
    const u = await makeUser(1000);
    const noDepth = await makeMarket({ depth: null });
    const r1 = await bet(u, noDepth.matchId, { market_id: noDepth.marketId, runner: 'A', side: 'lay', stake: '100' });
    expect(r1.status).toBe(400);
    const ok = await makeMarket();
    const r2 = await bet(u, ok.matchId, { market_id: ok.marketId, runner: 'A', side: 'sideways', stake: '100' });
    expect(r2.status).toBe(400);
    expect((await pool.query('SELECT 1 FROM bets WHERE user_id=$1', [u.userId])).rowCount).toBe(0);
  });

  test('সাসপেন্ড রানারে Back ও Lay দুটোই বন্ধ; অন্য রানার চালু; সাসপেন্ড মার্কেটে কিছুই চলে না', async () => {
    const u = await makeUser(1000);
    const depth = { ...DEPTH, A: { ...DEPTH.A, suspended: true } };
    const m = await makeMarket({ depth });
    const back = await bet(u, m.matchId, { market_id: m.marketId, runner: 'A', side: 'back', stake: '50' });
    const lay = await bet(u, m.matchId, { market_id: m.marketId, runner: 'A', side: 'lay', stake: '50' });
    expect(back.status).toBe(400);
    expect(lay.status).toBe(400);
    const other = await bet(u, m.matchId, { market_id: m.marketId, runner: 'B', side: 'back', stake: '50' });
    expect(other.status).toBe(200);

    const closed = await makeMarket({ status: 'suspended' });
    const r = await bet(u, closed.matchId, { market_id: closed.marketId, runner: 'A', side: 'lay', stake: '50' });
    expect(r.status).toBe(400);
  });
});

describe('Lay সেটেলমেন্ট (POST /admin/markets/:id/settle)', () => {
  async function settle(admin, marketId, winner) {
    return admin.agent.post(`/admin/markets/${marketId}/settle`)
      .set('X-CSRF-Token', admin.token).type('form').send({ winning_runner: winner });
  }
  const wins = (userId) => pool.query(`SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='bet_win'`, [userId]);

  test('রানার হারলে Lay জেতে: stake + liability ফেরত; Back হারে', async () => {
    const layer = await makeUser(1000);
    const backer = await makeUser(1000);
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    expect((await bet(layer, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100' })).status).toBe(200);
    expect((await bet(backer, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' })).status).toBe(200);

    expect((await settle(admin, marketId, 'B')).status).toBe(302);

    const lw = await wins(layer.userId);
    expect(lw.rows.map((r) => Number(r.amount))).toEqual([250]);
    expect((await wins(backer.userId)).rowCount).toBe(0);
    expect((await pool.query('SELECT status FROM bets WHERE user_id=$1', [layer.userId])).rows[0].status).toBe('won');
    expect((await pool.query('SELECT status FROM bets WHERE user_id=$1', [backer.userId])).rows[0].status).toBe('lost');
  });

  test('রানার জিতলে Lay হারে (কিছু ফেরত নেই); Back জেতে', async () => {
    const layer = await makeUser(1000);
    const backer = await makeUser(1000);
    const admin = await makeAdmin();
    const { matchId, marketId } = await makeMarket();
    await bet(layer, matchId, { market_id: marketId, runner: 'A', side: 'lay', stake: '100' });
    await bet(backer, matchId, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });

    expect((await settle(admin, marketId, 'A')).status).toBe(302);

    expect((await wins(layer.userId)).rowCount).toBe(0);
    expect((await pool.query('SELECT status FROM bets WHERE user_id=$1', [layer.userId])).rows[0].status).toBe('lost');
    expect((await wins(backer.userId)).rows.map((r) => Number(r.amount))).toEqual([200]);
  });
});

describe('ম্যাচ পেজ রেন্ডার', () => {
  test('Back/Lay বক্স, Lay নিষ্ক্রিয় (দাম নেই), সাসপেন্ড রানার ও মার্কেট ওভারলে', async () => {
    const u = await makeUser(0);
    const depth = { A: { ...DEPTH.A }, B: { ...DEPTH.B, lay: null, suspended: true } };
    const { matchId } = await makeMarket({ depth });
    const susp = await makeMarket({ status: 'suspended' });
    let page = await u.agent.get(`/matches/${matchId}`);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/class="odds back"[^>]*data-side="back"/);
    expect(page.text).toMatch(/class="odds lay"[^>]*data-side="lay"/);
    expect(page.text).toMatch(/market-cell suspended" data-runner="B"/);
    expect(page.text).toMatch(/class="odds lay"[^>]*data-runner="B"[^>]*disabled/);
    expect(page.text).toContain('susp-overlay');
    expect(page.text).not.toMatch(/market-box suspended/);

    page = await u.agent.get(`/matches/${susp.matchId}`);
    expect(page.text).toMatch(/market-box suspended/);
    expect(page.text).toMatch(/class="odds back"[^>]*disabled/);
  });
});
