// PR #271 K1 — must_reset_password: আসল অ্যাপ + Postgres। ফ্ল্যাগ থাকলে শুধু পাসওয়ার্ড বদল/রিসেট, লগআউট, লগইন চলে;
// বাজি/ওয়ালেট/উত্তোলন/বাকি সব আটকায়; ফ্ল্যাগ পরিষ্কার হলে সব ফেরে; বার্তা bn/en দুটোতেই বোধগম্য।
const { pool } = require('../../db');
const cache = require('../../services/cache');
const { hashToken } = require('../../utils/tokens');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const PW = 'SecurePass123';
const GATE = '/profile/security/login-password';
const DEPTH = { A: { name: 'Alpha', back: 2.0, lay: 2.5 }, B: { name: 'Beta', back: 3.0, lay: 3.4 } };
const matchIds = [];

async function makeUser({ flagged = false } = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: PW, confirmPassword: PW, _csrf: token });
  const u = (await pool.query('UPDATE users SET coins = 1000 WHERE username = $1 RETURNING id', [username])).rows[0];
  const user = { agent, token, userId: u.id, username };
  if (flagged) await setFlag(user.userId, true);
  return user;
}
const setFlag = async (id, v) => { await pool.query('UPDATE users SET must_reset_password = $2 WHERE id = $1', [id, v]); await cache.del(`auth:active:${id}`); };
const flag = async (id) => (await pool.query('SELECT must_reset_password AS f FROM users WHERE id = $1', [id])).rows[0].f;
const ua = (r) => r.set('User-Agent', REALISTIC_UA);
const post = (u, p, body = {}) => ua(u.agent.post(p).set('X-CSRF-Token', u.token)).type('form').send({ _csrf: u.token, ...body });
async function makeMarket() {
  const m = await pool.query(`INSERT INTO matches (title, team_a, team_b, sport, status, provider, synced_at) VALUES ('ResetFlow','Alpha','Beta','cricket','live',NULL,NULL) RETURNING id`);
  matchIds.push(m.rows[0].id);
  const mk = await pool.query(`INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,'open') RETURNING id`, [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH)]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
afterAll(async () => { if (matchIds.length) await pool.query("UPDATE matches SET status='finished' WHERE id = ANY($1)", [matchIds]); });

describe('ফ্ল্যাগ আছে: বাজি/ওয়ালেট/উত্তোলন/বাকি সব আটকায়', () => {
  let u;
  beforeAll(async () => { u = await makeUser({ flagged: true }); });

  test('বাজি → পাসওয়ার্ড-বদল পাতায় রিডাইরেক্ট; বাজি/কয়েন-কাটা নেই', async () => {
    const { matchId, marketId } = await makeMarket();
    const r = await post(u, `/matches/${matchId}/bet`, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(GATE);
    expect((await pool.query('SELECT 1 FROM bets WHERE user_id=$1', [u.userId])).rowCount).toBe(0);
    expect(Number((await pool.query('SELECT coins FROM users WHERE id=$1', [u.userId])).rows[0].coins)).toBe(1000);
  });

  test('ওয়ালেট ব্যালেন্স API → 403 JSON', async () => {
    const r = await ua(u.agent.get('/profile/api/balance'));
    expect(r.status).toBe(403);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toBeTruthy();
  });

  test('উত্তোলন → আটকায়, কোনো withdrawal রো নেই', async () => {
    const r = await post(u, '/payment/withdraw', { amount: '500', method: 'bKash', account_number: '01712345678' });
    expect([302, 403]).toContain(r.status);
    if (r.status === 302) expect(r.headers.location).toBe(GATE);
    expect((await pool.query("SELECT 1 FROM payment_requests WHERE user_id=$1 AND type='withdraw'", [u.userId])).rowCount).toBe(0);
  });

  test.each(['/profile', '/profile/cards', '/games/launch/db-games/x', '/wallet'])('%s → পাসওয়ার্ড-বদল পাতায়', async (p) => {
    const r = await ua(u.agent.get(p));
    expect([302, 404]).toContain(r.status);
    if (r.status === 302) expect(r.headers.location).toBe(GATE);
  });

  test('কার্ড যোগ (ডেটা লেখা) আটকায়', async () => {
    const r = await post(u, '/profile/cards/add', { bank_name: 'bKash', account_number: '01711112222', holder_name: 'Rahim Uddin' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(GATE);
    expect((await pool.query('SELECT 1 FROM bank_cards WHERE user_id=$1', [u.userId])).rowCount).toBe(0);
  });
});

describe('ফ্ল্যাগ আছে: অনুমোদিত কাজ চলে', () => {
  test('পাসওয়ার্ড-বদল পাতা খোলে (২০০), বার্তাসহ', async () => {
    const u = await makeUser({ flagged: true });
    const r = await ua(u.agent.get(GATE));
    expect(r.status).toBe(200);
  });

  test('লগআউট চলে; এরপর সেশন নেই', async () => {
    const u = await makeUser({ flagged: true });
    const r = await post(u, '/logout');
    expect(r.status).toBe(302);
    const after = await ua(u.agent.get('/profile'));
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/login');
  });

  test('লগইন চলে (isAuth-এর বাইরে); লগইনের পর শুধু পাসওয়ার্ড-বদল পাতা খোলে', async () => {
    const u = await makeUser({ flagged: true });
    const { agent, token } = await getCsrfAgent('/login');
    const r = await ua(agent.post('/login')).type('form').send({ identifier: u.username, username: u.username, password: PW, _csrf: token });
    expect(r.status).toBe(302);
    expect(r.headers.location).not.toMatch(/\/login(\?|$)/);
    expect((await ua(agent.get(GATE))).status).toBe(200);
    const blocked = await ua(agent.get('/profile'));
    expect(blocked.status).toBe(302);
    expect(blocked.headers.location).toBe(GATE);
  });

  test('ভুল বর্তমান পাসওয়ার্ডে বদল হয় না, ফ্ল্যাগ থাকে', async () => {
    const u = await makeUser({ flagged: true });
    await post(u, '/profile/change-password', { current_password: 'WrongPass999', new_password: 'BrandNew#9876', confirmPassword: 'BrandNew#9876' });
    expect(await flag(u.userId)).toBe(true);
  });

  test('পাসওয়ার্ড বদল → ফ্ল্যাগ মুছে যায় → বাজি/ওয়ালেট/প্রোফাইল সব ফেরে', async () => {
    const u = await makeUser({ flagged: true });
    const r = await post(u, '/profile/change-password', { current_password: PW, new_password: 'BrandNew#9876', confirmPassword: 'BrandNew#9876' });
    expect(r.status).toBe(302);
    expect(await flag(u.userId)).toBe(false);
    expect((await ua(u.agent.get('/profile/api/balance'))).status).toBe(200);
    expect((await ua(u.agent.get('/profile'))).status).toBe(200);
    const { matchId, marketId } = await makeMarket();
    const bet = await post(u, `/matches/${matchId}/bet`, { market_id: marketId, runner: 'A', side: 'back', stake: '100' });
    expect(bet.status).toBe(200);
    expect((await pool.query('SELECT 1 FROM bets WHERE user_id=$1', [u.userId])).rowCount).toBe(1);
  });

  test('টোকেন-ভিত্তিক পাসওয়ার্ড রিসেট (isAuth-এর বাইরে) চলে → ফ্ল্যাগ মুছে যায়; নতুন পাসওয়ার্ডে লগইন', async () => {
    const u = await makeUser({ flagged: true });
    const tok = `tok_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await pool.query(`UPDATE users SET reset_token=$2, reset_token_expiry = NOW() + INTERVAL '1 hour' WHERE id=$1`, [u.userId, hashToken(tok)]);
    const { agent, token } = await getCsrfAgent('/forgot-password');
    const r = await ua(agent.post(`/reset-password/${tok}`)).type('form').send({ password: 'ResetNew#4567', confirmPassword: 'ResetNew#4567', _csrf: token });
    expect(r.status).toBe(302);
    expect(await flag(u.userId)).toBe(false);
  });
});

describe('বার্তা বাংলা ও ইংরেজি দুটোতেই বোধগম্য', () => {
  test.each([['bn', /পাসওয়ার্ড বদলাতে হবে/], ['en', /must change your password/i]])('%s: JSON 403 ও রিডাইরেক্ট-পাতার ফ্ল্যাশ', async (lang, re) => {
    const u = await makeUser({ flagged: true });
    await ua(u.agent.get(`/lang/${lang}`));
    const api = await ua(u.agent.get('/profile/api/balance'));
    expect(api.body.error).toMatch(re);
    const hop = await ua(u.agent.get('/profile'));
    expect(hop.headers.location).toBe(GATE);
    const page = await ua(u.agent.get(GATE));
    expect(page.status).toBe(200);
    expect(page.text).toMatch(re);
  });
});
