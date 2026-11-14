// আটকে থাকা ক্যাসিনো রাউন্ড শনাক্তকারী — আসল Postgres। আটকে থাকা ধরে; বৈধভাবে শেষ হওয়া ধরে না; কিছু লেখে না।
const { pool } = require('../../db');
const svc = require('../../services/stuckCasinoRounds');
const script = require('../../scripts/reportStuckCasinoRounds');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const P = 'tst-stuck';
const tag = `st${Date.now()}`;
let userId;
const insTx = (round, type, ageHours, { status = 'completed', amount = 10, token = null } = {}) => pool.query(
  `INSERT INTO provider_transactions (provider, provider_tx_id, round_id, user_id, type, amount, balance_before, balance_after, status, raw_payload, created_at)
   VALUES ($1,$2,$3,$4,$5,$6,0,0,$7,$8, NOW() - make_interval(secs => $9::float8 * 3600))`,
  [P, `${tag}_${Math.random().toString(36).slice(2)}`, round, userId, type, amount, status, token ? JSON.stringify({ session_token: token }) : null, ageHours]);
const ids = async () => (await svc.findStuckRounds(pool, { hours: 6, limit: 5000 })).rounds.filter((r) => r.provider === P).map((r) => r.roundId).sort();

beforeAll(async () => {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  userId = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0].id;
});
afterAll(async () => { await pool.query('DELETE FROM provider_transactions WHERE provider=$1', [P]); await pool.query("DELETE FROM game_sessions WHERE session_token LIKE $1", [`${tag}%`]); });

test('আটকে থাকা ধরে; বৈধভাবে শেষ/নতুন/ডেমো/রোলব্যাক ধরে না', async () => {
  await insTx(`${tag}_stuck`, 'bet', 7, { amount: 25 });                         // ✔ আটকে
  await insTx(`${tag}_stuck_multi`, 'bet', 9, { amount: 10 });                   // ✔ আটকে (২ বেট, স্টেক ৩০)
  await insTx(`${tag}_stuck_multi`, 'bet', 7, { amount: 20 });
  await insTx(`${tag}_won`, 'bet', 8); await insTx(`${tag}_won`, 'win', 7.5, { amount: 40 });          // ✘ জয়
  await insTx(`${tag}_lost0`, 'bet', 8); await insTx(`${tag}_lost0`, 'win', 7.5, { amount: 0 });       // ✘ হার (win ০)
  await insTx(`${tag}_rb`, 'bet', 8, { status: 'rolled_back' }); await insTx(`${tag}_rb`, 'rollback', 7.9); // ✘ রোলব্যাক
  await insTx(`${tag}_rb_only`, 'bet', 8, { status: 'rolled_back' });                                   // ✘ রোলব্যাক-অবস্থা
  await insTx(`${tag}_fresh`, 'bet', 1);                                                                // ✘ ৬ ঘণ্টা হয়নি
  await insTx(`${tag}_fresh_multi`, 'bet', 9); await insTx(`${tag}_fresh_multi`, 'bet', 2);            // ✘ শেষ বেট নতুন
  await pool.query(`INSERT INTO game_sessions (session_token, user_id, provider, game_id, mode, expires_at) VALUES ($1,$2,$3,'g','demo', NOW() + INTERVAL '1 day')`, [`${tag}_demo_tok`, userId, P]);
  await insTx(`${tag}_demo`, 'bet', 8, { token: `${tag}_demo_tok` });                                  // ✘ ডেমো
  await pool.query(`INSERT INTO game_sessions (session_token, user_id, provider, game_id, mode, expires_at) VALUES ($1,$2,$3,'g','real', NOW() + INTERVAL '1 day')`, [`${tag}_real_tok`, userId, P]);
  await insTx(`${tag}_realsess`, 'bet', 8, { token: `${tag}_real_tok` });                              // ✔ আসল সেশন, আটকে

  expect(await ids()).toEqual([`${tag}_realsess`, `${tag}_stuck`, `${tag}_stuck_multi`].sort());
  const res = await svc.findStuckRounds(pool, { hours: 6 });
  const multi = res.rounds.find((r) => r.roundId === `${tag}_stuck_multi`);
  expect(multi.stake).toBe(30);
  expect(multi.userId).toBe(userId);
  expect(multi.stuckSeconds).toBeGreaterThan(7 * 3600 - 120);
});

test('থ্রেশহোল্ড কনফিগযোগ্য (env)', () => {
  expect(svc.thresholdHours({})).toBe(6);
  expect(svc.thresholdHours({ STUCK_ROUND_HOURS: '12' })).toBe(12);
  expect(svc.thresholdHours({ STUCK_ROUND_HOURS: '0' })).toBe(6);
  expect(svc.thresholdHours({ STUCK_ROUND_HOURS: 'abc' })).toBe(6);
});

test('রাউন্ড শেষ হলে (win এলে) তালিকা থেকে সরে যায়', async () => {
  await insTx(`${tag}_late`, 'bet', 10);
  expect(await ids()).toContain(`${tag}_late`);
  await insTx(`${tag}_late`, 'win', 0, { amount: 5 });
  expect(await ids()).not.toContain(`${tag}_late`);
});

test('countStuckRounds: সংখ্যা মেলে; DB ব্যর্থ হলে null (০ নয়)', async () => {
  const n = await svc.countStuckRounds(pool, { hours: 6 });
  expect(n).toBe((await svc.findStuckRounds(pool, { hours: 6, limit: 5000 })).count);
  expect(await svc.countStuckRounds({ query: async () => { throw new Error('boom'); } })).toBeNull();
});

describe('স্ক্রিপ্ট: শুধু-পড়া, আউটপুটে সিক্রেট/ব্যক্তিগত তথ্য নেই', () => {
  const runIt = async (argv) => { const out = []; const code = await script.run({ argv, env: { DATABASE_URL: 'x://hidden', STUCK_ROUND_HOURS: '6' }, out: (m) => out.push(m), pool }); return { code, out: out.join('\n') }; };

  test('টেবিল আউটপুট: ইউজার আইডি, প্রোভাইডার, রাউন্ড আইডি, স্টেক, সময়; ব্যালেন্স ও টেবিল অপরিবর্তিত', async () => {
    const snap = async () => JSON.stringify([(await pool.query('SELECT id, coins FROM users WHERE id=$1', [userId])).rows, (await pool.query('SELECT COUNT(*)::int n FROM provider_transactions WHERE provider=$1', [P])).rows, (await pool.query('SELECT COUNT(*)::int n FROM coin_transactions WHERE user_id=$1', [userId])).rows]);
    const before = await snap();
    const r = await runIt([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/user_id \| provider \| round_id \| stake \| stuck_for/);
    expect(r.out).toContain(`${userId} | ${P} | ${tag}_stuck | 25 |`);
    expect(r.out).not.toMatch(/session_token|_tok|password|phone|username|@/i);
    expect(await snap()).toBe(before);
  });

  test('--json বৈধ JSON; --fail-on-found → exit 2; অজানা অপশন → 1', async () => {
    const j = await runIt(['--json']);
    const parsed = JSON.parse(j.out);
    expect(parsed.count).toBeGreaterThan(0);
    expect(Object.keys(parsed.rounds[0]).sort()).toEqual(['provider', 'roundId', 'stake', 'stuckFor', 'userId']);
    expect((await runIt(['--fail-on-found'])).code).toBe(2);
    expect((await runIt(['--write'])).code).toBe(1);
  });

  test('লেখার চেষ্টা READ ONLY ট্রানজ্যাকশনে ব্যর্থ হয় (গ্যারান্টি)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await expect(c.query('UPDATE users SET coins = coins WHERE id = $1', [userId])).rejects.toMatchObject({ code: '25006' });
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});

test('অ্যাডমিন পেজ ও মেট্রিক সংযুক্ত; শুধু system_diagnostics_manage', () => {
  const fs = require('fs'); const path = require('path');
  const r = fs.readFileSync(path.join(__dirname, '../../routes/adminHealthFix.js'), 'utf8');
  expect(r).toMatch(/router\.get\('\/stuck-rounds', isAdmin, rbac\.requirePermission\('system_diagnostics_manage'\)/);
  expect(r).toMatch(/BEGIN READ ONLY/);
  expect(fs.readFileSync(path.join(__dirname, '../../services/opsMetrics.js'), 'utf8')).toMatch(/casinoStuckRounds/);
  const alerts = fs.readFileSync(path.join(__dirname, '../../docs/ALERTS.md'), 'utf8');
  expect(alerts).toMatch(/bet420_casino_stuck_rounds > 0/);
  expect(fs.readFileSync(path.join(__dirname, '../../docs/STUCK_ROUNDS.md'), 'utf8')).toMatch(/আসল টাকার ক্যাসিনো চালুর শর্ত/);
});

describe('অ্যাডমিন পেজ /admin/stuck-rounds: শুধু system_diagnostics_manage ধারী', () => {
  async function adminWithRole(roleKey) {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    await pool.query('UPDATE users SET role=$1, role_key=$2 WHERE username=$3', ['admin', roleKey, username]);
    return agent;
  }
  test('super_admin: সংখ্যা ও তালিকা দেখে; কোনো সিক্রেট নেই', async () => {
    const a = await adminWithRole('super_admin');
    const r = await a.get('/admin/stuck-rounds').set('User-Agent', REALISTIC_UA);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`${tag}_stuck`);
    expect(r.text).toContain(P);
    expect(r.text).not.toMatch(/session_token|_demo_tok|_real_tok/);
  });
  test.each(['admin', 'finance', 'moderator', 'support'])('%s রোল: পায় না', async (role) => {
    const a = await adminWithRole(role);
    const r = await a.get('/admin/stuck-rounds').set('User-Agent', REALISTIC_UA);
    expect(r.status).not.toBe(200);
    expect(r.text || '').not.toContain(`${tag}_stuck`);
  });
  test('সাধারণ ইউজার পায় না', async () => {
    const { agent } = await getCsrfAgent('/register');
    const r = await agent.get('/admin/stuck-rounds').set('User-Agent', REALISTIC_UA);
    expect(r.status).not.toBe(200);
  });
});
