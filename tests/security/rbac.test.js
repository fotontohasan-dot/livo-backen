// tests/security/rbac.test.js
// ---------------------------------------------------------------------------
// RBAC (services/rbac.js) নিরাপত্তা কভারেজ: permission গেট, backward-compatible
// super_admin ডিফল্ট, system role সুরক্ষা, এবং routes/*.js-এর requirePermission()
// কলগুলো services/rbac.js-এর PERMISSIONS catalog-এর সাথে key মেলে কিনা।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const rbac = require('../../services/rbac');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const userRes = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
  return { agent, username, userId: userRes.rows[0].id };
}

describe('RBAC (services/rbac.js)', () => {
  describe('getUserPermissions() — backward-compatible ডিফল্ট', () => {
    test('role_key NULL থাকা admin সব permission-এ super_admin-সমতুল্য অ্যাক্সেস পায়', async () => {
      const { userId } = await makeAdminAgent();
      const { isSuperAdmin } = await rbac.getUserPermissions(userId);
      expect(isSuperAdmin).toBe(true);
      expect(await rbac.hasPermission(userId, 'roles_manage')).toBe(true);
      expect(await rbac.hasPermission(userId, 'anything_undefined')).toBe(true);
    });

    test('role_key সেট করা limited role শুধু নিজের permissions পায়', async () => {
      const { userId } = await makeAdminAgent();
      const role = await rbac.createRole({
        name: `Limited ${uniqueUsername()}`,
        permissions: { users_view: true, payments_view: false }
      });
      await rbac.assignUserRole(userId, role.key);

      expect(await rbac.hasPermission(userId, 'users_view')).toBe(true);
      expect(await rbac.hasPermission(userId, 'payments_view')).toBe(false);
      expect(await rbac.hasPermission(userId, 'roles_manage')).toBe(false); // ধরে নেওয়া হয়নি এমন permission = false
    });

    test('অস্তিত্বহীন ইউজারের জন্য কোনো permission নেই', async () => {
      const { isSuperAdmin, permissions } = await rbac.getUserPermissions(999999999);
      expect(isSuperAdmin).toBe(false);
      expect(permissions).toEqual({});
    });
  });

  describe('super_admin সিস্টেম রোল', () => {
    test('super_admin role_key-ধারী ইউজার isSuperAdmin=true পায়', async () => {
      const { userId } = await makeAdminAgent();
      await rbac.assignUserRole(userId, 'super_admin');
      const { isSuperAdmin } = await rbac.getUserPermissions(userId);
      expect(isSuperAdmin).toBe(true);
    });
  });

  describe('System role সুরক্ষা', () => {
    test('system role (super_admin) ডিলিট করা যায় না', async () => {
      const role = await rbac.getRole('super_admin');
      await expect(rbac.deleteRole(role.id)).rejects.toThrow();
    });

    test('ইউজার-অ্যাসাইনড role ডিলিট করা যায় না (আগে সরাতে হবে)', async () => {
      const { userId } = await makeAdminAgent();
      const role = await rbac.createRole({ name: `InUse ${uniqueUsername()}`, permissions: {} });
      await rbac.assignUserRole(userId, role.key);
      await expect(rbac.deleteRole(role.id)).rejects.toThrow();
      // পরিষ্কার করা — ইউজারকে সরিয়ে তারপর ডিলিট
      await rbac.assignUserRole(userId, null);
      await rbac.deleteRole(role.id);
    });

    test('bulkUpdatePermission() super_admin-এর permission override করতে পারে না', async () => {
      const superAdmin = await rbac.getRole('super_admin');
      await rbac.bulkUpdatePermission([superAdmin.id], 'roles_manage', false);
      const after = await rbac.getRole('super_admin');
      expect(after.permissions.roles_manage).toBe(true); // অপরিবর্তিত থাকল
    });

    test('import দিয়ে system role ওভাররাইট করা যায় না', async () => {
      const result = await rbac.importRoles([
        { key: 'super_admin', name: 'Hacked', permissions: {} }
      ]);
      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);
      const stillIntact = await rbac.getRole('super_admin');
      expect(stillIntact.name).toBe('Super Admin');
    });
  });

  describe('requirePermission() মিডলওয়্যার — HTTP-লেভেল গেট', () => {
    test('অপর্যাপ্ত permission-এ ব্লক হয় (browser GET রুটে /admin-এ রিডাইরেক্ট, অ্যাকশন সম্পন্ন হয় না)', async () => {
      const { agent, userId } = await makeAdminAgent();
      const role = await rbac.createRole({ name: `NoPay ${uniqueUsername()}`, permissions: { payments_view: false } });
      await rbac.assignUserRole(userId, role.key);

      const res = await agent.get('/payment/admin/payments');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin');
    });

    test('পর্যাপ্ত permission থাকলে অ্যাক্সেস পায় (403 নয়)', async () => {
      const { agent, userId } = await makeAdminAgent();
      const role = await rbac.createRole({ name: `PayView ${uniqueUsername()}`, permissions: { payments_view: true } });
      await rbac.assignUserRole(userId, role.key);

      const res = await agent.get('/payment/admin/payments');
      expect(res.status).not.toBe(403);
    });

    test('finance সিস্টেম রোল (seed করা payments_view/approve সহ) পেমেন্ট রুটে ঢুকতে পারে', async () => {
      const { agent, userId } = await makeAdminAgent();
      await rbac.assignUserRole(userId, 'finance');

      const viewRes = await agent.get('/payment/admin/payments');
      expect(viewRes.status).not.toBe(403);

      const summaryRes = await agent.get('/payment/admin/summary');
      expect(summaryRes.status).not.toBe(403);
    });

    test('permission ছাড়া অ্যাক্সেসের চেষ্টা admin_logs-এ UNAUTHORIZED_ACCESS হিসেবে রেকর্ড হয়', async () => {
      const { agent, userId, username } = await makeAdminAgent();
      const role = await rbac.createRole({ name: `Restricted ${uniqueUsername()}`, permissions: {} });
      await rbac.assignUserRole(userId, role.key);

      await agent.get('/payment/admin/payments');
      // enqueueActivityLog আসল queue না থাকলে সরাসরি DB fallback করে (services/rbac.js-এর কমেন্ট অনুযায়ী) —
      // দুই ক্ষেত্রেই admin_logs-এ শেষ পর্যন্ত রেকর্ড হওয়া উচিত, তাই সামান্য wait দিয়ে যাচাই করা হচ্ছে।
      await new Promise((r) => setTimeout(r, 300));
      const logRes = await pool.query(
        `SELECT * FROM admin_logs WHERE admin_username = $1 AND action_type = 'UNAUTHORIZED_ACCESS' ORDER BY created_at DESC LIMIT 1`,
        [username]
      );
      expect(logRes.rows.length).toBe(1);
    });
  });

  describe('routes/*.js-এর requirePermission() কল ও PERMISSIONS ক্যাটালগ সামঞ্জস্য', () => {
    // রিগ্রেশন গার্ড: routes/payment.js একবার ভুল key ('payments.view'/'payments.approve', ডট দিয়ে)
    // ব্যবহার করেছিল যেখানে ক্যাটালগে আন্ডারস্কোর key ('payments_view'/'payments_approve') আছে —
    // ফলে role.permissions-এ যতই grant করা হোক না কেন, hasPermission() কখনো মিলত না এবং
    // /admin/payments, /admin/deposits, /admin/summary, /admin/approve, /admin/reject-এ কোনো
    // non-super-admin role (যেমন সিড করা 'finance' role) কখনো ঢুকতে পারত না। এই টেস্ট প্রতিটা
    // requirePermission('...') কলের আর্গুমেন্ট PERMISSIONS ক্যাটালগে বাস্তবে আছে কিনা যাচাই করে,
    // যাতে ভবিষ্যতে টাইপো/নামকরণ-অসামঞ্জস্য চুপচাপ ফিরে না আসে।
    test('routes/payment.js ও routes/admin.js-এর সব requirePermission() key PERMISSIONS ক্যাটালগে বিদ্যমান', () => {
      const files = ['routes/payment.js', 'routes/admin.js'].map((f) => path.join(__dirname, '..', '..', f));
      const keyRegex = /requirePermission\(\s*['"]([^'"]+)['"]\s*\)/g;
      const foundKeys = new Set();
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        let match;
        while ((match = keyRegex.exec(content))) foundKeys.add(match[1]);
      }
      expect(foundKeys.size).toBeGreaterThan(0);
      for (const key of foundKeys) {
        expect(rbac.PERMISSIONS).toHaveProperty(key);
      }
    });
  });

  describe('সম্প্রতি সুরক্ষিত admin.js রুট — অনুমতি প্রয়োগ (প্রতিনিধিত্বমূলক নমুনা, বিভিন্ন permission key জুড়ে)', () => {
    const cases = [
      { method: 'get', path: '/admin/kyc', permission: 'kyc_view' },
      { method: 'get', path: '/admin/users', permission: 'users_view' },
      { method: 'get', path: '/admin/backups', permission: 'backups_manage' },
      { method: 'get', path: '/admin/cron-jobs', permission: 'cron_jobs_manage' },
      { method: 'get', path: '/admin/bot-monitoring', permission: 'bot_monitoring_manage' },
      { method: 'get', path: '/admin/matches', permission: 'matches_manage' },
      { method: 'get', path: '/admin/bets', permission: 'games_manage' },
      { method: 'get', path: '/admin/reports', permission: 'reports_view' },
      { method: 'get', path: '/admin/support', permission: 'support_view' },
      { method: 'get', path: '/admin/audit-logs', permission: 'activity_log_view' }
    ];

    test.each(cases)('$path — সংশ্লিষ্ট permission ($permission) ছাড়া প্রত্যাখ্যাত, থাকলে গৃহীত', async ({ path: routePath, permission }) => {
      const { agent, userId } = await makeAdminAgent();

      // (ক) কোনো permission ছাড়াই — ব্লক হওয়া উচিত (302, dashboard-এ ফেরত অথবা /admin/login)
      const noPermRole = await rbac.createRole({ name: `NoPerm-${permission}-${uniqueUsername()}`, permissions: {} });
      await rbac.assignUserRole(userId, noPermRole.key);
      const denied = await agent.get(routePath);
      expect(denied.status).toBe(302);

      // (খ) সঠিক permission দিয়ে — গৃহীত হওয়া উচিত (403/302-denial না)
      const withPermRole = await rbac.createRole({ name: `WithPerm-${permission}-${uniqueUsername()}`, permissions: { [permission]: true } });
      await rbac.assignUserRole(userId, withPermRole.key);
      const allowed = await agent.get(routePath);
      expect(allowed.status).toBe(200);
    });

    test('super_admin role_key দিয়ে সব সুরক্ষিত রুটে অ্যাক্সেস বজায় থাকে', async () => {
      const { agent, userId } = await makeAdminAgent();
      await rbac.assignUserRole(userId, 'super_admin');
      for (const { path: routePath } of cases) {
        const res = await agent.get(routePath);
        expect(res.status).toBe(200);
      }
    });

    test('role_key NULL (ব্যাকওয়ার্ড-কম্প্যাটিবল ডিফল্ট admin) দিয়েও সব সুরক্ষিত রুটে অ্যাক্সেস বজায় থাকে', async () => {
      const { agent } = await makeAdminAgent(); // role_key কখনো সেট করা হয়নি এখানে
      for (const { path: routePath } of cases) {
        const res = await agent.get(routePath);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('POST /admin/settings/admins/promote — role_key=NULL দিয়ে super_admin এসকেলেশন', () => {
    // দ্রষ্টব্য: আগে এই রুট শুধু requirePermission('roles_manage') দিয়ে গার্ড করা ছিল।
    // role_key ছাড়া role='admin' বসানো মানেই (getUserPermissions()-এ) super_admin-সমতুল্য
    // পূর্ণ অ্যাক্সেস — অর্থাৎ শুধু "roles_manage" পারমিশনধারী একজন সীমিত অ্যাডমিনও নিজের
    // একটা alt অ্যাকাউন্টকে এই রুট দিয়ে পূর্ণ super_admin বানিয়ে নিতে পারতেন। এখন রুটটা
    // requireSuperAdmin() দিয়ে গার্ড করা — শুধু roles_manage থাকলে আর যথেষ্ট নয়।
    async function makeAdminAgentWithToken() {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      const phone = uniquePhone();
      await agent
        .post('/register')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
      const userRes = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
      return { agent, token, username, userId: userRes.rows[0].id };
    }

    test('শুধু roles_manage পারমিশন থাকা admin (super_admin নয়) প্রত্যাখ্যাত হয়, টার্গেট প্রোমোট হয় না', async () => {
      const { agent, token, userId } = await makeAdminAgentWithToken();
      const role = await rbac.createRole({ name: `RolesManageOnly-${uniqueUsername()}`, permissions: { roles_manage: true } });
      await rbac.assignUserRole(userId, role.key);

      const target = await makeAdminAgentWithToken(); // role='admin' কিন্তু role_key এখনো সেট হয়নি
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['user', target.userId]); // সাধারণ ইউজারে নামানো, প্রোমোট করার আগের অবস্থা

      const res = await agent.post('/admin/settings/admins/promote').type('form').send({ username: target.username, _csrf: token });
      expect(res.status).toBe(302);

      const check = await pool.query('SELECT role, role_key FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role).toBe('user'); // প্রোমোট হয়নি
    });

    test('সত্যিকার super_admin (role_key=super_admin) সফলভাবে প্রোমোট করতে পারেন', async () => {
      const { agent, token, userId } = await makeAdminAgentWithToken();
      await rbac.assignUserRole(userId, 'super_admin');

      const target = await makeAdminAgentWithToken();
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['user', target.userId]);

      const res = await agent.post('/admin/settings/admins/promote').type('form').send({ username: target.username, _csrf: token });
      expect(res.status).toBe(302);

      const check = await pool.query('SELECT role FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role).toBe('admin');
    });

    test('role_key=NULL (ব্যাকওয়ার্ড-কম্প্যাটিবল ডিফল্ট super_admin) দিয়েও প্রোমোট করা যায়', async () => {
      const { agent, token } = await makeAdminAgentWithToken(); // role_key সেট করা হয়নি — ডিফল্ট super_admin-সমতুল্য

      const target = await makeAdminAgentWithToken();
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['user', target.userId]);

      const res = await agent.post('/admin/settings/admins/promote').type('form').send({ username: target.username, _csrf: token });
      expect(res.status).toBe(302);

      const check = await pool.query('SELECT role FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role).toBe('admin');
    });
  });

  describe('POST /admin/user-roles/:userId/assign — role_key=NULL/super_admin এসকেলেশন', () => {
    async function makeAdminAgentWithToken() {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      const phone = uniquePhone();
      await agent
        .post('/register')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
      const userRes = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
      return { agent, token, username, userId: userRes.rows[0].id };
    }

    test('শুধু roles_manage থাকা admin role_key খালি রেখে (NULL) নিজেকে/অন্যকে super_admin বানাতে পারেন না', async () => {
      const { agent, token, userId } = await makeAdminAgentWithToken();
      const role = await rbac.createRole({ name: `RolesManageOnly-${uniqueUsername()}`, permissions: { roles_manage: true } });
      await rbac.assignUserRole(userId, role.key);

      const target = await makeAdminAgentWithToken();
      await rbac.assignUserRole(target.userId, role.key); // টার্গেটও একই সীমিত role-এ শুরু

      const res = await agent.post(`/admin/user-roles/${target.userId}/assign`).type('form').send({ role_key: '', _csrf: token });
      expect(res.status).toBe(302);

      const check = await pool.query('SELECT role_key FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role_key).toBe(role.key); // অপরিবর্তিত — NULL হয়ে যায়নি
    });

    test('শুধু roles_manage থাকা admin সরাসরি role_key="super_admin" বসাতে পারেন না', async () => {
      const { agent, token, userId } = await makeAdminAgentWithToken();
      const role = await rbac.createRole({ name: `RolesManageOnly2-${uniqueUsername()}`, permissions: { roles_manage: true } });
      await rbac.assignUserRole(userId, role.key);

      const target = await makeAdminAgentWithToken();
      await rbac.assignUserRole(target.userId, role.key);

      const res = await agent.post(`/admin/user-roles/${target.userId}/assign`).type('form').send({ role_key: 'super_admin', _csrf: token });
      expect(res.status).toBe(302);

      const check = await pool.query('SELECT role_key FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role_key).toBe(role.key); // অপরিবর্তিত
    });

    test('শুধু roles_manage থাকা admin এখনও সীমিত/কাস্টম role এসাইন করতে পারেন (আসল উদ্দেশ্য অক্ষত)', async () => {
      const { agent, token, userId } = await makeAdminAgentWithToken();
      const managerRole = await rbac.createRole({ name: `RolesManageOnly3-${uniqueUsername()}`, permissions: { roles_manage: true } });
      await rbac.assignUserRole(userId, managerRole.key);

      const target = await makeAdminAgentWithToken();
      const limitedRole = await rbac.createRole({ name: `Limited-${uniqueUsername()}`, permissions: { users_view: true } });

      const res = await agent.post(`/admin/user-roles/${target.userId}/assign`).type('form').send({ role_key: limitedRole.key, _csrf: token });
      expect(res.status).toBe(302);

      const check = await pool.query('SELECT role_key FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role_key).toBe(limitedRole.key); // সীমিত role এসাইন সফল
    });

    test('সত্যিকার super_admin role_key=NULL বা super_admin দুটোই বসাতে পারেন', async () => {
      const { agent, token, userId } = await makeAdminAgentWithToken();
      await rbac.assignUserRole(userId, 'super_admin');

      const target = await makeAdminAgentWithToken();
      const res1 = await agent.post(`/admin/user-roles/${target.userId}/assign`).type('form').send({ role_key: 'super_admin', _csrf: token });
      expect(res1.status).toBe(302);
      let check = await pool.query('SELECT role_key FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role_key).toBe('super_admin');

      const res2 = await agent.post(`/admin/user-roles/${target.userId}/assign`).type('form').send({ role_key: '', _csrf: token });
      expect(res2.status).toBe(302);
      check = await pool.query('SELECT role_key FROM users WHERE id = $1', [target.userId]);
      expect(check.rows[0].role_key).toBeNull();
    });
  });
});
