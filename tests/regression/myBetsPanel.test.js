// "My Bets" প্যানেল: GET /matches/api/my-bets — শুধু নিজের বাজি, সম্ভাব্য রিটার্ন = স্টেক × অডস।
const request = require('supertest');
const { pool } = require('../../db');
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');

describe('GET /matches/api/my-bets', () => {
  const userIds = [];
  let matchId;
  let marketId;

  async function player() {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const u = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    userIds.push(u.rows[0].id);
    return { agent, id: u.rows[0].id };
  }

  beforeAll(async () => {
    const m = await pool.query(`INSERT INTO matches (title, team_a, team_b, sport) VALUES ('MyBets Test','Team A','Team B','cricket') RETURNING id`);
    matchId = m.rows[0].id;
    const mk = await pool.query(`INSERT INTO markets (match_id, name, type, odds, status) VALUES ($1,'Team A Win','match_winner','{"yes":1.8}','open') RETURNING id`, [matchId]);
    marketId = mk.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM bets WHERE match_id = $1', [matchId]);
    await pool.query('DELETE FROM markets WHERE match_id = $1', [matchId]);
    await pool.query('DELETE FROM matches WHERE id = $1', [matchId]);
    await cleanupUsers(userIds);
  });

  test('লগইন ছাড়া JSON ডেটা পাওয়া যায় না', async () => {
    const res = await request(app).get('/matches/api/my-bets').redirects(0);
    expect(res.status).not.toBe(200);
  });

  test('নিজের বাজি ফেরে, অন্যের নয়; রিটার্ন = স্টেক × অডস', async () => {
    const a = await player();
    const b = await player();
    await pool.query(`INSERT INTO bets (user_id, match_id, market_id, market_type, runner, odd, stake, status) VALUES ($1,$2,$3,'match_winner','yes',1.80,250,'pending')`, [a.id, matchId, marketId]);
    await pool.query(`INSERT INTO bets (user_id, match_id, market_id, market_type, runner, odd, stake, status) VALUES ($1,$2,$3,'match_winner','yes',1.80,999,'lost')`, [b.id, matchId, marketId]);

    const res = await a.agent.get('/matches/api/my-bets');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.bets).toHaveLength(1);
    expect(res.body.bets[0]).toMatchObject({ matchName: 'MyBets Test', market: 'Team A Win', selection: 'Yes', betType: 'back', liability: 0, odd: 1.8, stake: 250, potentialReturn: 450, status: 'pending' });
  });
});
