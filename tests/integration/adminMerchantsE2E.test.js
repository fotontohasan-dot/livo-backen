// tests/integration/adminMerchantsE2E.test.js
// ---------------------------------------------------------------------------
// মার্চেন্ট ম্যানেজমেন্ট — আসল অ্যাপের ভেতর দিয়ে এন্ড-টু-এন্ড: আসল লগইন-সেশন, আসল
// admin-layout/সাইডবার, গ্লোবাল CSRF ও app.js-এর মাউন্ট। (tests/integration/
// adminMerchants.test.js রাউটারের লজিক আলাদাভাবে যাচাই করে; এটা "জোড়া লাগার" পরীক্ষা।)
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const en = require('../../locales/en.json');

const CODE = 'E2E' + Date.now().toString(36).toUpperCase().slice(-5);
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

beforeAll(async () => {
  admin = await makeUser('admin');
  plain = await makeUser(null);
  await admin.agent.get('/lang/en');
});

afterAll(async () => {
  await pool.query('DELETE FROM merchants WHERE code LIKE $1 AND parent_id IS NOT NULL', [CODE + '%']);
  await pool.query('DELETE FROM merchants WHERE code LIKE $1', [CODE + '%']);
  const ids = [admin.userId, plain.userId];
  await pool.query('DELETE FROM admin_logs WHERE admin_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM audit_logs WHERE actor_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM activity_logs WHERE user_id = ANY($1)', [ids]).catch(() => {});
});

describe('মার্চেন্ট ম্যানেজমেন্ট — আসল অ্যাপে', () => {
  test('অ্যাডমিন পেজ খোলে: আসল লেআউট, সাইডবারে নেভ-এন্ট্রি, লিস্ট ও ফর্ম', async () => {
    const res = await admin.agent.get('/admin/merchants');
    expect(res.status).toBe(200);
    expect(res.text).toContain(en.merchant_title);
    expect(res.text).toContain('href="/admin/merchants"');            // সাইডবার লিংক
    expect(res.text).toContain(en.admin_nav_item_merchants);
    expect(res.text).toContain('action="/admin/merchants"');          // তৈরির ফর্ম
  });

  test('সাধারণ ইউজার পেজ দেখতে পায় না', async () => {
    const res = await plain.agent.get('/admin/merchants');
    expect([302, 303, 401, 403, 404]).toContain(res.status);
    expect(res.text || '').not.toContain(en.merchant_title);
  });

  test('CSRF ছাড়া POST প্রত্যাখ্যাত; টোকেনসহ মার্চেন্ট ও সাব-মার্চেন্ট তৈরি হয় এবং লিস্টে দেখা যায়', async () => {
    const noToken = await admin.agent.post('/admin/merchants').type('form').send({ code: CODE + 'X', name: 'NoCsrf' });
    expect([403, 302]).toContain(noToken.status);
    expect((await pool.query('SELECT 1 FROM merchants WHERE code=$1', [CODE + 'X'])).rows.length).toBe(0);

    const page = await admin.agent.get('/admin/merchants');
    const token = extractCsrfToken(page.text);
    expect(token).toBeTruthy();

    let res = await admin.agent.post('/admin/merchants').type('form')
      .send({ code: CODE + 'P', name: 'E2E Parent', commission_rate: '3', _csrf: token });
    expect(res.status).toBe(302);
    const parent = (await pool.query('SELECT id FROM merchants WHERE code=$1', [CODE + 'P'])).rows[0];
    expect(parent).toBeTruthy();

    res = await admin.agent.post('/admin/merchants').type('form')
      .send({ code: CODE + 'S', name: 'E2E Sub', parent_id: String(parent.id), commission_rate: '1.5', _csrf: token });
    expect(res.status).toBe(302);
    const sub = (await pool.query('SELECT parent_id FROM merchants WHERE code=$1', [CODE + 'S'])).rows[0];
    expect(sub.parent_id).toBe(parent.id);

    const list = await admin.agent.get('/admin/merchants').query({ q: CODE });
    expect(list.status).toBe(200);
    expect(list.text).toContain(CODE + 'P');
    expect(list.text).toContain(CODE + 'S');
    expect(list.text).toContain('E2E Sub');
    // সফল ফ্ল্যাশ বার্তা পরের রেন্ডারে এসেছে (flash config-এ)
    expect(list.text).toContain(en.merchant_created);
  });

  test('ইউআই-তে প্যারেন্ট-সহ সারিতে "এডিট" লিংক কাজ করে এবং পূর্বপূরণ করা ফর্ম দেখায়', async () => {
    const m = (await pool.query('SELECT id FROM merchants WHERE code=$1', [CODE + 'S'])).rows[0];
    const res = await admin.agent.get('/admin/merchants').query({ edit: String(m.id) });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`action="/admin/merchants/${m.id}"`);
    expect(res.text).toContain(en.merchant_form_edit);
  });

  test('চক্র ও ডিলিট-সুরক্ষা আসল অ্যাপ দিয়েও কাজ করে', async () => {
    const page = await admin.agent.get('/admin/merchants');
    const token = extractCsrfToken(page.text);
    const p = (await pool.query('SELECT * FROM merchants WHERE code=$1', [CODE + 'P'])).rows[0];
    const s = (await pool.query('SELECT id FROM merchants WHERE code=$1', [CODE + 'S'])).rows[0];

    // প্যারেন্টকে নিজের সাব-মার্চেন্টের নিচে বসানো → প্রত্যাখ্যাত
    await admin.agent.post(`/admin/merchants/${p.id}`).type('form')
      .send({ code: p.code, name: p.name, parent_id: String(s.id), commission_rate: '3', status: 'active', _csrf: token });
    expect((await pool.query('SELECT parent_id FROM merchants WHERE id=$1', [p.id])).rows[0].parent_id).toBeNull();

    // সাব-মার্চেন্ট আছে এমন প্যারেন্ট ডিলিট → প্রত্যাখ্যাত
    await admin.agent.post(`/admin/merchants/${p.id}/delete`).type('form').send({ _csrf: token });
    expect((await pool.query('SELECT 1 FROM merchants WHERE id=$1', [p.id])).rows.length).toBe(1);
  });
});
