// স্থায়ী সেশন — আসল HTTP + Postgres এন্ড-টু-এন্ড টেস্ট।
const { getCsrfAgent, uniqueUsername, uniquePhone, freshRequest, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');

function cookieValue(res, name) {
  const list = res.headers['set-cookie'] || [];
  const line = list.find((c) => c.startsWith(name + '='));
  return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : null;
}
function setCookieLine(res, name) {
  return (res.headers['set-cookie'] || []).find((c) => c.startsWith(name + '=')) || '';
}

async function registerUser() {
  const { agent, token, ip } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const res = await agent.post('/register').type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  expect(res.status).toBe(302);
  return { res, ip, username };
}

// শুধু রিফ্রেশ কুকি পাঠায় — সেশন কুকি "হারিয়ে গেছে" সিমুলেট করতে
function withOnlyRefresh(ip, rt, path = '/profile') {
  return freshRequest(ip).get(path).set('Cookie', `livo_rt=${rt}`);
}

describe('Persistent session (refresh token)', () => {
  const OLD_GRACE = process.env.REFRESH_REUSE_GRACE_SECONDS;
  afterAll(() => { process.env.REFRESH_REUSE_GRACE_SECONDS = OLD_GRACE; if (OLD_GRACE === undefined) delete process.env.REFRESH_REUSE_GRACE_SECONDS; });

  test('রেজিস্ট্রেশনে HttpOnly, SameSite=Lax রিফ্রেশ কুকি বসে; DB-তে শুধু হ্যাশ থাকে', async () => {
    const { res } = await registerUser();
    const rt = cookieValue(res, 'livo_rt');
    expect(rt).toMatch(/^[a-f0-9]{64}$/);
    const line = setCookieLine(res, 'livo_rt');
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    const db = await pool.query('SELECT token_hash FROM refresh_tokens WHERE token_hash = $1', [require('../utils/tokens').hashToken(rt)]);
    expect(db.rows.length).toBe(1);
    const raw = await pool.query('SELECT 1 FROM refresh_tokens WHERE token_hash = $1', [rt]);
    expect(raw.rows.length).toBe(0);
  });

  test('সেশন কুকি ছাড়া শুধু রিফ্রেশ কুকি দিয়ে নিঃশব্দে লগইন ফিরে আসে এবং টোকেন রোটেট হয়', async () => {
    const { res, ip } = await registerUser();
    const rt1 = cookieValue(res, 'livo_rt');

    const back = await withOnlyRefresh(ip, rt1);
    expect(back.status).toBe(200); // /login-এ redirect নয়
    const rt2 = cookieValue(back, 'livo_rt');
    expect(rt2).toMatch(/^[a-f0-9]{64}$/);
    expect(rt2).not.toBe(rt1);
    expect(cookieValue(back, 'connect.sid')).toBeTruthy(); // নতুন সেশন কুকিও
  });

  test('রোটেট হওয়া পুরনো টোকেন পুনর্ব্যবহার করলে (grace-এর পরে) পুরো family বাতিল হয়', async () => {
    process.env.REFRESH_REUSE_GRACE_SECONDS = '0';
    const { res, ip } = await registerUser();
    const rt1 = cookieValue(res, 'livo_rt');
    const back = await withOnlyRefresh(ip, rt1);
    const rt2 = cookieValue(back, 'livo_rt');
    await new Promise((r) => setTimeout(r, 30));

    const stolen = await withOnlyRefresh(ip, rt1);          // আক্রমণকারী পুরনো টোকেন চালায়
    expect(stolen.status).toBe(302);
    expect(stolen.headers.location).toMatch(/\/login/);

    const legit = await withOnlyRefresh(ip, rt2);           // family বাতিল, তাই নতুনটাও আর চলে না
    expect(legit.status).toBe(302);
    expect(legit.headers.location).toMatch(/\/login/);
  });

  test('লগআউটের পর রিফ্রেশ কুকি দিয়ে আর ঢোকা যায় না', async () => {
    const { agent, token, ip } = await getCsrfAgent('/register');
    const reg = await agent.post('/register').type('form')
      .send({ username: uniqueUsername(), phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const rt = cookieValue(reg, 'livo_rt');
    expect(rt).toBeTruthy();

    const page = await agent.get('/profile');
    const csrf = (/<meta name="csrf-token" content="([^"]*)"/.exec(page.text) || [])[1];
    const out = await agent.post('/logout').type('form').send({ _csrf: csrf });
    expect(out.status).toBe(302);
    expect(setCookieLine(out, 'livo_rt')).toMatch(/livo_rt=;/);

    const after = await withOnlyRefresh(ip, rt);
    expect(after.status).toBe(302);
    expect(after.headers.location).toMatch(/\/login/);
  });

  test('POST /auth/refresh: সেশন ছাড়া 401/403, সেশন + CSRF থাকলে ok', async () => {
    const anon = await freshRequest().post('/auth/refresh');
    expect([401, 403]).toContain(anon.status);

    const { agent, token } = await getCsrfAgent('/register');
    await agent.post('/register').type('form')
      .send({ username: uniqueUsername(), phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const page = await agent.get('/profile');
    const csrf = (/<meta name="csrf-token" content="([^"]*)"/.exec(page.text) || [])[1];

    const noCsrf = await agent.post('/auth/refresh');
    expect(noCsrf.status).toBe(403);

    const ok = await agent.post('/auth/refresh').set('X-CSRF-Token', csrf);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.persistent).toBe(true);
  });

  test('ব্যান করা ইউজার রিফ্রেশ কুকি দিয়ে ফিরে আসতে পারে না', async () => {
    const { res, ip, username } = await registerUser();
    const rt = cookieValue(res, 'livo_rt');
    await pool.query('UPDATE users SET is_banned = TRUE WHERE username = $1', [username]);
    const back = await withOnlyRefresh(ip, rt);
    expect(back.status).toBe(302);
    expect(back.headers.location).toMatch(/\/login/);
  });

  test('অবৈধ/জাল কুকি নিরীহভাবে উপেক্ষিত হয়', async () => {
    const r = await freshRequest().get('/profile').set('Cookie', `livo_rt=${'f'.repeat(64)}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/\/login/);
    const junk = await freshRequest().get('/login').set('Cookie', 'livo_rt=not-a-token');
    expect(junk.status).toBe(200);
  });
});
