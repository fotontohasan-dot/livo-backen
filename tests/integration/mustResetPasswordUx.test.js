// PR #271 K1 (task 3) — must_reset_password অভিজ্ঞতা: স্পষ্ট কোড MUST_RESET_PASSWORD (JSON), লগইনের পর সরাসরি পাসওয়ার্ড-বদল পাতায়
// রিডাইরেক্ট, ফ্রন্টএন্ড হ্যান্ডলার, এবং পাসওয়ার্ড বদলালে ফ্ল্যাগ মুছে অন্য সব সেশন বাতিল (আসল অ্যাপ + Postgres)।
const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const cache = require('../../services/cache');
const { extractCsrfToken, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const PW = 'SecurePass123';
const NEW_PW = 'BrandNew#9876';
const GATE = '/profile/security/login-password';
const ua = (r) => r.set('User-Agent', REALISTIC_UA);

async function register() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: PW, confirmPassword: PW, _csrf: token });
  const id = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
  return { agent, token, username, userId: id };
}
async function login(username) {
  const { agent, token } = await getCsrfAgent('/login');
  const r = await ua(agent.post('/login')).type('form').send({ identifier: username, username, password: PW, _csrf: token });
  return { agent, token, res: r };
}
const setFlag = async (id, v) => { await pool.query('UPDATE users SET must_reset_password = $2 WHERE id = $1', [id, v]); await cache.del(`auth:active:${id}`); };
const flag = async (id) => (await pool.query('SELECT must_reset_password AS f FROM users WHERE id = $1', [id])).rows[0].f;

describe('লগইন API/রিডাইরেক্ট ও কোড', () => {
  test('ফ্ল্যাগ থাকলে লগইন সরাসরি পাসওয়ার্ড-বদল পাতায় রিডাইরেক্ট করে, পাতায় বার্তা দেখায়', async () => {
    const u = await register();
    await setFlag(u.userId, true);
    const l = await login(u.username);
    expect(l.res.status).toBe(302);
    expect(l.res.headers.location).toBe(GATE);
    const page = await ua(l.agent.get(GATE));
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/পাসওয়ার্ড বদলাতে হবে|must change your password/i);
  });

  test('ফ্ল্যাগ না থাকলে লগইন আগের মতো "/" এ যায় (রিগ্রেশন নেই)', async () => {
    const u = await register();
    const l = await login(u.username);
    expect(l.res.status).toBe(302);
    expect(l.res.headers.location).toBe('/');
  });

  test('API 403 JSON-এ code=MUST_RESET_PASSWORD, বার্তা ও redirect আছে', async () => {
    const u = await register();
    await setFlag(u.userId, true);
    const r = await ua(u.agent.get('/profile/api/balance'));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ success: false, code: 'MUST_RESET_PASSWORD', redirect: GATE });
    expect(r.body.error).toBeTruthy();
  });

  test('ফ্রন্টএন্ড: csrf-inject.js এই কোডে পাসওয়ার্ড-বদল পাতায় নেয় (শুধু একই-অরিজিনের পাথ)', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/csrf-inject.js'), 'utf8');
    expect(js).toContain("body.code === 'MUST_RESET_PASSWORD'");
    expect(js).toContain('window.location.assign(to)');
    expect(js).toMatch(/charAt\(0\) === '\/' && body\.redirect\.charAt\(1\) !== '\/'/);
    expect(() => new Function(js)).not.toThrow(); // সিনট্যাক্স ঠিক
  });
});

describe('পাসওয়ার্ড বদল: ফ্ল্যাগ মোছে + অন্য সেশন বাতিল', () => {
  test('অন্য ডিভাইসের সেশন বাতিল হয়; বর্তমান সেশন চালু; ফ্ল্যাগ false; পুরনো পাসওয়ার্ডে লগইন হয় না', async () => {
    const u = await register();
    const other = await login(u.username); // "অন্য ডিভাইস"
    expect((await ua(other.agent.get('/profile'))).status).toBe(200);
    await setFlag(u.userId, true);
    const cur = await login(u.username); // বর্তমান ডিভাইস → গেটে
    expect(cur.res.headers.location).toBe(GATE);

    // লগইনে সেশন রোটেট হয় → গেট পাতা থেকে নতুন CSRF টোকেন
    const gate = await ua(cur.agent.get(GATE));
    const csrf = extractCsrfToken(gate.text);
    const r = await ua(cur.agent.post('/profile/change-password').set('X-CSRF-Token', csrf)).type('form')
      .send({ _csrf: csrf, current_password: PW, new_password: NEW_PW, confirmPassword: NEW_PW });
    expect(r.status).toBe(302);
    expect(await flag(u.userId)).toBe(false);

    // অন্য ডিভাইসের সেশন আর কাজ করে না
    const o = await ua(other.agent.get('/profile'));
    expect(o.status).toBe(302);
    expect(o.headers.location).toMatch(/\/login/);
    // বর্তমান সেশন চালু ও ফ্ল্যাগ-গেট ছাড়া
    expect((await ua(cur.agent.get('/profile'))).status).toBe(200);
    // পুরনো পাসওয়ার্ড অচল, নতুনটা চলে
    const { agent, token } = await getCsrfAgent('/login');
    const bad = await ua(agent.post('/login')).type('form').send({ identifier: u.username, username: u.username, password: PW, _csrf: token });
    expect(bad.headers.location).toMatch(/\/login/);
    const { agent: a2, token: t2 } = await getCsrfAgent('/login');
    const good = await ua(a2.post('/login')).type('form').send({ identifier: u.username, username: u.username, password: NEW_PW, _csrf: t2 });
    expect(good.headers.location).toBe('/');
  });
});
