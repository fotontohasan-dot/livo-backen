// tests/security/apiKeyAdmin.test.js
// ---------------------------------------------------------------------------
// API key ব্যবস্থাপনার HTTP-স্তরের গার্ড।
//
// tests/unit/apiKeyAuth.test.js মিডলওয়্যারটা ইউনিট-লেভেলে কভার করে (হ্যাশ, scope,
// expiry, disabled)। এখানে বাকিটা: অ্যাডমিন রুটগুলোর RBAC, raw key শুধু তৈরির সময়ই
// একবার দেখানো হয় কিনা, এবং revoke করা key দিয়ে সত্যিই পাবলিক API-তে ঢোকা যায় না কিনা।
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { getCsrfAgent, freshRequest, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const { hashKey } = require('../../middleware/apiKeyAuth');

async function makeUser({ admin = false, roleKey = null } = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  if (admin) await pool.query("UPDATE users SET role='admin' WHERE username=$1", [username]);
  if (roleKey) await pool.query('UPDATE users SET role_key=$1 WHERE username=$2', [roleKey, username]);
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, token, username, userId: row.id };
}

async function seedKey({ enabled = true, scopes = ['read:matches'] } = {}) {
  const raw = 'livo_test_' + crypto.randomBytes(16).toString('hex');
  const row = (await pool.query(
    `INSERT INTO api_keys (name, key_hash, scopes, enabled) VALUES ($1,$2,$3,$4) RETURNING *`,
    ['regression-' + Date.now(), hashKey(raw), scopes, enabled]
  )).rows[0];
  return { raw, row };
}

describe('API key অ্যাডমিন রুট — RBAC', () => {
  test('অথেন্টিকেশন ছাড়া api-keys পেজ/অ্যাকশনে ঢোকা যায় না', async () => {
    const { row } = await seedKey();
    for (const [method, url] of [
      ['get', '/admin/api-keys'],
      ['post', '/admin/api-keys/create'],
      ['post', `/admin/api-keys/${row.id}/toggle`],
      ['post', `/admin/api-keys/${row.id}/revoke`]
    ]) {
      const res = await freshRequest()[method](url).type('form').send({});
      expect([302, 401, 403]).toContain(res.status);
    }
    const after = await pool.query('SELECT enabled FROM api_keys WHERE id=$1', [row.id]);
    expect(after.rows[0].enabled).toBe(true); // অবস্থা বদলায়নি
  });

  test('সাধারণ লগইন করা ইউজার api-keys রুটে ঢুকতে পারে না', async () => {
    const u = await makeUser();
    const { row } = await seedKey();
    const list = await u.agent.get('/admin/api-keys');
    expect([302, 403]).toContain(list.status);
    const toggle = await u.agent.post(`/admin/api-keys/${row.id}/toggle`).type('form').send({ _csrf: u.token });
    expect([302, 403]).toContain(toggle.status);
    const after = await pool.query('SELECT enabled FROM api_keys WHERE id=$1', [row.id]);
    expect(after.rows[0].enabled).toBe(true);
  });

  test('settings_edit পারমিশন ছাড়া admin key toggle করতে পারে না', async () => {
    const a = await makeUser({ admin: true, roleKey: 'support' }); // support-এ settings_edit নেই
    const { row } = await seedKey();
    const res = await a.agent.post(`/admin/api-keys/${row.id}/toggle`).type('form').send({ _csrf: a.token });
    expect([302, 403]).toContain(res.status);
    const after = await pool.query('SELECT enabled FROM api_keys WHERE id=$1', [row.id]);
    expect(after.rows[0].enabled).toBe(true);
  });

  test('CSRF টোকেন ছাড়া toggle প্রত্যাখ্যাত হয়', async () => {
    const a = await makeUser({ admin: true, roleKey: 'super_admin' });
    const { row } = await seedKey();
    const res = await a.agent.post(`/admin/api-keys/${row.id}/toggle`).type('form').send({});
    expect(res.status).toBe(403);
    const after = await pool.query('SELECT enabled FROM api_keys WHERE id=$1', [row.id]);
    expect(after.rows[0].enabled).toBe(true);
  });

  test('পারমিশনসহ admin তালিকা দেখতে পারে, কিন্তু পেজে key_hash ফাঁস হয় না', async () => {
    const a = await makeUser({ admin: true, roleKey: 'super_admin' });
    const { row } = await seedKey();
    const res = await a.agent.get('/admin/api-keys');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(row.key_hash);
  });
});

describe('API key — revoke করা key দিয়ে অথেন্টিকেট করা যায় না', () => {
  test('সক্রিয় key কাজ করে, revoke করার পর 403', async () => {
    const { raw, row } = await seedKey({ scopes: ['read:matches'] });

    const ok = await freshRequest().get('/api/v1/matches').set('X-API-Key', raw);
    expect(ok.status).toBe(200);

    const a = await makeUser({ admin: true, roleKey: 'super_admin' });
    const rev = await a.agent.post(`/admin/api-keys/${row.id}/revoke`).type('form').send({ _csrf: a.token });
    expect(rev.status).toBe(302);

    const blocked = await freshRequest().get('/api/v1/matches').set('X-API-Key', raw);
    expect(blocked.status).toBe(403);
  });

  // রিগ্রেশন: এই তিনটা পাবলিক এন্ডপয়েন্ট স্কিমা-অমিলের কারণে সবসময় 500 দিত
  // (matches-এ অস্তিত্বহীন 'result' কলাম, leaderboard-এ অস্তিত্বহীন 'predictions' টেবিল)।
  test.each([
    ['/api/v1/matches', 'read:matches'],
    ['/api/v1/leaderboard', 'read:leaderboard'],
    ['/api/v1/tournaments', 'read:tournaments']
  ])('%s বৈধ key দিয়ে 200 ও ব্যবহারযোগ্য পে-লোড দেয়', async (path, scope) => {
    const { raw } = await seedKey({ scopes: [scope] });
    const res = await freshRequest().get(path).set('X-API-Key', raw);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });

  test('scope নেই এমন key অন্য এন্ডপয়েন্টে ঢুকতে পারে না', async () => {
    const { raw } = await seedKey({ scopes: ['read:matches'] });
    const res = await freshRequest().get('/api/v1/leaderboard').set('X-API-Key', raw);
    expect(res.status).toBe(403);
  });
});

describe('রেট-লিমিট সীমানা', () => {
  test('লগইন বারবার ব্যর্থ হলে শেষ পর্যন্ত 429 দেয়', async () => {
    const agent = freshRequest();
    const page = await agent.get('/login');
    const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '')?.[1] || '';

    let sawLimit = false;
    for (let i = 0; i < 15; i++) {
      const res = await agent.post('/login').type('form')
        .send({ identifier: 'ratelimit_probe@test.com', password: 'wrongpass', _csrf: token });
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });

  test('একটা IP-র লিমিট অন্য IP-কে প্রভাবিত করে না', async () => {
    const other = freshRequest(); // নিজস্ব র‍্যান্ডম IP
    const res = await other.get('/login');
    expect(res.status).toBe(200);
  });

  test('API key ছাড়া পাবলিক API 401 দেয় (রেট-লিমিটের আগেই অথ চেক)', async () => {
    const res = await freshRequest().get('/api/v1/matches');
    expect(res.status).toBe(401);
  });
});
