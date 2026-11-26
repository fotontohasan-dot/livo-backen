// tests/security/adminReferralLossCap.test.js
// K9c — অ্যাডমিন সেটিংসে referral_loss_commission_percent (০–১০), referral_bonus_cap (১০০–১,০০,০০০) ও slab টেবিল (শুধু-পড়া)
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const rbac = require('../../services/rbac');
const rr = require('../../services/referralRewards');

const KEYS = ['referral_loss_commission_percent', 'referral_bonus_cap', 'referral_slabs'];

async function makeUser({ admin = false, roleKey = null } = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  if (admin) await pool.query("UPDATE users SET role='admin' WHERE username=$1", [username]);
  if (roleKey) await pool.query('UPDATE users SET role_key=$1 WHERE username=$2', [roleKey, username]);
  return { agent, token, username };
}
async function makeRoleAdmin(permissions) {
  const role = await rbac.createRole({ name: `LC ${uniqueUsername()}`, permissions });
  return makeUser({ admin: true, roleKey: role.key });
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

describe('অ্যাডমিন সেটিংস — লস-কমিশন %, বোনাস ক্যাপ ও slab টেবিল (K9c)', () => {
  const saved = {};
  beforeAll(async () => { for (const k of KEYS) saved[k] = await getSetting(k); });
  afterAll(async () => {
    for (const k of KEYS) {
      if (saved[k] === null) await pool.query('DELETE FROM site_settings WHERE key=$1', [k]);
      else await setSetting(k, saved[k]);
    }
  });
  beforeEach(async () => {
    await setSetting('referral_loss_commission_percent', '0.8');
    await setSetting('referral_bonus_cap', '1000');
  });

  test('সেভ সফল — দুই মানই বদলায় (INSERT ... ON CONFLICT) ও অডিট লগ লেখা হয়', async () => {
    await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [['referral_loss_commission_percent', 'referral_bonus_cap']]);
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    const res = await post(a, { referral_loss_commission_percent: '2.5', referral_bonus_cap: '5000' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('saved=1');
    expect(await getSetting('referral_loss_commission_percent')).toBe('2.5');
    expect(await getSetting('referral_bonus_cap')).toBe('5000');
    const r = await pool.query(
      "SELECT 1 FROM admin_logs WHERE action_type='SETTING_CHANGE' AND details LIKE '%referral_loss_commission_percent%' LIMIT 1");
    expect(r.rowCount).toBeGreaterThan(0);
  });

  test('দ্বিতীয় সেভে ON CONFLICT আপডেট কাজ করে', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    await post(a, { referral_loss_commission_percent: '1', referral_bonus_cap: '200' });
    await post(a, { referral_loss_commission_percent: '10', referral_bonus_cap: '100000' });
    expect(await getSetting('referral_loss_commission_percent')).toBe('10');
    expect(await getSetting('referral_bonus_cap')).toBe('100000');
  });

  test.each([['-1'], ['11'], ['99'], ['100001'], ['abc'], [''], ['1.234']])(
    'অবৈধ মান %p প্রত্যাখ্যাত — কিছুই সেভ হয় না', async (bad) => {
      const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
      for (const key of ['referral_loss_commission_percent', 'referral_bonus_cap']) {
        const body = { referral_loss_commission_percent: '3', referral_bonus_cap: '500' };
        body[key] = bad;
        const res = await post(a, { ...body, site_name: 'ShouldNotSave' });
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('error=1');
        expect(await getSetting('referral_loss_commission_percent')).toBe('0.8');
        expect(await getSetting('referral_bonus_cap')).toBe('1000');
        expect(await getSetting('site_name')).not.toBe('ShouldNotSave');
      }
    });

  test('ক্যাপ ৯৯ ও কমিশন ১০.০১ প্রত্যাখ্যাত; সীমা ০, ১০, ১০০ গ্রহণযোগ্য', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    let res = await post(a, { referral_loss_commission_percent: '10.01', referral_bonus_cap: '500' });
    expect(res.headers.location).toContain('error=1');
    res = await post(a, { referral_loss_commission_percent: '5', referral_bonus_cap: '99' });
    expect(res.headers.location).toContain('error=1');
    res = await post(a, { referral_loss_commission_percent: '0', referral_bonus_cap: '100' });
    expect(res.headers.location).toContain('saved=1');
    expect(await getSetting('referral_loss_commission_percent')).toBe('0');
    expect(await getSetting('referral_bonus_cap')).toBe('100');
  });

  test('পুরোনো সংরক্ষিত মান (সীমার বাইরে) অপরিবর্তিত পাঠালে অন্য সেটিং সেভ আটকায় না', async () => {
    await setSetting('referral_loss_commission_percent', '15');
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    const res = await post(a, { referral_loss_commission_percent: '15', referral_bonus_cap: '1000' });
    expect(res.headers.location).toContain('saved=1');
    expect(await getSetting('referral_loss_commission_percent')).toBe('15');
    const bad = await post(a, { referral_loss_commission_percent: '16' });
    expect(bad.headers.location).toContain('error=1');
  });

  test('অ্যাডমিন নয় এমন ইউজার ব্লক — কিছু বদলায় না', async () => {
    const u = await makeUser();
    const res = await post(u, { referral_loss_commission_percent: '5', referral_bonus_cap: '900' });
    expect([302, 403]).toContain(res.status);
    expect(res.headers.location || '').not.toContain('saved=1');
    expect(await getSetting('referral_loss_commission_percent')).toBe('0.8');
    expect(await getSetting('referral_bonus_cap')).toBe('1000');
  });

  test('settings_edit ছাড়া (শুধু bonus_manage) বদলায় না', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true, settings_view: true });
    await post(a, { referral_loss_commission_percent: '5', referral_bonus_cap: '900' });
    expect(await getSetting('referral_loss_commission_percent')).toBe('0.8');
    expect(await getSetting('referral_bonus_cap')).toBe('1000');
  });

  test('CSRF টোকেন ছাড়া সেভ হয় না', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    const res = await a.agent.post('/admin/settings/update').type('form')
      .send({ referral_loss_commission_percent: '5', referral_bonus_cap: '900' });
    expect(res.headers.location || '').not.toContain('saved=1');
    expect(await getSetting('referral_loss_commission_percent')).toBe('0.8');
  });

  test('সারি না থাকলে ডিফল্ট দেখা যায় (০.৮ ও ১০০০)', async () => {
    await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [KEYS]);
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    expect(page.status).toBe(200);
    expect(inputValue(page.text, 'referral_loss_commission_percent')).toBe('0.8');
    expect(inputValue(page.text, 'referral_bonus_cap')).toBe('1000');
  });

  test('সংরক্ষিত ০ হলে ০-ই দেখায় (০.৮ নয়); দুটি ফিল্ড একবারই আছে', async () => {
    await setSetting('referral_loss_commission_percent', '0');
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    expect(inputValue(page.text, 'referral_loss_commission_percent')).toBe('0');
    expect((page.text.match(/name="referral_loss_commission_percent"/g) || []).length).toBe(1);
    expect((page.text.match(/name="referral_bonus_cap"/g) || []).length).toBe(1);
  });

  test('slab টেবিল দেখা যায় (ডিফল্ট) — ইনপুট নয়', async () => {
    await pool.query("DELETE FROM site_settings WHERE key='referral_slabs'");
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    expect(page.text).toContain('id="referralSlabTable"');
    const table = page.text.split('id="referralSlabTable"')[1].split('</table>')[0];
    expect((table.match(/data-slab-min/g) || []).length).toBe(rr.DEFAULT_SLABS.length);
    for (const s of rr.DEFAULT_SLABS) {
      expect(table).toContain('data-slab-min>' + s.min + '<');
      expect(table).toContain('data-slab-amount>' + s.amount + '<');
    }
    expect(table).not.toMatch(/<input|<textarea/);
  });

  test('slab টেবিল referral_slabs সেটিং থেকে আসে', async () => {
    await setSetting('referral_slabs', JSON.stringify([{ min: 777, amount: 11 }, { min: 888, amount: 22 }]));
    const a = await makeRoleAdmin({ settings_view: true });
    const page = await a.agent.get('/admin/settings');
    const table = page.text.split('id="referralSlabTable"')[1].split('</table>')[0];
    expect(table).toContain('data-slab-min>777<');
    expect(table).toContain('data-slab-amount>22<');
  });

  test('bn ও en লেবেল/নোট আছে', () => {
    const bn = require('../../locales/bn.json');
    const en = require('../../locales/en.json');
    for (const k of ['adms_ref_losscap_section', 'adms_ref_loss_percent', 'adms_ref_loss_percent_note', 'adms_ref_bonus_cap_label',
      'adms_ref_bonus_cap_note', 'adms_ref_slab_table_title', 'adms_ref_slab_min', 'adms_ref_slab_amount',
      'adms_ref_slab_table_note', 'admin_referral_loss_cap_invalid']) {
      expect(bn[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
      expect(bn[k]).not.toBe(en[k]);
    }
  });
});
