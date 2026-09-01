// tests/integration/marketStatusIntegrity.test.js
// ---------------------------------------------------------------------------
// স্পোর্টস মার্কেট status ও সেটেলমেন্ট ইন্টিগ্রিটি।
//
// AUDIT FINDING ১ (এখানে ঠিক করা হয়েছে): views/admin/markets.ejs-এর Suspend/Open
// ফর্মে কোনো status ইনপুটই নেই — শুধু একটা submit বাটন। তাই
// `UPDATE markets SET status = $1` [req.body.status] সবসময় undefined পেয়ে
// status NULL করে দিত। routes/matches.js বাজি নেওয়ার আগে `status = 'open'`
// খোঁজে, আর NULL কখনো 'open'-এর সমান নয় — অর্থাৎ বাটনটা একবার চাপলেই মার্কেট
// চিরতরে অচল, এবং আবার চাপলেও প্রতিবার NULL-ই বসত বলে ফেরানোর কোনো পথ ছিল না।
// HTTP 302 আসায় অ্যাডমিনের কাছে সফল দেখাত।
//
// AUDIT FINDING ২: /markets/:id/settle-এ মার্কেট ইতিমধ্যে সেটেল কি না তার কোনো
// গার্ড ছিল না, আর toggle যেকোনো স্ট্রিং (whitelist ছাড়া) বসাতে পারত — দুটো
// মিলে সেটেল হওয়া মার্কেট আবার 'open' করে জানা ফলাফলে বাজি নেওয়ার পথ খুলত।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const {
  getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken
} = require('../helpers/app');

let seq = 0;

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const res = await pool.query(
    'UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]
  );
  return { agent, userId: res.rows[0].id };
}

async function makeMarket(status = 'open') {
  seq++;
  const match = await pool.query(
    `INSERT INTO matches (title, sport, team_a, team_b, status)
     VALUES ($1, 'football', $2, $3, 'live') RETURNING id`,
    [`MSI match ${seq}`, `MSI-A-${seq}`, `MSI-B-${seq}`]
  );
  const matchId = match.rows[0].id;
  const market = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, status)
     VALUES ($1, 'match_winner', $2, $3, $4) RETURNING id`,
    [matchId, `MSI market ${seq}`, JSON.stringify({ home: 2.0, away: 3.0 }), status]
  );
  return { matchId, marketId: market.rows[0].id };
}

const marketStatus = async (id) =>
  (await pool.query('SELECT status FROM markets WHERE id=$1', [id])).rows[0].status;

let adminAgent, csrf;

beforeAll(async () => {
  const a = await makeAdminAgent();
  adminAgent = a.agent;
  const page = await adminAgent.get('/admin/matches');
  csrf = extractCsrfToken(page.text);
  // টোকেন না পেলে প্রতিটা POST নীরবে 403 হতো, আর "কিছু বদলায়নি" ধরনের
  // অ্যাসারশনগুলো ভুলভাবে পাস করত — তাই এখানেই স্পষ্ট করে ধরা হচ্ছে।
  if (!csrf) throw new Error('CSRF টোকেন পাওয়া যায়নি — /admin/matches রেন্ডার হয়নি?');
});

afterAll(async () => { await pool.end().catch(() => {}); });

async function toggle(marketId, body = {}) {
  return adminAgent.post(`/admin/markets/${marketId}/toggle`)
    .type('form').send({ _csrf: csrf, ...body });
}

describe('POST /admin/markets/:id/toggle', () => {
  test('status ইনপুট ছাড়া ফর্ম পোস্ট করলে status NULL হয় না — open → suspended', async () => {
    const { marketId } = await makeMarket('open');
    await toggle(marketId);
    const st = await marketStatus(marketId);
    expect(st).not.toBeNull();
    expect(st).toBe('suspended');
  });

  test('আবার চাপলে suspended → open ফিরে আসে (মার্কেট চিরতরে অচল হয় না)', async () => {
    const { marketId } = await makeMarket('open');
    await toggle(marketId);
    expect(await marketStatus(marketId)).toBe('suspended');
    await toggle(marketId);
    expect(await marketStatus(marketId)).toBe('open');
  });

  test('whitelist-বহির্ভূত স্ট্যাটাস DB-তে পৌঁছায় না', async () => {
    const { marketId } = await makeMarket('open');
    await toggle(marketId, { status: 'totally-made-up' });
    expect(await marketStatus(marketId)).toBe('open');
  });

  test('toggle দিয়ে সরাসরি settled বসানো যায় না (সেটেলমেন্ট আর্থিক ঘটনা)', async () => {
    const { marketId } = await makeMarket('open');
    await toggle(marketId, { status: 'settled' });
    expect(await marketStatus(marketId)).toBe('open');
  });

  test('সেটেল হওয়া মার্কেট আবার open করা যায় না', async () => {
    const { marketId } = await makeMarket('settled');
    await toggle(marketId);
    expect(await marketStatus(marketId)).toBe('settled');
  });
});

describe('POST /admin/markets/:id/settle — পুনঃসেটেলমেন্ট', () => {
  test('সেটেল হওয়া মার্কেট দ্বিতীয়বার সেটেল করা যায় না', async () => {
    const { marketId } = await makeMarket('settled');
    const res = await adminAgent.post(`/admin/markets/${marketId}/settle`)
      .type('form').send({ _csrf: csrf, winning_runner: 'home' });
    expect(res.status).toBe(302);
    expect(await marketStatus(marketId)).toBe('settled');
  });

  test('সেটেলমেন্টের পর একই বাজি দ্বিতীয়বার পেআউট পায় না', async () => {
    const { matchId, marketId } = await makeMarket('open');
    seq++;
    const u = await pool.query(
      `INSERT INTO users (username, phone, password, coins) VALUES ($1, $2, 'x', 0) RETURNING id`,
      [`msi_${Date.now()}_${seq}`, `0197${String(Date.now()).slice(-7)}${seq}`.slice(0, 14)]
    );
    const userId = u.rows[0].id;
    await pool.query(
      `INSERT INTO bets (user_id, match_id, market_id, market_type, runner, odd, stake, status)
       VALUES ($1, $2, $3, 'match_winner', 'home', 2.0, 100, 'pending')`,
      [userId, matchId, marketId]
    );

    await adminAgent.post(`/admin/markets/${marketId}/settle`)
      .type('form').send({ _csrf: csrf, winning_runner: 'home' });

    const afterFirst = Number(
      (await pool.query('SELECT coins FROM users WHERE id=$1', [userId])).rows[0].coins
    );
    expect(afterFirst).toBe(200);

    // দ্বিতীয় সেটেলমেন্ট চেষ্টা — গার্ড আটকাবে, ব্যালেন্স অপরিবর্তিত থাকবে
    await adminAgent.post(`/admin/markets/${marketId}/settle`)
      .type('form').send({ _csrf: csrf, winning_runner: 'home' });

    const afterSecond = Number(
      (await pool.query('SELECT coins FROM users WHERE id=$1', [userId])).rows[0].coins
    );
    expect(afterSecond).toBe(afterFirst);

    // লেজার-ইনভেরিয়েন্ট: ব্যালেন্স == লেজার এন্ট্রির যোগফল
    const ledger = Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id=$1`, [userId]
    )).rows[0].s);
    expect(ledger).toBe(afterSecond);
  });
});
