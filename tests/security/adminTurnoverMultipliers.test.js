// tests/security/adminTurnoverMultipliers.test.js
// K9a — অ্যাডমিন সেটিংসের "টার্নওভার" সেকশন: turnover_multiplier ও free_bet_turnover_multiplier
// (আসল PostgreSQL, আসল Express app)
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const rbac = require('../../services/rbac');

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
async function makeRoleAdmin(permissions) {
  const role = await rbac.createRole({ name: `TM ${uniqueUsername()}`, permissions });
  const a = await makeUser({ admin: true, roleKey: role.key });
  return { ...a, roleKey: role.key };
}
const setSetting = (k, v) => pool.query(
  `INSERT INTO site_settings (key, value, updated_at) VALUES ($1,$2,NOW())
   ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [k, v]);
const getSetting = async (k) => {
  const r = await pool.query('SELECT value FROM site_settings WHERE key=$1', [k]);
  return r.rows[0] ? r.rows[0].value : null;
};
const post = (a, body) => a.agent.post('/admin/settings/update').type('form').send({ _csrf: a.token, ...body });
const inputValue = (html, name) => {
  const m = html.match(new RegExp('name="' + name + '" value="([^"]*)"'));
  return m ? m[1] : null;
};

describe('অ্যাডমিন সেটিংস — টার্নওভার গুণক', () => {
  let saved;
  beforeAll(async () => {
    saved = { m: await getSetting('turnover_multiplier'), f: await getSetting('free_bet_turnover_multiplier') };
  });
  afterAll(async () => {
    for (const [k, v] of [['turnover_multiplier', saved.m], ['free_bet_turnover_multiplier', saved.f]]) {
      if (v === null) await pool.query('DELETE FROM site_settings WHERE key=$1', [k]);
      else await setSetting(k, v);
    }
  });
  beforeEach(async () => {
    await setSetting('turnover_multiplier', '5');
    await setSetting('free_bet_turnover_multiplier', '3');
  });

  test('সেভ সফল — দুটো মানই বদলায়, পুরোনো সিড সারিও (ON CONFLICT DO UPDATE)', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true, settings_view: true });
    const res = await post(a, { turnover_multiplier: '7', free_bet_turnover_multiplier: '2.5' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('saved=1');
    expect(await getSetting('turnover_multiplier')).toBe('7');
    expect(await getSetting('free_bet_turnover_multiplier')).toBe('2.5');
  });

  test.each([['0'], ['0.9'], ['51'], ['-1'], [''], ['abc'], ['2.55']])(
    'অবৈধ মান %p প্রত্যাখ্যাত — বাংলা এরর, কিছুই সেভ হয় না', async (bad) => {
      const a = await makeRoleAdmin({ bonus_manage: true, settings_view: true });
      for (const key of ['turnover_multiplier', 'free_bet_turnover_multiplier']) {
        const body = { turnover_multiplier: '6', free_bet_turnover_multiplier: '4' };
        body[key] = bad;
        const res = await post(a, { ...body, site_name: 'ShouldNotSave' });
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('error=1');
        expect(await getSetting('turnover_multiplier')).toBe('5');
        expect(await getSetting('free_bet_turnover_multiplier')).toBe('3');
        expect(await getSetting('site_name')).not.toBe('ShouldNotSave');
      }
    });

  test('সীমা: ১ ও ৫০ গ্রহণযোগ্য', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true, settings_view: true });
    expect((await post(a, { turnover_multiplier: '1', free_bet_turnover_multiplier: '50' })).headers.location).toContain('saved=1');
    expect(await getSetting('turnover_multiplier')).toBe('1');
    expect(await getSetting('free_bet_turnover_multiplier')).toBe('50');
  });

  test('অ্যাডমিন নয় এমন ইউজার ব্লক — কিছু বদলায় না', async () => {
    const u = await makeUser();
    const res = await post(u, { turnover_multiplier: '9', free_bet_turnover_multiplier: '9' });
    expect([302, 403]).toContain(res.status);
    expect(res.headers.location || '').not.toContain('saved=1');
    expect(await getSetting('turnover_multiplier')).toBe('5');
    expect(await getSetting('free_bet_turnover_multiplier')).toBe('3');
  });

  test('bonus_manage ছাড়া settings_edit-ওয়ালা গুণক বদলাতে পারে না', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    await post(a, { turnover_multiplier: '9', free_bet_turnover_multiplier: '9' });
    expect(await getSetting('turnover_multiplier')).toBe('5');
    expect(await getSetting('free_bet_turnover_multiplier')).toBe('3');
  });

  test('পাতায় বর্তমান মান দেখা যায় এবং সেকশন আছে', async () => {
    await setSetting('turnover_multiplier', '8');
    await setSetting('free_bet_turnover_multiplier', '4.5');
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    expect(page.status).toBe(200);
    expect(inputValue(page.text, 'turnover_multiplier')).toBe('8');
    expect(inputValue(page.text, 'free_bet_turnover_multiplier')).toBe('4.5');
    expect(page.text.match(/name="turnover_multiplier"/g)).toHaveLength(1);
  });

  test('সারি না থাকলে ডিফল্ট দেখা যায় (৫ ও ৩)', async () => {
    await pool.query("DELETE FROM site_settings WHERE key IN ('turnover_multiplier','free_bet_turnover_multiplier')");
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    expect(inputValue(page.text, 'turnover_multiplier')).toBe('5');
    expect(inputValue(page.text, 'free_bet_turnover_multiplier')).toBe('3');
  });

  test('bn ও en লেবেল/নোট আছে', () => {
    const bn = require('../../locales/bn.json');
    const en = require('../../locales/en.json');
    for (const k of ['adms_turnover_section', 'adms_fb_turnover_mult', 'adms_turnover_mult_note', 'adms_fb_turnover_mult_note', 'admin_turnover_multiplier_invalid']) {
      expect(bn[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
      expect(bn[k]).not.toBe(en[k]);
    }
  });
});
