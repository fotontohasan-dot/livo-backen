// K10 (ঘ) — সাসপেন্ড অবস্থায় বিদ্যমান বাজি/রাউন্ডের টাকার পথ চলে; শুধু *নতুন* বাজি ও ক্যাসিনো লঞ্চ আটকায়।
// আসল Postgres; স্পোর্টস (settle/void) ও ক্যাসিনো ওয়ালেট (bet/win/rollback) দুটোই, অটো ও হাতে — দুই ধরনের সাসপেন্ডে।
process.env.AUTO_SUSPEND_CACHE_TTL_MS = '1';
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const autoSuspend = require('../../services/autoSuspend');
const settlement = require('../../services/settlement');
const wallet = require('../../services/wallet');

const DEPTH = { A: { name: 'Alpha', back: 2.0, lay: 2.5 }, B: { name: 'Beta', back: 3.0, lay: 3.4 } };

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const u = await pool.query('UPDATE users SET coins = $1 WHERE username = $2 RETURNING id', [coins, username]);
  return { agent, token, userId: u.rows[0].id };
}
async function makeMarket() {
  const m = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status, provider, synced_at)
     VALUES ('SuspendExisting','Alpha','Beta','cricket','live','cricket-cricapi', NOW()) RETURNING id`);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,'open') RETURNING id`,
    [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH)]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
const bet = (u, matchId, body) => u.agent.post(`/matches/${matchId}/bet`).set('X-CSRF-Token', u.token).type('form').send(body);
const coins = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
const setAuto = (name) => pool.query(
  `INSERT INTO integration_suspend (name, suspended, source, reason, suspended_at, updated_at)
   VALUES ($1, true, 'auto', 'consecutive_failures', NOW(), NOW())
   ON CONFLICT (name) DO UPDATE SET suspended = true, source = 'auto', reason = 'consecutive_failures', suspended_at = NOW()`, [name]);
const clear = (name) => pool.query('DELETE FROM integration_suspend WHERE name = $1', [name]);

afterAll(async () => {
  await pool.query("UPDATE matches SET status = 'finished' WHERE title = 'SuspendExisting'");
  await clear('sports:cricapi'); await clear('casino:db-games');
});

describe.each([['auto', async () => setAuto('sports:cricapi')], ['manual', async () => autoSuspend.manualSuspend('sports:cricapi', { by: 'test', byId: null })]])(
  'স্পোর্টস সাসপেন্ড (%s)', (kind, suspend) => {
    afterEach(async () => { await clear('sports:cricapi'); });

    test('নতুন বাজি ৫০৩ (কয়েন কাটে না), কিন্তু আগের বাজির সেটলমেন্ট ও void-রিফান্ড চলে', async () => {
      const u = await makeUser(1000);
      const m1 = await makeMarket();
      const m2 = await makeMarket();
      // সাসপেন্ডের আগে দুটো বাজি
      expect((await bet(u, m1.matchId, { market_id: m1.marketId, runner: 'A', side: 'back', stake: '100' })).status).toBe(200);
      expect((await bet(u, m2.matchId, { market_id: m2.marketId, runner: 'A', side: 'back', stake: '50' })).status).toBe(200);
      const afterBets = await coins(u.userId);   // সাসপেন্ডের আগের ব্যালেন্স (বিদ্যমান বাজি-পথের নিজস্ব রিবেট/ক্যাশব্যাক সমেত); এর সঙ্গেই সব তুলনা
      expect(afterBets).toBeLessThan(1000);

      await suspend();
      expect(await autoSuspend.getMatchProviderSuspension('cricket-cricapi')).toBeTruthy();

      // নতুন বাজি আটকায়
      const m3 = await makeMarket();
      const blocked = await bet(u, m3.matchId, { market_id: m3.marketId, runner: 'A', side: 'back', stake: '10' });
      expect(blocked.status).toBe(503);
      expect(blocked.body).toMatchObject({ success: false, code: 'STALE_ODDS', suspended: true });
      expect(await coins(u.userId)).toBe(afterBets);

      // সেটলমেন্ট (জয়) চলে: ১০০ × ২.০ = ২০০ ক্রেডিট
      const c1 = await pool.connect();
      try {
        await c1.query('BEGIN');
        const out = await settlement.settleMarketBets(c1, m1.marketId, 'A');
        await c1.query('COMMIT');
        expect(out).toBeTruthy();
      } finally { c1.release(); }
      expect(await coins(u.userId)).toBe(afterBets + 200);
      expect((await pool.query("SELECT status FROM bets WHERE market_id=$1", [m1.marketId])).rows[0].status).toBe('won');

      // বাতিল/রিফান্ড (void) চলে: ৫০ ফেরত
      const c2 = await pool.connect();
      try {
        await c2.query('BEGIN');
        const v = await settlement.voidMarketBets(c2, m2.marketId, 'match cancelled');
        await c2.query('COMMIT');
        expect(v).toMatchObject({ total: 1, refunded: 50 });
      } finally { c2.release(); }
      expect(await coins(u.userId)).toBe(afterBets + 200 + 50);
      expect((await pool.query("SELECT status FROM bets WHERE market_id=$1", [m2.marketId])).rows[0].status).toBe('void');
    });

    test('ব্রাউজিং আটকায় না: ম্যাচ তালিকা ও ক্যাসিনো লবি ২০০', async () => {
      const u = await makeUser(100);
      await suspend();
      const a = await u.agent.get('/matches').set('User-Agent', REALISTIC_UA);
      expect(a.status).toBe(200);
      const b = await u.agent.get('/games').set('User-Agent', REALISTIC_UA);
      expect(b.status).toBe(200);
    });
  });

describe.each([['auto', async () => setAuto('casino:db-games')], ['manual', async () => autoSuspend.manualSuspend('casino:db-games', { by: 'test', byId: null })]])(
  'ক্যাসিনো সাসপেন্ড (%s): চলমান রাউন্ডের ওয়ালেট callback আটকায় না', (kind, suspend) => {
    afterEach(async () => { await clear('casino:db-games'); });
    const P = 'db-games';
    const tx = (s) => `sus_${kind}_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    test('bet (ডেবিট) → সাসপেন্ড → win (ক্রেডিট) চলে', async () => {
      const u = await makeUser(500);
      const round = tx('r1');
      await wallet.debit({ provider: P, providerTxId: tx('b1'), roundId: round, userId: u.userId, gameId: 'g1', amount: 100 });
      expect(await coins(u.userId)).toBe(400);
      await suspend();
      await wallet.credit({ provider: P, providerTxId: tx('w1'), roundId: round, userId: u.userId, gameId: 'g1', amount: 250 });
      expect(await coins(u.userId)).toBe(650);
    });

    test('bet → সাসপেন্ড → rollback (রিফান্ড) চলে, দ্বিতীয়বার rollback টাকা দ্বিগুণ করে না', async () => {
      const u = await makeUser(500);
      const round = tx('r2'); const betTx = tx('b2');
      await wallet.debit({ provider: P, providerTxId: betTx, roundId: round, userId: u.userId, gameId: 'g1', amount: 120 });
      expect(await coins(u.userId)).toBe(380);
      await suspend();
      const rbTx = tx('rb2');
      await wallet.rollback({ provider: P, providerTxId: rbTx, roundId: round, referenceTxId: betTx, userId: u.userId, gameId: 'g1' });
      expect(await coins(u.userId)).toBe(500);
      await wallet.rollback({ provider: P, providerTxId: tx('rb2b'), roundId: round, referenceTxId: betTx, userId: u.userId, gameId: 'g1' });
      expect(await coins(u.userId)).toBe(500);
    });

    test('সাসপেন্ডে নতুন গেম লঞ্চ আটকায় (রিডাইরেক্ট), কিন্তু ইউজারের ব্যালেন্স অক্ষত', async () => {
      const u = await makeUser(300);
      await suspend();
      const r = await u.agent.get('/games/launch/db-games/some-game').set('User-Agent', REALISTIC_UA);
      expect([301, 302, 303]).toContain(r.status);
      expect(r.headers.location).toBe('/games');
      expect(await coins(u.userId)).toBe(300);
    });
  });
