// tests/security/bonusManagePermission.test.js
// ---------------------------------------------------------------------------
// নতুন bonus_manage পারমিশন (আসল PostgreSQL, আসল Express app):
//   • /admin/bonuses (তালিকা/যোগ/বাতিল) এখন bonus_manage চায় (আগে users_edit)
//   • turnover_* সেটিং key এখন bonus_manage-ওয়ালা বদলাতে পারে (আগে settings_edit)
//   • role_key NULL / super_admin সব পায় — বিদ্যমান সিড করা role বদলায়নি
// নোট: requirePermission HTML পাথে 403 নয়, ৩০২ → /admin রিডাইরেক্ট করে (এবং
// admin_logs-এ UNAUTHORIZED_ACCESS লেখে); তাই "প্রত্যাখ্যাত" মানে ৩০২/৪০৩ + কোনো
// স্টেট বদল নেই + UNAUTHORIZED_ACCESS লগ।
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
  const role = await rbac.createRole({ name: `BM ${uniqueUsername()}`, permissions });
  const a = await makeUser({ admin: true, roleKey: role.key });
  return { ...a, roleKey: role.key };
}

const getSetting = async (k) => {
  const r = await pool.query('SELECT value FROM site_settings WHERE key=$1', [k]);
  return r.rows[0] ? r.rows[0].value : null;
};
const setSetting = (k, v) => pool.query(
  `INSERT INTO site_settings (key, value, updated_at) VALUES ($1,$2,NOW())
   ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [k, v]);

const DENIED = [302, 403];
const bonusCount = async (userId) =>
  (await pool.query('SELECT COUNT(*)::int AS c FROM bonuses WHERE user_id=$1', [userId])).rows[0].c;

describe('bonus_manage — ক্যাটালগ ও সিড', () => {
  test('PERMISSIONS ক্যাটালগে bonus_manage আছে (label + group সহ)', () => {
    expect(rbac.PERMISSIONS.bonus_manage).toBeTruthy();
    expect(rbac.PERMISSIONS.bonus_manage.label).toBeTruthy();
    expect(rbac.PERMISSIONS.bonus_manage.group).toBeTruthy();
  });

  test('বিদ্যমান সিড করা system role-এর কোনোটায় bonus_manage যোগ হয়নি', async () => {
    for (const key of ['admin', 'moderator', 'support', 'finance']) {
      const role = (await pool.query('SELECT permissions FROM roles WHERE key=$1', [key])).rows[0];
      expect((role && role.permissions) || {}).not.toHaveProperty('bonus_manage');
    }
  });
});

describe('/admin/bonuses — bonus_manage ছাড়া প্রত্যাখ্যাত', () => {
  test.each([
    ['support role', { users_view: true, support_view: true }],
    ['users_edit আছে কিন্তু bonus_manage নেই (আগে যা চলত)', { users_edit: true, users_view: true, settings_edit: true, vip_manage: true }]
  ])('%s: তালিকা, add, cancel — সব প্রত্যাখ্যাত, কিছু বদলায় না', async (_n, perms) => {
    const a = await makeRoleAdmin(perms);
    const target = await makeUser();
    const b = (await pool.query(
      `INSERT INTO bonuses (user_id, bonus_type, bonus_amount, sports_required, casino_required, status)
       VALUES ($1,'t',10,0,0,'active') RETURNING id`, [target.userId])).rows[0];

    const list = await a.agent.get('/admin/bonuses');
    expect(DENIED).toContain(list.status);

    const add = await a.agent.post('/admin/bonuses/add').type('form')
      .send({ _csrf: a.token, username: target.username, bonus_type: 'x', bonus_amount: '50', sports_required: '1', casino_required: '1' });
    expect(DENIED).toContain(add.status);
    expect(await bonusCount(target.userId)).toBe(1); // নতুন বোনাস তৈরি হয়নি

    const cancel = await a.agent.post(`/admin/bonuses/${b.id}/cancel`).type('form').send({ _csrf: a.token });
    expect(DENIED).toContain(cancel.status);
    const st = (await pool.query('SELECT status FROM bonuses WHERE id=$1', [b.id])).rows[0].status;
    expect(st).toBe('active'); // বাতিল হয়নি

    const logs = await pool.query(
      "SELECT 1 FROM admin_logs WHERE admin_id=$1 AND action_type='UNAUTHORIZED_ACCESS' AND details LIKE '%bonus_manage%'", [a.userId]);
    expect(logs.rowCount).toBeGreaterThanOrEqual(1);
  });
});

describe('/admin/bonuses — bonus_manage থাকলে সফল', () => {
  test('শুধু bonus_manage-ওয়ালা role: তালিকা 200, add ও cancel কাজ করে', async () => {
    const a = await makeRoleAdmin({ bonus_manage: true });
    const target = await makeUser();

    const list = await a.agent.get('/admin/bonuses');
    expect(list.status).toBe(200);

    const add = await a.agent.post('/admin/bonuses/add').type('form')
      .send({ _csrf: a.token, username: target.username, bonus_type: 'x', bonus_amount: '50', sports_required: '1', casino_required: '1' });
    expect(add.status).toBe(302);
    expect(add.headers.location).toBe('/admin/bonuses');
    expect(await bonusCount(target.userId)).toBe(1);

    const id = (await pool.query('SELECT id FROM bonuses WHERE user_id=$1', [target.userId])).rows[0].id;
    const cancel = await a.agent.post(`/admin/bonuses/${id}/cancel`).type('form').send({ _csrf: a.token });
    expect(cancel.status).toBe(302);
    const st = (await pool.query('SELECT status FROM bonuses WHERE id=$1', [id])).rows[0].status;
    expect(st).toBe('cancelled');
  });
});

describe('/admin/bonuses — সুপার-অ্যাডমিন সফল', () => {
  test.each([
    ['role_key NULL admin', null],
    ['role_key = super_admin', 'super_admin']
  ])('%s: bonus_manage ছাড়াই সব পায়', async (_n, roleKey) => {
    const a = await makeUser({ admin: true, roleKey });
    const target = await makeUser();
    expect((await a.agent.get('/admin/bonuses')).status).toBe(200);
    const add = await a.agent.post('/admin/bonuses/add').type('form')
      .send({ _csrf: a.token, username: target.username, bonus_type: 'x', bonus_amount: '25', sports_required: '0', casino_required: '0' });
    expect(add.status).toBe(302);
    expect(await bonusCount(target.userId)).toBe(1);
    expect(await rbac.hasPermission(a.userId, 'bonus_manage')).toBe(true);
  });
});

describe('/admin/settings/update — turnover_* ⇒ bonus_manage, বাকি ⇒ settings_edit', () => {
  let origTurnover, origName, origMaint;
  beforeAll(async () => {
    origTurnover = await getSetting('turnover_multiplier');
    origName = await getSetting('site_name');
    origMaint = await getSetting('maintenance_mode');
  });
  afterAll(async () => {
    if (origTurnover !== null) await setSetting('turnover_multiplier', origTurnover);
    if (origName !== null) await setSetting('site_name', origName);
    if (origMaint !== null) await setSetting('maintenance_mode', origMaint);
  });

  let adm;
  beforeAll(async () => { adm = await makeUser({ admin: true }); }); // একবারই রেজিস্ট্রেশন; role প্রতি টেস্টে বদলায়
  const withRole = async (permissions) => {
    if (permissions === null) { await pool.query('UPDATE users SET role_key=NULL WHERE id=$1', [adm.userId]); return adm; }
    const role = await rbac.createRole({ name: `BM ${uniqueUsername()}`, permissions });
    await pool.query('UPDATE users SET role_key=$1 WHERE id=$2', [role.key, adm.userId]);
    return adm;
  };
  const post = (a, body) => a.agent.post('/admin/settings/update').type('form').send({ _csrf: a.token, ...body });

  test('কোনোটাই নেই (support): প্রত্যাখ্যাত, কিছু বদলায় না', async () => {
    await setSetting('turnover_multiplier', '5');
    const a = await withRole({ users_view: true });
    const res = await post(a, { turnover_multiplier: '9', site_name: 'HACK' });
    expect(DENIED).toContain(res.status);
    expect(await getSetting('turnover_multiplier')).toBe('5');
    expect(await getSetting('site_name')).toBe(origName);
  });

  test('শুধু bonus_manage: turnover বদলায়, site_name ও maintenance_mode বদলায় না', async () => {
    await setSetting('turnover_multiplier', '5');
    await setSetting('maintenance_mode', 'true');
    const a = await withRole({ bonus_manage: true });
    const res = await post(a, { turnover_multiplier: '8', site_name: 'HACK2' }); // maintenance_mode ফিল্ড নেই
    expect(res.status).toBe(302);
    expect(await getSetting('turnover_multiplier')).toBe('8');
    expect(await getSetting('site_name')).toBe(origName);
    expect(await getSetting('maintenance_mode')).toBe('true'); // false-এ রিসেট হয়নি
  });

  test('শুধু settings_edit (bonus_manage নেই): site_name বদলায়, turnover বদলায় না', async () => {
    await setSetting('turnover_multiplier', '5');
    const a = await withRole({ settings_edit: true, settings_view: true });
    const res = await post(a, { turnover_multiplier: '11', site_name: 'OkName' });
    expect(res.status).toBe(302);
    expect(await getSetting('turnover_multiplier')).toBe('5');
    expect(await getSetting('site_name')).toBe('OkName');
  });

  test('সুপার-অ্যাডমিন (role_key NULL): দুটোই বদলায়', async () => {
    await setSetting('turnover_multiplier', '5');
    const a = await withRole(null);
    const res = await post(a, { turnover_multiplier: '6', site_name: 'SuperName' });
    expect(res.status).toBe(302);
    expect(await getSetting('turnover_multiplier')).toBe('6');
    expect(await getSetting('site_name')).toBe('SuperName');
  });
});
