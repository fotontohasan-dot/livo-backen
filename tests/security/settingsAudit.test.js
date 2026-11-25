// tests/security/settingsAudit.test.js
// ---------------------------------------------------------------------------
// /admin/settings/update — turnover_* ও বোনাস key-র অডিট লগ + bonus_manage ছাড়া ফ্ল্যাশ বার্তা
// (আসল PostgreSQL, আসল Express app):
//   • বদলানো key-র পুরোনো ও নতুন মান admin_logs-এ থাকে
//   • অপরিবর্তিত মানে লগ নেই
//   • সিক্রেট-জাতীয় key-র মান লগে নেই (শুধু "বদলেছে")
//   • bonus_manage ছাড়া turnover_* পাঠালে চুপচাপ বাদ নয় — ফ্ল্যাশ বার্তা (bn + en)
// ---------------------------------------------------------------------------
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
  const role = await rbac.createRole({ name: `SA ${uniqueUsername()}`, permissions });
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
const logsFor = async (userId, since) =>
  (await pool.query(
    `SELECT action_type, details FROM admin_logs
      WHERE admin_id=$1 AND action_type='SETTING_CHANGE' AND created_at >= $2 ORDER BY id`,
    [userId, since])).rows;
const post = (a, body) => a.agent.post('/admin/settings/update').type('form').send({ _csrf: a.token, ...body });

describe('settings update — বোনাস key অডিট লগ', () => {
  let since;
  beforeEach(async () => {
    since = (await pool.query('SELECT NOW() - interval \'1 second\' AS t')).rows[0].t;
    await setSetting('turnover_multiplier', '5');
    await setSetting('turnover_min_odds', '1.5');
  });

  test('বদলানো key-র লগে পুরোনো ও নতুন মান থাকে', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true });
    const res = await post(a, { turnover_multiplier: '7' });
    expect(res.status).toBe(302);
    expect(await getSetting('turnover_multiplier')).toBe('7');
    const logs = await logsFor(a.userId, since);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toContain('turnover_multiplier');
    expect(logs[0].details).toContain('পুরোনো: 5');
    expect(logs[0].details).toContain('নতুন: 7');
  });

  test('একাধিক key বদলালে প্রতিটার আলাদা লগ; অপরিবর্তিত key-র লগ নেই', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true });
    await post(a, { turnover_multiplier: '9', turnover_min_odds: '1.5' }); // min_odds অপরিবর্তিত
    const logs = await logsFor(a.userId, since);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toContain('turnover_multiplier');
    expect(logs.some(l => l.details.includes('turnover_min_odds'))).toBe(false);
  });

  test('একই মান আবার পাঠালে (5 → "5" / 5.0) কোনো লগ নেই', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true });
    await post(a, { turnover_multiplier: '5', turnover_min_odds: '1.50' });
    expect(await logsFor(a.userId, since)).toHaveLength(0);
  });

  test('সিক্রেট-জাতীয় বোনাস key-র মান লগে যায় না — শুধু "বদলেছে"', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true, settings_edit: true });
    // নোট: সিক্রেট-key রুল isBonusAuditKey-র আওতাভুক্ত key-তে প্রযোজ্য; এখানে সরাসরি সেটিং-ও ছুঁয়ে দেখি
    const SECRET = 'SUPER-SECRET-VALUE-12345';
    const { __test } = require('../../routes/admin');
    expect(__test).toBeTruthy();
    expect(__test.SECRET_SETTING_KEY_RE.test('bonus_api_token')).toBe(true);
    expect(__test.SECRET_SETTING_KEY_RE.test('turnover_multiplier')).toBe(false);
    // বাস্তব রুটে: বোনাস-নামের সিক্রেট key SETTING_KEYS-এ নেই, তাই লগ-বিল্ডারকে সরাসরি যাচাই
    const masked = __test.buildBonusAuditDetail({ key: 'bonus_api_token', oldV: 'old-secret', newV: SECRET, secret: true });
    expect(masked).toContain('বদলেছে');
    expect(masked).not.toContain(SECRET);
    expect(masked).not.toContain('old-secret');
    // এবং আসল লগে (maintenance_bypass_token বোনাস key নয়) আগের আচরণ অপরিবর্তিত
    await post(a, { maintenance_bypass_token: SECRET });
    const all = await pool.query(
      `SELECT details FROM admin_logs WHERE admin_id=$1 AND created_at >= $2`, [a.userId, since]);
    expect(all.rows.some(r => (r.details || '').includes(SECRET))).toBe(false);
  });
});

describe('settings update — bonus_manage ছাড়া turnover_* ফ্ল্যাশ বার্তা', () => {
  beforeEach(async () => { await setSetting('turnover_multiplier', '5'); });

  test('settings_edit-ওয়ালা (bonus_manage নেই) turnover_* বদলাতে চাইলে বার্তা আসে, মান বদলায় না, লগ নেই', async () => {
    const since = (await pool.query('SELECT NOW() - interval \'1 second\' AS t')).rows[0].t;
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    const res = await post(a, { turnover_multiplier: '99', site_name: 'SA Test' });
    expect(res.status).toBe(302);
    expect(await getSetting('turnover_multiplier')).toBe('5');
    const page = await a.agent.get('/admin/settings');
    // ফ্ল্যাশ বার্তা (ইউজারের ভাষা অনুযায়ী bn অথবা en) — key-র নামসহ
    expect(page.text).toMatch(/were not saved|সেভ হয়নি/);
    expect(page.text).toMatch(/turnover_multiplier\)/);
    expect(await logsFor(a.userId, since)).toHaveLength(0);
  });

  test('ফর্মের অপরিবর্তিত মান পাঠালে (সব সেভে যা ঘটে) বিরক্তিকর বার্তা আসে না', async () => {
    const a = await makeRoleAdmin({ settings_edit: true, settings_view: true });
    await post(a, { turnover_multiplier: '5', site_name: 'SA Test 2' });
    const page = await a.agent.get('/admin/settings');
    expect(page.text).not.toMatch(/were not saved|সেভ হয়নি/);
  });

  test('বার্তা bn ও en দুই locale-এই আছে', () => {
    const bn = require('../../locales/bn.json');
    const en = require('../../locales/en.json');
    expect(bn.admin_turnover_needs_bonus_manage).toMatch(/\{keys\}/);
    expect(en.admin_turnover_needs_bonus_manage).toMatch(/\{keys\}/);
    expect(bn.admin_turnover_needs_bonus_manage).not.toBe(en.admin_turnover_needs_bonus_manage);
  });
});
