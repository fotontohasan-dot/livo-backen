// অ্যাডমিন "remember": সেশন শেষ হলে পাসওয়ার্ড লাগে না, কিন্তু ২FA কোড সবসময় লাগে।
const speakeasy = require('speakeasy');
const { pool } = require('../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken, freshRequest } = require('./helpers/app');
const { generateBackupCodes, hashBackupCodes } = require('../services/twofactor');
const secretBox = require('../utils/secretBox');
const { hashToken } = require('../utils/tokens');

function cookieValue(res, name) {
  const line = (res.headers['set-cookie'] || []).find((c) => c.startsWith(name + '='));
  return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
}
const cookieLine = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(name + '=')) || '';

async function makeAdmin(password = 'SecurePass123') {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password, confirmPassword: password, _csrf: token });
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const hashed = await hashBackupCodes(generateBackupCodes(5));
  const r = await pool.query(
    `UPDATE users SET role='admin', totp_secret=$1, totp_enabled=true, totp_backup_codes=$2, totp_last_used_step=NULL
     WHERE username=$3 RETURNING id`, [secretBox.encrypt(secret), hashed, username]);
  return { id: r.rows[0].id, username, password, secret };
}

// পূর্ণ লগইন: username+password → ২FA কোড। ফেরত: কুকিসহ শেষ রেসপন্স ও ip
async function fullAdminLogin(a) {
  const { agent, ip } = await getCsrfAgent('/admin/login');
  const page = await agent.get('/admin/login');
  await agent.post('/admin/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username: a.username, password: a.password, _csrf: extractCsrfToken(page.text) });
  const twofa = await agent.get('/admin/login/2fa');
  const code = speakeasy.totp({ secret: a.secret, encoding: 'base32' });
  const done = await agent.post('/admin/login/2fa').set('User-Agent', REALISTIC_UA).type('form')
    .send({ token: code, _csrf: extractCsrfToken(twofa.text) });
  return { done, ip, agent };
}

// শুধু admin remember কুকি — সেশন কুকি নেই ("সেশন হারিয়ে গেছে")
const onlyRemember = (ip, art, path = '/admin') =>
  freshRequest(ip).get(path).set('User-Agent', REALISTIC_UA).set('Cookie', `livo_art=${art}`);

describe('Admin remember (password skipped, 2FA required)', () => {
  test('২FA-র পর HttpOnly + SameSite=Strict + Path=/admin কুকি বসে; DB-তে kind=admin ও শুধু হ্যাশ', async () => {
    const a = await makeAdmin();
    const { done } = await fullAdminLogin(a);
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/admin');
    const art = cookieValue(done, 'livo_art');
    expect(art).toMatch(/^[a-f0-9]{64}$/);
    const line = cookieLine(done, 'livo_art');
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Strict/i);
    expect(line).toMatch(/Path=\/admin/i);
    const row = await pool.query('SELECT kind FROM refresh_tokens WHERE token_hash=$1', [hashToken(art)]);
    expect(row.rows[0].kind).toBe('admin');
    expect((await pool.query('SELECT 1 FROM refresh_tokens WHERE token_hash=$1', [art])).rows.length).toBe(0);
  });

  test('সেশন শেষ হলে /admin → সরাসরি ২FA কোড পেজ (পাসওয়ার্ড চায় না); সঠিক কোডে ঢুকে যায়', async () => {
    const a = await makeAdmin();
    const { done, ip } = await fullAdminLogin(a);
    const art1 = cookieValue(done, 'livo_art');

    const r = await onlyRemember(ip, art1, '/admin');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/admin/login/2fa');       // লগইন পেজ নয়
    expect(cookieValue(r, 'livo_art')).not.toBe(art1);          // টোকেন রোটেট হয়েছে
    // এখনো লগইন হয়নি — আসল অ্যাডমিন পেজ খোলা যায় না
    const sid = cookieValue(r, 'connect.sid');
    expect(sid).toBeTruthy();
  });

  test('শুধু remember কুকি দিয়ে লগইন হয় না — ২FA কোড ছাড়া অ্যাডমিন পেজ বন্ধ', async () => {
    const a = await makeAdmin();
    const { done, ip } = await fullAdminLogin(a);
    const art = cookieValue(done, 'livo_art');
    const first = await onlyRemember(ip, art, '/admin');
    const sidCookie = (first.headers['set-cookie'] || []).find((c) => c.startsWith('connect.sid=')).split(';')[0];
    // একই pending সেশন দিয়ে কোড ছাড়া অ্যাডমিন ড্যাশবোর্ডে যাওয়ার চেষ্টা
    const dash = await freshRequest(ip).get('/admin/users').set('User-Agent', REALISTIC_UA).set('Cookie', sidCookie);
    expect(dash.status).toBe(302);
    expect(dash.headers.location).toMatch(/\/admin\/login/);
  });

  test('২FA পেজে সঠিক কোড দিলে লগইন সম্পন্ন (কোনো পাসওয়ার্ড ছাড়াই)', async () => {
    const a = await makeAdmin();
    const { done, ip } = await fullAdminLogin(a);
    const art = cookieValue(done, 'livo_art');
    const first = await onlyRemember(ip, art, '/admin');
    const cookies = (first.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

    const page = await freshRequest(ip).get('/admin/login/2fa').set('User-Agent', REALISTIC_UA).set('Cookie', cookies);
    expect(page.status).toBe(200);
    expect(page.text).toContain(a.username);
    const csrf = extractCsrfToken(page.text);
    const pageCookies = [cookies, ...(page.headers['set-cookie'] || []).map((c) => c.split(';')[0])].join('; ');

    // আগের ধাপে ব্যবহৃত TOTP step replay হবে — তাই পরের step-এর কোড (±1 উইন্ডো)
    const code = speakeasy.totp({ secret: a.secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 });
    const ok = await freshRequest(ip).post('/admin/login/2fa').set('User-Agent', REALISTIC_UA)
      .set('Cookie', pageCookies).type('form').send({ token: code, _csrf: csrf });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/admin');
  });

  test('ভুল ২FA কোড দিলে ঢোকা যায় না', async () => {
    const a = await makeAdmin();
    const { done, ip } = await fullAdminLogin(a);
    const art = cookieValue(done, 'livo_art');
    const first = await onlyRemember(ip, art, '/admin');
    const cookies = (first.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    const page = await freshRequest(ip).get('/admin/login/2fa').set('User-Agent', REALISTIC_UA).set('Cookie', cookies);
    const csrf = extractCsrfToken(page.text);
    const pageCookies = [cookies, ...(page.headers['set-cookie'] || []).map((c) => c.split(';')[0])].join('; ');
    const bad = await freshRequest(ip).post('/admin/login/2fa').set('User-Agent', REALISTIC_UA)
      .set('Cookie', pageCookies).type('form').send({ token: '000000', _csrf: csrf });
    expect(bad.status).toBe(200); // একই ২FA পেজ, ত্রুটিসহ
    expect(bad.headers.location).toBeUndefined();
  });

  test('২FA বন্ধ করা বা ব্যান হলে remember আর কাজ করে না', async () => {
    const a = await makeAdmin();
    const { done, ip } = await fullAdminLogin(a);
    const art = cookieValue(done, 'livo_art');
    await pool.query('UPDATE users SET totp_enabled=false WHERE id=$1', [a.id]);
    const r = await onlyRemember(ip, art, '/admin');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/admin\/login$/);
    const b = await makeAdmin();
    const d2 = await fullAdminLogin(b);
    await pool.query('UPDATE users SET is_banned=true WHERE id=$1', [b.id]);
    const r2 = await onlyRemember(d2.ip, cookieValue(d2.done, 'livo_art'), '/admin');
    expect(r2.headers.location).toMatch(/^\/admin\/login$/);
  });

  test('পুরনো (রোটেটেড) টোকেন পুনর্ব্যবহার = চুরির সংকেত, family বাতিল', async () => {
    const old = process.env.REFRESH_REUSE_GRACE_SECONDS;
    process.env.REFRESH_REUSE_GRACE_SECONDS = '0';
    try {
      const a = await makeAdmin();
      const { done, ip } = await fullAdminLogin(a);
      const art1 = cookieValue(done, 'livo_art');
      const r1 = await onlyRemember(ip, art1, '/admin');
      const art2 = cookieValue(r1, 'livo_art');
      await new Promise((r) => setTimeout(r, 30));
      const stolen = await onlyRemember(ip, art1, '/admin');
      expect(stolen.headers.location).toMatch(/^\/admin\/login$/);
      const legit = await onlyRemember(ip, art2, '/admin');
      expect(legit.headers.location).toMatch(/^\/admin\/login$/);
    } finally {
      if (old === undefined) delete process.env.REFRESH_REUSE_GRACE_SECONDS; else process.env.REFRESH_REUSE_GRACE_SECONDS = old;
    }
  });

  test('ইউজার-কুকি (livo_rt) বা অন্য kind-এর টোকেন অ্যাডমিন কুকি হিসেবে চলে না', async () => {
    const { agent, token, ip } = await getCsrfAgent('/register');
    const reg = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username: uniqueUsername(), phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const userRt = cookieValue(reg, 'livo_rt');
    const r = await onlyRemember(ip, userRt, '/admin');
    expect(r.headers.location).toMatch(/^\/admin\/login$/);
  });

  test('লগআউটে admin remember বাতিল হয়', async () => {
    const a = await makeAdmin();
    const { done, ip, agent } = await fullAdminLogin(a);
    const art = cookieValue(done, 'livo_art');
    const page = await agent.get('/admin');
    const csrf = extractCsrfToken(page.text);
    const out = await agent.post('/admin/logout').set('User-Agent', REALISTIC_UA).type('form').send({ _csrf: csrf });
    expect(out.status).toBe(302);
    expect(cookieLine(out, 'livo_art')).toMatch(/livo_art=;/);
    const r = await onlyRemember(ip, art, '/admin');
    expect(r.headers.location).toMatch(/^\/admin\/login$/);
  });
});
