// K10 — "১৫০ স্টেকের পর ব্যালেন্স ৮৫০ নয়, ৮৭০" — ওই ২০ কোথা থেকে আসে এবং সাসপেন্ডের সঙ্গে তার কোনো সম্পর্ক নেই, তার প্রমাণ।
//
// ২০ = `first_bet` ব্যাজের রিওয়ার্ড (services/badges.js, BADGES[first_bet].reward = 20)।
// routes/matches.js বাজির COMMIT-এর *পরে* await ছাড়া checkBadges(userId) চালায়; ইউজারের প্রথম বাজি-সারি
// (coin_transactions.type = 'bet') থাকলেই ব্যাজ মেলে, coins += 20 ও coin_transactions(type='badge') লেখা হয়।
// এটা বাজির পথের নিজস্ব নিয়ম — সাসপেন্ড চেক (autoSuspend.getMatchProviderSuspension) এর আগে/পরে কোথাও ছোঁয় না।
//
// এখানে একই দৃশ্য তিনবার চালানো হয় — সাসপেন্ড ছাড়া / অটো সাসপেন্ড / ম্যানুয়াল সাসপেন্ড — এবং প্রতিটা ধাপের ব্যালেন্স
// সরাসরি তুলনা করা হয়। আসল Postgres।
process.env.AUTO_SUSPEND_CACHE_TTL_MS = '1';
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const autoSuspend = require('../../services/autoSuspend');
const settlement = require('../../services/settlement');

const DEPTH = { A: { name: 'Alpha', back: 2.0, lay: 2.5 }, B: { name: 'Beta', back: 3.0, lay: 3.4 } };
const START = 1000;
const STAKES = [100, 50];            // মোট ১৫০
const FIRST_BET_BADGE_REWARD = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
     VALUES ('SuspendParity','Alpha','Beta','cricket','live','cricket-cricapi', NOW()) RETURNING id`);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,'open') RETURNING id`,
    [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH)]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
const bet = (u, matchId, body) => u.agent.post(`/matches/${matchId}/bet`).set('X-CSRF-Token', u.token).type('form').send(body);
const coins = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
const badgeRows = async (id) => (await pool.query(
  "SELECT amount, description FROM coin_transactions WHERE user_id=$1 AND type='badge' ORDER BY id", [id])).rows
  .map((r) => ({ amount: Number(r.amount), description: r.description }));

// বাজির পরের রিওয়ার্ড কাজগুলো (ব্যাজ ইত্যাদি) fire-and-forget — ব্যালেন্স স্থির হওয়া পর্যন্ত অপেক্ষা।
// প্রথম-বাজির ব্যাজ-সারি না আসা পর্যন্ত "স্থির" ধরা হয় না, নইলে ৮৫০ বনাম ৮৭০ রেসে পড়ত।
async function settledCoins(userId) {
  let prev = null; let stable = 0;
  for (let i = 0; i < 60; i++) {
    const c = await coins(userId);
    const hasBadge = (await badgeRows(userId)).length > 0;
    if (hasBadge && c === prev) { stable += 1; if (stable >= 3) return c; } else { stable = 0; }
    prev = c;
    await sleep(100);
  }
  throw new Error('ব্যালেন্স স্থির হয়নি (ব্যাজ-সারি আসেনি?)');
}

const setAuto = (name) => pool.query(
  `INSERT INTO integration_suspend (name, suspended, source, reason, suspended_at, updated_at)
   VALUES ($1, true, 'auto', 'consecutive_failures', NOW(), NOW())
   ON CONFLICT (name) DO UPDATE SET suspended = true, source = 'auto', reason = 'consecutive_failures', suspended_at = NOW()`, [name]);
const clear = (name) => pool.query('DELETE FROM integration_suspend WHERE name = $1', [name]);

const SUSPENDERS = {
  none: null,
  auto: () => setAuto('sports:cricapi'),
  manual: () => autoSuspend.manualSuspend('sports:cricapi', { by: 'test', byId: null })
};

async function runScenario(kind) {
  const u = await makeUser(START);
  const m1 = await makeMarket();
  const m2 = await makeMarket();
  expect((await bet(u, m1.matchId, { market_id: m1.marketId, runner: 'A', side: 'back', stake: String(STAKES[0]) })).status).toBe(200);
  expect((await bet(u, m2.matchId, { market_id: m2.marketId, runner: 'A', side: 'back', stake: String(STAKES[1]) })).status).toBe(200);
  const afterBets = await settledCoins(u.userId);
  const badges = await badgeRows(u.userId);

  const out = { afterBets, badges };

  if (SUSPENDERS[kind]) {
    await SUSPENDERS[kind]();
    expect(await autoSuspend.getMatchProviderSuspension('cricket-cricapi')).toBeTruthy();
    // নতুন বাজি আটকায়, টাকা কাটে না, কোনো রিওয়ার্ডও আসে না
    const m3 = await makeMarket();
    const blocked = await bet(u, m3.matchId, { market_id: m3.marketId, runner: 'A', side: 'back', stake: '10' });
    expect(blocked.status).toBe(503);
    await sleep(300);
    expect(await coins(u.userId)).toBe(afterBets);
  }

  // সেটলমেন্ট (জয়): ১০০ × ২.০ = ২০০ ক্রেডিট
  const c1 = await pool.connect();
  try { await c1.query('BEGIN'); await settlement.settleMarketBets(c1, m1.marketId, 'A'); await c1.query('COMMIT'); } finally { c1.release(); }
  out.afterWin = await coins(u.userId);

  // বাতিল (void): ৫০ ফেরত
  const c2 = await pool.connect();
  try { await c2.query('BEGIN'); await settlement.voidMarketBets(c2, m2.marketId, 'match cancelled'); await c2.query('COMMIT'); } finally { c2.release(); }
  out.final = await coins(u.userId);

  // লেজারের ধরনভিত্তিক যোগফল — ২০ কোন ধরনের সারিতে, তা দেখাতে
  const byType = (await pool.query(
    'SELECT type, SUM(amount)::int AS total FROM coin_transactions WHERE user_id=$1 GROUP BY type ORDER BY type', [u.userId])).rows;
  out.ledger = Object.fromEntries(byType.map((r) => [r.type, r.total]));
  return out;
}

const results = {};

afterAll(async () => {
  await pool.query("UPDATE matches SET status = 'finished' WHERE title = 'SuspendParity'");
  await clear('sports:cricapi');
});

describe('"২০ ফেরত" ব্যাখ্যা ও সাসপেন্ড-অপরিবর্তনীয়তা', () => {
  afterEach(async () => { await clear('sports:cricapi'); });

  test.each(['none', 'auto', 'manual'])('দৃশ্য চলে: সাসপেন্ড = %s', async (kind) => {
    results[kind] = await runScenario(kind);
    const r = results[kind];

    // ২০ কী: ঠিক একটা `first_bet` ব্যাজের রিওয়ার্ড-সারি
    expect(r.badges).toEqual([{ amount: FIRST_BET_BADGE_REWARD, description: 'ব্যাজ: প্রথম বাজি' }]);
    // ১০০০ − ১৫০ (স্টেক) + ২০ (ব্যাজ) = ৮৭০ — ৮৫০ নয়
    expect(r.afterBets).toBe(START - STAKES.reduce((a, b) => a + b, 0) + FIRST_BET_BADGE_REWARD);
    expect(r.afterBets).toBe(870);
    // লেজার: বাজি −১৫০, ব্যাজ +২০ (শুধু এই দুটো ধরনই বাজি-পথে ব্যালেন্স নাড়ায়)
    expect(r.ledger.bet).toBe(-150);
    expect(r.ledger.badge).toBe(20);
    // জয় +২০০, void +৫০
    expect(r.afterWin).toBe(870 + 200);
    expect(r.final).toBe(870 + 200 + 50);
  });

  test('সাসপেন্ড থাকা-না-থাকায় প্রতিটা ধাপের ব্যালেন্স অভিন্ন (অটো ও ম্যানুয়াল, দুটোই)', () => {
    expect(Object.keys(results).sort()).toEqual(['auto', 'manual', 'none']);
    expect(results.auto).toEqual(results.none);
    expect(results.manual).toEqual(results.none);
  });
});
