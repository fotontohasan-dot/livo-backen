// tests/security/adminReferralCommission.test.js
// K9b — অ্যাডমিন সেটিংসের "রেফারেল কমিশন (বাজির ওপর)" সেকশন:
// referral_bet_commission_enabled ও referral_commission_tier1/2/3_percent (আসল PostgreSQL, আসল Express app)
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const rbac = require('../../services/rbac');

const KEYS = ['referral_bet_commission_enabled', 'referral_commission_tier1_percent',
  'referral_commission_tier2_percent', 'referral_commission_tier3_percent'];

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
  const role = await rbac.createRole({ name: `RC ${uniqueUsername()}`, permissions });
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

describe('অ্যাডমিন সেটিংস — রেফারেল কমিশন (বাজির ওপর)', () => {
  const saved = {};
  beforeAll(async () => { for (const k of KEYS) saved[k] = await getSetting(k); });
  afterAll(async () => {
    for (const k of KEYS) {
      if (saved[k] === null) await pool.query('DELETE FROM site_settings WHERE key=$1', [k]);
      else await setSetting(k, saved[k]);
    }
  });
  beforeEach(async () => {
    await setSetting('referral_bet_commission_enabled', 'false');
    await setSetting('referral_commission_tier1_percent', '1');
    await setSetting('referral_commission_tier2_percent', '0.5');
    await setSetting('referral_commission_tier3_percent', '0.25');
  });

  test('সেভ সফল — সুইচ ও তিন tier বদলায়', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    const res = await post(a, {
      referral_bet_commission_enabled: 'true',
      referral_commission_tier1_percent: '3', referral_commission_tier2_percent: '2.5',
      referral_commission_tier3_percent: '10'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('saved=1');
    expect(await getSetting('referral_bet_commission_enabled')).toBe('true');
    expect(await getSetting('referral_commission_tier1_percent')).toBe('3');
    expect(await getSetting('referral_commission_tier2_percent')).toBe('2.5');
    expect(await getSetting('referral_commission_tier3_percent')).toBe('10');
  });

  test.each([['-1'], ['11'], ['abc'], [''], ['1.234'], ['10.01']])(
    'অবৈধ মান %p প্রত্যাখ্যাত — কিছুই সেভ হয় না', async (bad) => {
      const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
      for (const key of ['referral_commission_tier1_percent', 'referral_commission_tier2_percent', 'referral_commission_tier3_percent']) {
        const body = {
          referral_bet_commission_enabled: 'true',
          referral_commission_tier1_percent: '4', referral_commission_tier2_percent: '4',
          referral_commission_tier3_percent: '4'
        };
        body[key] = bad;
        const res = await post(a, { ...body, site_name: 'ShouldNotSave' });
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('error=1');
        expect(await getSetting('referral_bet_commission_enabled')).toBe('false');
        expect(await getSetting('referral_commission_tier1_percent')).toBe('1');
        expect(await getSetting('referral_commission_tier2_percent')).toBe('0.5');
        expect(await getSetting('referral_commission_tier3_percent')).toBe('0.25');
        expect(await getSetting('site_name')).not.toBe('ShouldNotSave');
      }
    });

  test('সীমা: ০ ও ১০ গ্রহণযোগ্য', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    const res = await post(a, {
      referral_commission_tier1_percent: '0', referral_commission_tier2_percent: '10',
      referral_commission_tier3_percent: '0.01'
    });
    expect(res.headers.location).toContain('saved=1');
    expect(await getSetting('referral_commission_tier1_percent')).toBe('0');
    expect(await getSetting('referral_commission_tier2_percent')).toBe('10');
    expect(await getSetting('referral_commission_tier3_percent')).toBe('0.01');
  });

  test('অ্যাডমিন নয় এমন ইউজার ব্লক — কিছু বদলায় না', async () => {
    const u = await makeUser();
    const res = await post(u, { referral_bet_commission_enabled: 'true', referral_commission_tier1_percent: '9' });
    expect([302, 403]).toContain(res.status);
    expect(res.headers.location || '').not.toContain('saved=1');
    expect(await getSetting('referral_bet_commission_enabled')).toBe('false');
    expect(await getSetting('referral_commission_tier1_percent')).toBe('1');
  });

  test('settings_edit ছাড়া (শুধু bonus_manage) কমিশন সেটিং বদলায় না', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true, settings_view: true });
    await post(a, { referral_bet_commission_enabled: 'true', referral_commission_tier1_percent: '9' });
    expect(await getSetting('referral_bet_commission_enabled')).toBe('false');
    expect(await getSetting('referral_commission_tier1_percent')).toBe('1');
  });

  test.each([['on'], ['1'], ['TRUE'], ['yes'], ['abc'], ['']])(
    "'true' ছাড়া অন্য কিছু (%p) সেভ হলে 'false' লেখা হয়", async (v) => {
      await setSetting('referral_bet_commission_enabled', 'true');
      const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
      const res = await post(a, { referral_bet_commission_enabled: v });
      expect(res.headers.location).toContain('saved=1');
      expect(await getSetting('referral_bet_commission_enabled')).toBe('false');
    });

  test('ফর্মের hidden false + checkbox true একসাথে এলে true সেভ হয়', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    const res = await a.agent.post('/admin/settings/update').type('form')
      .send('_csrf=' + encodeURIComponent(a.token) +
        '&referral_bet_commission_enabled=false&referral_bet_commission_enabled=true');
    expect(res.headers.location).toContain('saved=1');
    expect(await getSetting('referral_bet_commission_enabled')).toBe('true');
  });

  test('সারি না থাকলে ডিফল্ট দেখা যায় (বন্ধ ও ০)', async () => {
    await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [KEYS]);
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    expect(page.status).toBe(200);
    expect(inputValue(page.text, 'referral_commission_tier1_percent')).toBe('0');
    expect(inputValue(page.text, 'referral_commission_tier2_percent')).toBe('0');
    expect(inputValue(page.text, 'referral_commission_tier3_percent')).toBe('0');
    expect(page.text).toMatch(/type="checkbox" name="referral_bet_commission_enabled" value="true"\s*class=/);
    expect(page.text).not.toMatch(/name="referral_bet_commission_enabled" value="true" checked/);
  });

  test('চালু অবস্থায় পাতায় চেকবক্স checked ও সংরক্ষিত মান দেখা যায়', async () => {
    await setSetting('referral_bet_commission_enabled', 'true');
    await setSetting('referral_commission_tier2_percent', '2.5');
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    expect(page.text).toMatch(/name="referral_bet_commission_enabled" value="true" checked/);
    expect(inputValue(page.text, 'referral_commission_tier2_percent')).toBe('2.5');
  });

  test('অডিট লগ: গেট বদলালে SETTING_CHANGE এন্ট্রি লেখা হয়', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    await post(a, { referral_bet_commission_enabled: 'true' });
    const r = await pool.query(
      "SELECT 1 FROM admin_logs WHERE action_type='SETTING_CHANGE' AND details LIKE '%referral_bet_commission_enabled%' LIMIT 1");
    expect(r.rowCount).toBeGreaterThan(0);
  });

  test('bn ও en লেবেল/নোট/সতর্কতা আছে', () => {
    const bn = require('../../locales/bn.json');
    const en = require('../../locales/en.json');
    for (const k of ['adms_ref_bet_commission_section', 'adms_ref_bet_commission_enabled', 'adms_ref_bet_commission_warning',
      'adms_ref_tier1_percent', 'adms_ref_tier2_percent', 'adms_ref_tier3_percent', 'adms_ref_tier_hint', 'admin_referral_tier_invalid']) {
      expect(bn[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
      expect(bn[k]).not.toBe(en[k]);
    }
  });
});
