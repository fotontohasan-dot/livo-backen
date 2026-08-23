const { pool } = require('../db');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');

async function makeAdminAgentWithToken() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', username]);
  return { agent, token, username };
}

// রিগ্রেশন: settleSelectionsForMarket() আগে affectedAccaIds.size (একটা সংখ্যা) রিটার্ন করত,
// কিন্তু routes/admin.js-এর POST /admin/markets/:marketId/settle সেটাকে
// notifsToEmit.push(...accaNotifs) দিয়ে spread করার চেষ্টা করত — সংখ্যা iterable না হওয়ায়
// এটা DB COMMIT-এর পরে সবসময় TypeError থ্রো করত (একটা মার্কেটে অ্যাকুমুলেটর সিলেকশন থাকুক
// বা না থাকুক)। ফলে মার্কেট আসলে ঠিকভাবে সেটেল হয়ে যেত, কিন্তু অ্যাডমিনকে ভুলভাবে
// "সেটেল সমস্যা!" দেখানো হতো, real-time winner notification ও audit log কখনো পাঠানো হতো না।
describe('অ্যাকুমুলেটর মার্কেট সেটেলমেন্ট (services/accumulator.js settleSelectionsForMarket)', () => {
  const createdUserIds = [];
  const createdMatchIds = [];

  async function makeUser(coins = 1000) {
    const username = uniqueUsername();
    const res = await pool.query(
      `INSERT INTO users (username, phone, password, coins) VALUES ($1,$2,'x',$3) RETURNING id`,
      [username, uniquePhone(), coins]
    );
    createdUserIds.push(res.rows[0].id);
    return res.rows[0].id;
  }

  async function makeMatch() {
    const res = await pool.query(
      `INSERT INTO matches (title, team_a, team_b, sport) VALUES ('Test Match','A','B','cricket') RETURNING id`
    );
    createdMatchIds.push(res.rows[0].id);
    return res.rows[0].id;
  }

  afterAll(async () => {
    if (createdUserIds.length) {
      await pool.query('DELETE FROM notifications WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM coin_transactions WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM accumulator_selections WHERE acca_id IN (SELECT id FROM accumulators WHERE user_id = ANY($1))', [createdUserIds]);
      await pool.query('DELETE FROM accumulators WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (createdMatchIds.length) await pool.query('DELETE FROM matches WHERE id = ANY($1)', [createdMatchIds]);
  });

  test('কোনো accumulator selection না থাকলে খালি অ্যারে রিটার্ন করে (সংখ্যা নয়)', async () => {
    const matchId = await makeMatch();
    const marketRes = await pool.query(
      `INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1,'match_winner','Match Winner','{}','open') RETURNING id`,
      [matchId]
    );
    const marketId = marketRes.rows[0].id;

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await settleSelectionsForMarket(client, marketId, 'A');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
    // spread করলে যেন থ্রো না করে — এটাই আসল বাগের রিগ্রেশন গার্ড
    expect(() => [...result]).not.toThrow();
  });

  test('accumulator জিতলে {userId, row} শেপের নোটিফিকেশন অ্যারে রিটার্ন করে এবং পেআউট হয়', async () => {
    const userId = await makeUser(1000);
    const matchId = await makeMatch();
    const marketRes = await pool.query(
      `INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1,'match_winner','Match Winner','{}','open') RETURNING id`,
      [matchId]
    );
    const marketId = marketRes.rows[0].id;

    const accaRes = await pool.query(
      `INSERT INTO accumulators (user_id, stake, total_odd, potential_win, selection_count, status)
       VALUES ($1, 100, 2.00, 200, 1, 'pending') RETURNING id`,
      [userId]
    );
    const accaId = accaRes.rows[0].id;
    await pool.query(
      `INSERT INTO accumulator_selections (acca_id, match_id, market_id, runner, odd, status)
       VALUES ($1, $2, $3, 'A', 2.00, 'pending')`,
      [accaId, matchId, marketId]
    );

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await settleSelectionsForMarket(client, marketId, 'A');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]).toHaveProperty('userId', userId);
    expect(result[0]).toHaveProperty('row');
    expect(result[0].row).toHaveProperty('id');

    const accaAfter = await pool.query('SELECT status FROM accumulators WHERE id=$1', [accaId]);
    expect(accaAfter.rows[0].status).toBe('won');
    const userAfter = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    expect(Number(userAfter.rows[0].coins)).toBe(1200); // 1000 + payout(200)
  });

  test('accumulator সিলেকশনসহ মার্কেট থাকলেও পুরো HTTP settle রুট ক্র্যাশ করে না এবং success flash দেখায়', async () => {
    const userId = await makeUser(500);
    const matchId = await makeMatch();
    const marketRes = await pool.query(
      `INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1,'match_winner','Match Winner','{}','open') RETURNING id`,
      [matchId]
    );
    const marketId = marketRes.rows[0].id;
    const accaRes = await pool.query(
      `INSERT INTO accumulators (user_id, stake, total_odd, potential_win, selection_count, status)
       VALUES ($1, 50, 3.00, 150, 1, 'pending') RETURNING id`,
      [userId]
    );
    await pool.query(
      `INSERT INTO accumulator_selections (acca_id, match_id, market_id, runner, odd, status)
       VALUES ($1, $2, $3, 'A', 3.00, 'pending')`,
      [accaRes.rows[0].id, matchId, marketId]
    );

    const { agent, token } = await makeAdminAgentWithToken();

    const res = await agent.post(`/admin/markets/${marketId}/settle`).set('X-CSRF-Token', token).type('form').send({ winning_runner: 'A' });
    expect(res.status).toBe(302);

    const marketAfter = await pool.query('SELECT status FROM markets WHERE id=$1', [marketId]);
    expect(marketAfter.rows[0].status).toBe('settled');

    const auditLog = await pool.query(
      `SELECT * FROM audit_logs WHERE action='MARKET_SETTLED' AND category='financial' ORDER BY id DESC LIMIT 1`
    );
    expect(auditLog.rows.length).toBe(1);
  });
});
