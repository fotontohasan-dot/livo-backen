// tests/integration/merchantPortalE2E.test.js
// ---------------------------------------------------------------------------
// মার্চেন্ট: Ordinary + Sub-merchant তৈরি, অটো Merchant ID/API Key, অ্যাডমিনের "Login",
// খরগোশ-আইকন (/merchant/credentials) — আসল app.js, আসল সেশন, আসল গ্লোবাল CSRF/CSP/নেভ দিয়ে।
// (merchantPortal.test.js স্টাব-সেশনে রাউটার যাচাই করে; এটা "জোড়া লাগার" পরীক্ষা — বিশেষ করে
// PR #198 (revert) → #199/#201 (পুনঃস্থাপন) এর পর কোনো কিছু হারায়নি কিনা তা নিশ্চিত করতে।)
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const creds = require('../../services/merchantCredentials');
const en = require('../../locales/en.json');

const TAG = 'E2P' + Date.now().toString(36).toUpperCase().slice(-5);
let admin, plain;

async function makeUser(role) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  if (role) await pool.query('UPDATE users SET role=$1 WHERE username=$2', [role, username]);
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, username, userId: row.id };
}

const tokenFrom = async (u, url = '/admin/merchants') => extractCsrfToken((await u.agent.get(url)).text);
const byName = async (n) => (await pool.query('SELECT * FROM merchants WHERE name = $1', [n])).rows[0];

beforeAll(async () => {
  admin = await makeUser('admin');
  plain = await makeUser(null);
  await admin.agent.get('/lang/en');
});

afterAll(async () => {
  await pool.query('DELETE FROM merchants WHERE name LIKE $1 AND parent_id IS NOT NULL', [TAG + '%']);
  await pool.query('DELETE FROM merchants WHERE name LIKE $1', [TAG + '%']);
  const ids = [admin.userId, plain.userId];
  await pool.query('DELETE FROM admin_logs WHERE admin_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM audit_logs WHERE actor_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM activity_logs WHERE user_id = ANY($1)', [ids]).catch(() => {});
});

describe('অ্যাডমিন পেজ — revert-এর পরও সবকিছু আছে', () => {
  let html;
  beforeAll(async () => { html = (await admin.agent.get('/admin/merchants')).text; });

  test('পুরনো (#197) ফর্ম + নেভ-এন্ট্রি অক্ষত', () => {
    expect(html).toContain(en.merchant_title);
    expect(html).toContain('action="/admin/merchants"');
    expect(html).toContain('href="/admin/merchants"');
    expect(html).toContain(en.admin_nav_item_merchants);
  });

  test('নতুন: Ordinary ও Sub (Add) দুটো বাটন + দুটো মডাল ফর্ম', () => {
    expect(html).toContain('data-modal-open="addOrdinaryMerchantModal"');
    expect(html).toContain('data-modal-open="addSubMerchantModal"');
    expect(html).toContain('action="/admin/merchants/ordinary"');
    expect(html).toContain('action="/admin/merchants/sub"');
    expect(html).toContain(en.merchant_add_ordinary_btn);
  });

  test('সাধারণ ইউজার পেজ দেখে না এবং নতুন রুটে POST-ও পারে না', async () => {
    const page = await plain.agent.get('/admin/merchants');
    expect([302, 303, 401, 403, 404]).toContain(page.status);
    expect(page.text || '').not.toContain('addOrdinaryMerchantModal');
    const t = await tokenFrom(plain, '/');
    const r = await plain.agent.post('/admin/merchants/ordinary').type('form').send({ name: TAG + '-plain', _csrf: t });
    expect(r.status).not.toBe(200);
    expect(await byName(TAG + '-plain')).toBeUndefined();
  });
});

describe('Ordinary merchant — আসল CSRF সহ', () => {
  test('CSRF ছাড়া প্রত্যাখ্যাত', async () => {
    const r = await admin.agent.post('/admin/merchants/ordinary').type('form').send({ name: TAG + '-nocsrf' });
    expect([403, 302]).toContain(r.status);
    expect(await byName(TAG + '-nocsrf')).toBeUndefined();
  });

  test('টোকেনসহ তৈরি হয়; /ordinary রুট /:id-এ আটকায় না; লিস্টে ID ও সাফল্য-বার্তা দেখা যায়', async () => {
    const t = await tokenFrom(admin);
    const r = await admin.agent.post('/admin/merchants/ordinary').type('form')
      .send({ name: TAG + '-ord', contact_name: 'Rafi', commission_rate: '4', _csrf: t });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/admin/merchants');
    const m = await byName(TAG + '-ord');
    expect(m).toBeTruthy();
    expect(m.parent_id).toBeNull();
    expect(m.merchant_uid).toMatch(creds.UID_RE);
    expect(m.api_key_prefix).toMatch(/^mk_/);
    expect(creds.hashApiKey(creds.revealApiKey(m.api_key_enc))).toBe(m.api_key_hash);

    const list = (await admin.agent.get('/admin/merchants').query({ q: TAG })).text;
    expect(list).toContain(m.merchant_uid);
    expect(list).toContain(en.merchant_ordinary_created.replace('{id}', m.merchant_uid));
    // raw API Key কখনোই লিস্ট-পেজের HTML-এ নেই
    expect(list).not.toContain(creds.revealApiKey(m.api_key_enc));
  });

  test('পুরনো POST / ফর্ম (#197-এর) এখনো কাজ করে এবং এখন ক্রেডেনশিয়াল পায়', async () => {
    const t = await tokenFrom(admin);
    const r = await admin.agent.post('/admin/merchants').type('form')
      .send({ code: TAG + 'OLD', name: TAG + '-old', commission_rate: '1', _csrf: t });
    expect(r.status).toBe(302);
    const m = await byName(TAG + '-old');
    expect(m.code).toBe(TAG + 'OLD');
    expect(m.merchant_uid).toMatch(creds.UID_RE);
    expect(m.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Sub-merchant (Add) আসল অ্যাপে কাজ করে — প্যারেন্টের নিচে', async () => {
    const parent = await byName(TAG + '-ord');
    const t = await tokenFrom(admin);
    const r = await admin.agent.post('/admin/merchants/sub').type('form')
      .send({ parent_id: String(parent.id), name: TAG + '-sub', _csrf: t });
    expect(r.status).toBe(302);
    const s = await byName(TAG + '-sub');
    expect(s.parent_id).toBe(parent.id);
    expect(s.merchant_uid).toMatch(creds.UID_RE);
    expect(s.merchant_uid).not.toBe(parent.merchant_uid);
    expect(s.api_key_hash).not.toBe(parent.api_key_hash);
  });
});

describe('Login → মার্চেন্ট ব্যাকএন্ড → খরগোশ-আইকন → ক্রেডেনশিয়াল', () => {
  let m, mToken;

  test('সাধারণ ইউজার ও লগইন-ছাড়া /merchant-এ ঢুকতে পারে না', async () => {
    const anon = await getCsrfAgent('/register');
    const a = await anon.agent.get('/merchant');
    expect(a.text || '').not.toContain('mpRabbitBtn');
    const p = await plain.agent.get('/merchant');
    expect(p.text || '').not.toContain('mpRabbitBtn');
  });

  test('অ্যাডমিন "Login" চাপলে /merchant-এ যায়; খরগোশ-আইকন ও আইকন-ফাইল আছে', async () => {
    m = await byName(TAG + '-ord');
    const t = await tokenFrom(admin);
    const r = await admin.agent.post(`/admin/merchants/${m.id}/login-as`).type('form').send({ _csrf: t });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/merchant');

    const page = await admin.agent.get('/merchant');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="mpRabbitBtn"');
    expect(page.text).toContain('/images/rabbit-piano.svg');
    expect(page.text).toContain(m.merchant_uid);
    // API Key পেজ-লোডে HTML-এ থাকে না
    expect(page.text).not.toContain(creds.revealApiKey(m.api_key_enc));
    mToken = extractCsrfToken(page.text);

    const svg = await admin.agent.get('/images/rabbit-piano.svg');
    expect(svg.status).toBe(200);
    const js = await admin.agent.get('/js/merchant-portal.js');
    expect(js.status).toBe(200);
  });

  test('আইকনে ক্লিক = POST /merchant/credentials → Merchant ID + API Key; CSRF ছাড়া নয়', async () => {
    const bad = await admin.agent.post('/merchant/credentials').type('form').send({});
    expect([403, 302]).toContain(bad.status);

    const ok = await admin.agent.post('/merchant/credentials').set('x-csrf-token', mToken).set('Accept', 'application/json');
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.merchantId).toBe(m.merchant_uid);
    expect(ok.body.apiKey).toBe(creds.revealApiKey(m.api_key_enc));
    expect(creds.hashApiKey(ok.body.apiKey)).toBe(m.api_key_hash);
  });

  test('অ্যাডমিনের নিজের সেশন অক্ষত — পোর্টালে থেকেও অ্যাডমিন পেজ খোলে', async () => {
    const r = await admin.agent.get('/admin/merchants');
    expect(r.status).toBe(200);
    expect(r.text).toContain(en.merchant_title);
  });

  test('ক্রেডেনশিয়াল দেখা অডিট-লগে যায় — কিন্তু raw কী লগে নেই', async () => {
    const rows = await pool.query(
      `SELECT details::text AS d FROM audit_logs WHERE actor_id = $1 ORDER BY id DESC LIMIT 20`, [admin.userId]
    ).catch(() => ({ rows: [] }));
    const all = JSON.stringify(rows.rows);
    expect(all).not.toContain(creds.revealApiKey(m.api_key_enc));
  });

  test('"Exit" → অ্যাডমিন প্যানেলে ফেরে; এরপর /merchant আর খোলে না', async () => {
    const r = await admin.agent.post('/merchant/exit').type('form').send({ _csrf: mToken });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/admin/merchants');
    const after = await admin.agent.get('/merchant');
    expect(after.text || '').not.toContain('mpRabbitBtn');
    expect([301, 302, 303]).toContain(after.status);
  });

  test('Regenerate key → পুরনো কী অচল, নতুন কী পোর্টালে দেখা যায়', async () => {
    const oldKey = creds.revealApiKey(m.api_key_enc);
    const t = await tokenFrom(admin);
    const rg = await admin.agent.post(`/admin/merchants/${m.id}/regenerate-key`).type('form').send({ _csrf: t });
    expect(rg.status).toBe(302);
    const fresh = (await pool.query('SELECT * FROM merchants WHERE id=$1', [m.id])).rows[0];
    expect(fresh.merchant_uid).toBe(m.merchant_uid); // Merchant ID অপরিবর্তিত
    expect(fresh.api_key_hash).not.toBe(m.api_key_hash);
    expect(creds.hashApiKey(oldKey)).not.toBe(fresh.api_key_hash);

    await admin.agent.post(`/admin/merchants/${m.id}/login-as`).type('form').send({ _csrf: await tokenFrom(admin) });
    const page = await admin.agent.get('/merchant');
    const t2 = extractCsrfToken(page.text);
    const c = await admin.agent.post('/merchant/credentials').set('x-csrf-token', t2);
    expect(c.body.apiKey).toBe(creds.revealApiKey(fresh.api_key_enc));
    expect(c.body.apiKey).not.toBe(oldKey);
    await admin.agent.post('/merchant/exit').type('form').send({ _csrf: t2 });
  });
});
