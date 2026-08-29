// tests/security/adminAuthorizationMatrix.test.js
// ---------------------------------------------------------------------------
// PHASE 4 — ADMIN PANEL AUTHORIZATION
//
// প্রতিটি privileged route-এর জন্য সরাসরি HTTP request পাঠিয়ে যাচাই:
//
//   Unauthenticated  → DENY
//   Normal user      → DENY
//   Wrong admin role → DENY (limited RBAC role)
//   Authorized admin → ALLOW
//
// UI-তে link লুকানো থাকলেই secure ধরা হয়নি — প্রতিটি assertion সরাসরি
// HTTP request দিয়ে করা হয়েছে।
//
// MEDIUM-4 fix লক করা হয়: system diagnostics / cache / sentry-status
// route গুলো আগে শুধু isAdmin-এর পিছনে ছিল, কোনো permission check ছাড়া।
// ---------------------------------------------------------------------------

const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const rbac = require('../../services/rbac');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');

const PASSWORD = 'SecurePass123';

//  session-  agent    (2FA   );
//    session   users.role/role_key    
async function makeSessionAgent(role = 'user', roleKey = null) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('az');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: PASSWORD, confirmPassword: PASSWORD, _csrf: token });

  const r = await pool.query(
    'UPDATE users SET role = $1, role_key = $2 WHERE username = $3 RETURNING id',
    [role, roleKey, username]
  );
  return { agent, token, username, userId: r.rows[0].id };
}

//    permission    limited admin role
async function makeLimitedRole(permissions) {
  const role = await rbac.createRole({
    name: `Limited ${uniqueUsername('r')}`,
    permissions
  });
  return role.key;
}

// GET route-  DENY   :   /admin/login redirect,  403,
//   200         
function expectDenied(res) {
  const denied =
    (res.status === 302 && /\/admin\/login|\/login/.test(res.headers.location || '')) ||
    res.status === 403 ||
    (res.status === 302 && /\/admin(\?|$)/.test(res.headers.location || ''));
  expect(denied).toBe(true);
}

// Phase 4-      privileged GET route
const PRIVILEGED_GET_ROUTES = [
  '/admin',
  '/admin/users',
  '/admin/diagnostics',
  '/admin/diagnostics/json',
  '/admin/cache',
  '/admin/sentry-status',
  '/admin/system-diagnostics',
  '/admin/api/system-diagnostics',
  '/payment/admin/payments',
  '/payment/admin/deposits',
];

describe('Admin authorization matrix (PHASE 4)', () => {
  describe('Unauthenticated → DENY', () => {
    test.each(PRIVILEGED_GET_ROUTES)('%s unauthenticated request প্রত্যাখ্যাত হয়', async (route) => {
      const res = await freshRequest().get(route);
      expectDenied(res);
      //     JSON /HTML     
      expect(res.text || '').not.toMatch(/"overall"\s*:/);
    });
  });

  describe('Normal user → DENY', () => {
    let userAgent;
    beforeAll(async () => {
      userAgent = await makeSessionAgent('user');
    });

    test.each(PRIVILEGED_GET_ROUTES)('%s সাধারণ user-এর জন্য প্রত্যাখ্যাত হয়', async (route) => {
      const res = await userAgent.agent.get(route);
      expectDenied(res);
    });

    test('সাধারণ user সরাসরি POST দিয়ে payment approve করতে পারে না', async () => {
      const res = await userAgent.agent
        .post('/payment/admin/approve/1')
        .set('X-CSRF-Token', userAgent.token)
        .type('form')
        .send({});
      expectDenied(res);
    });
  });

  describe('Wrong admin role → DENY (limited RBAC role)', () => {
    let limited;
    beforeAll(async () => {
      //   support-  admin:  support   
      const key = await makeLimitedRole({ support_view: true, support_reply: true });
      limited = await makeSessionAgent('admin', key);
    });

    test('limited admin system diagnostics দেখতে পারে না (MEDIUM-4)', async () => {
      for (const route of ['/admin/diagnostics', '/admin/diagnostics/json', '/admin/cache', '/admin/sentry-status']) {
        const res = await limited.agent.get(route);
        expect(res.status).not.toBe(200);
      }
    });

    test('limited admin adminHealthFix diagnostics দেখতে পারে না', async () => {
      for (const route of ['/admin/system-diagnostics', '/admin/api/system-diagnostics']) {
        const res = await limited.agent.get(route);
        expect(res.status).not.toBe(200);
      }
    });

    test('limited admin diagnostics JSON body পায় না (data leak নেই)', async () => {
      const res = await limited.agent.get('/admin/diagnostics/json');
      expect(res.body && res.body.checks).toBeUndefined();
    });

    test('limited admin user list দেখতে পারে না', async () => {
      const res = await limited.agent.get('/admin/users');
      expect(res.status).not.toBe(200);
    });

    test('limited admin payment approve করতে পারে না', async () => {
      const res = await limited.agent
        .post('/payment/admin/approve/1')
        .set('X-CSRF-Token', limited.token)
        .type('form')
        .send({});
      expect(res.status).not.toBe(200);

      //         audit  
      const logged = await pool.query(
        `SELECT COUNT(*)::int c FROM admin_logs WHERE admin_id = $1 AND action_type = 'UNAUTHORIZED_ACCESS'`,
        [limited.userId]
      );
      expect(logged.rows[0].c).toBeGreaterThanOrEqual(1);
    });

    test('limited admin নিজের অনুমোদিত অংশে ঢুকতে পারে (over-blocking নেই)', async () => {
      const allowed = await rbac.hasPermission(limited.userId, 'support_view');
      expect(allowed).toBe(true);
    });
  });

  describe('Authorized super admin → ALLOW (zero-regression)', () => {
    let superAdmin;
    beforeAll(async () => {
      // role_key = NULL  admin  backward-compatible super_admin
      superAdmin = await makeSessionAgent('admin', null);
    });

    test('super admin system diagnostics দেখতে পারে', async () => {
      const res = await superAdmin.agent.get('/admin/diagnostics/json');
      expect(res.status).toBe(200);
      expect(res.body.overall).toBeDefined();
    });

    test('super admin cache পেজ দেখতে পারে', async () => {
      const res = await superAdmin.agent.get('/admin/cache');
      expect(res.status).toBe(200);
    });

    test('super admin adminHealthFix diagnostics API দেখতে পারে', async () => {
      const res = await superAdmin.agent.get('/admin/api/system-diagnostics');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('super admin user list দেখতে পারে', async () => {
      const res = await superAdmin.agent.get('/admin/users');
      expect(res.status).toBe(200);
    });
  });

  describe('Permission catalog integrity', () => {
    test('system_diagnostics_view catalog-এ আছে এবং System group-এ', () => {
      const groups = rbac.permissionGroups();
      const system = groups.System || [];
      expect(system.some((p) => p.key === 'system_diagnostics_view')).toBe(true);
    });

    test('super_admin সব permission পায় (existing admin access অক্ষত)', async () => {
      const admin = await makeSessionAgent('admin', null);
      expect(await rbac.hasPermission(admin.userId, 'system_diagnostics_view')).toBe(true);
    });
  });
});
