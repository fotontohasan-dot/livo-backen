// K10 (ঙ) — system_diagnostics_manage শুধু super_admin রোলে: migration (idempotent) + রোল-লেখার সব পথে গার্ড।
const { pool } = require('../../db');
const runMigrations = require('../../migrations');
const rbac = require('../../services/rbac');

const KEY = 'system_diagnostics_manage';
const mk = (s) => `${s}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const perms = async (key) => (await pool.query('SELECT permissions FROM roles WHERE key = $1', [key])).rows[0].permissions;
const createdKeys = [];
const insertRaw = async (name, p) => { // গার্ড এড়িয়ে সরাসরি SQL — "ভুলে বসে থাকা" অবস্থা বানাতে
  const key = mk(name); createdKeys.push(key);
  await pool.query(`INSERT INTO roles (key,name,is_system,permissions) VALUES ($1,$1,false,$2)`, [key, JSON.stringify(p)]);
  return key;
};

// শেয়ার্ড টেস্ট DB-তে super_admin রোলের permissions এই ফাইলের টেস্ট বদলায় (updateRole, migration-এর আগে key সরানো)।
// আগে তা পুনরুদ্ধার হতো না: ফলে একই DB-তে চলা rbac.test.js-এ super_admin.roles_manage `undefined` আসত।
// তাই শুরুতে পুরো permissions সংরক্ষণ করে শেষে হুবহু ফেরানো হয় (কোনো assertion বদলায়নি)।
let superAdminPermsSnapshot = null;
beforeAll(async () => {
  const r = await pool.query("SELECT permissions FROM roles WHERE key = 'super_admin'");
  superAdminPermsSnapshot = r.rows[0] ? r.rows[0].permissions : null;
});

afterAll(async () => {
  if (superAdminPermsSnapshot) {
    await pool.query("UPDATE roles SET permissions = $1::jsonb WHERE key = 'super_admin'", [JSON.stringify(superAdminPermsSnapshot)]);
    await require('../../services/cache').del('role:super_admin');
  }
  for (const k of createdKeys) await pool.query('DELETE FROM roles WHERE key = $1', [k]);
  await pool.query("UPDATE roles SET permissions = permissions - $1 WHERE key <> 'super_admin'", [KEY]);
});

describe('migration', () => {
  test('অন্য রোলে (কাস্টম ও সিস্টেম) ভুলে থাকলে সরায়; super_admin-এ true; বাকি permission অক্ষত', async () => {
    const custom = await insertRaw('wrongcustom', { users_view: true, [KEY]: true, system_diagnostics_view: true });
    await pool.query(`UPDATE roles SET permissions = jsonb_set(permissions, '{${KEY}}', 'true') WHERE key = 'finance'`);
    await pool.query(`UPDATE roles SET permissions = permissions - '${KEY}' WHERE key = 'super_admin'`);

    await runMigrations();

    expect(await perms(custom)).toEqual({ users_view: true, system_diagnostics_view: true });
    expect(KEY in await perms('finance')).toBe(false);
    expect((await perms('finance')).payments_approve).toBe(true);
    for (const k of ['admin', 'moderator', 'support']) expect(KEY in await perms(k)).toBe(false);
    expect((await perms('super_admin'))[KEY]).toBe(true);
  });

  test('আবার চালালে একই ফল (idempotent), অন্য কিছু বদলায় না', async () => {
    const before = (await pool.query('SELECT key, permissions FROM roles ORDER BY key')).rows;
    await runMigrations();
    const after = (await pool.query('SELECT key, permissions FROM roles ORDER BY key')).rows;
    expect(after.filter((r) => !createdKeys.includes(r.key))).toEqual(before.filter((r) => !createdKeys.includes(r.key)));
  });
});

describe('রোল-লেখার পথে গার্ড', () => {
  test('createRole / updateRole / cloneRole / bulkUpdatePermission / importRoles কোনোটাই অন্য রোলে দেয় না', async () => {
    const created = await rbac.createRole({ name: mk('guardc'), permissions: { users_view: true, [KEY]: true } });
    createdKeys.push(created.key);
    expect(created.permissions).toEqual({ users_view: true });

    const upd = await rbac.updateRole(created.id, { name: created.name, permissions: { users_view: true, [KEY]: true } });
    expect(KEY in upd.permissions).toBe(false);

    const clone = await rbac.cloneRole(created.id, mk('guardclone'));
    createdKeys.push(clone.key);
    expect(KEY in clone.permissions).toBe(false);

    const names = await rbac.bulkUpdatePermission([created.id, clone.id], KEY, true);
    expect(names).toEqual([]);
    expect(KEY in await perms(created.key)).toBe(false);

    const impKey = mk('guardimp'); createdKeys.push(impKey);
    await rbac.importRoles([{ key: impKey, name: impKey, permissions: { users_view: true, [KEY]: true } }]);
    expect(KEY in await perms(impKey)).toBe(false);
    await rbac.importRoles([{ key: impKey, name: impKey, permissions: { [KEY]: true } }]); // আপডেট পথ
    expect(KEY in await perms(impKey)).toBe(false);
  });

  test('super_admin রোল সম্পাদনায় permission থাকে', async () => {
    const sa = (await pool.query("SELECT id FROM roles WHERE key='super_admin'")).rows[0];
    const r = await rbac.updateRole(sa.id, { name: 'Super Admin', permissions: { [KEY]: true, users_view: true } });
    expect(r.permissions[KEY]).toBe(true);
  });
});

describe('hasPermission', () => {
  async function userWithRole(roleKey) {
    const u = await pool.query(
      `INSERT INTO users (username, phone, password, role, role_key) VALUES ($1,$2,'x','admin',$3) RETURNING id`,
      [mk('rbacu'), `017${Math.floor(10000000 + Math.random() * 89999999)}`, roleKey]);
    return u.rows[0].id;
  }
  afterAll(async () => { await pool.query("DELETE FROM users WHERE username LIKE 'rbacu_%'"); });

  test('super_admin পায়; admin/finance/moderator/support/কাস্টম রোল পায় না', async () => {
    expect(await rbac.hasPermission(await userWithRole('super_admin'), KEY)).toBe(true);
    for (const k of ['admin', 'finance', 'moderator', 'support']) {
      expect(await rbac.hasPermission(await userWithRole(k), KEY)).toBe(false);
    }
    const custom = await rbac.createRole({ name: mk('hp'), permissions: { [KEY]: true, system_diagnostics_view: true } });
    createdKeys.push(custom.key);
    const uid = await userWithRole(custom.key);
    expect(await rbac.hasPermission(uid, KEY)).toBe(false);
    expect(await rbac.hasPermission(uid, 'system_diagnostics_view')).toBe(true); // দেখা যায়, বদলানো যায় না
  });
});
