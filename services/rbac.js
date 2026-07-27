// services/rbac.js
// Role-Based Access Control — বিদ্যমান আর্কিটেকচারের উপর ভিত্তি করে:
//   - users.role ('user' | 'admin') — মূল গেট, middleware/auth.js-এর isAdmin অপরিবর্তিত থাকে।
//   - users.role_key — একটা গ্রানুলার role (roles.key)। NULL = legacy admin, super_admin হিসেবে ট্রিট হয়
//     (backward compatible: যেসব admin আগে থেকে আছে তাদের অ্যাক্সেস এক বিন্দুও কমে না)।
//   - users.permissions (আগে থেকেই schema-তে ছিল, ব্যবহৃত হতো না) — role-এর উপরে per-user override।
//     ফরম্যাট: { "permission.key": true }  → শুধু grant করার জন্য (role-এর বাইরে অতিরিক্ত অনুমতি)।
//             { "permission.key": false } → role থেকে পাওয়া অনুমতি explicitly revoke করার জন্য।

const { pool } = require('../db');
const { logAdminAction } = require('./auditLog');

// ==================== Permission Catalog ====================
const PERMISSIONS = {
  'users.view': 'ইউজার তালিকা ও প্রোফাইল দেখা',
  'users.manage': 'ইউজার কয়েন/ব্যান/অ্যাডজাস্ট করা',
  'payments.view': 'ডিপোজিট/উইথড্র রিকোয়েস্ট দেখা',
  'payments.approve': 'ডিপোজিট/উইথড্র অনুমোদন বা বাতিল করা',
  'bets.view': 'বাজি/ম্যাচ দেখা',
  'bets.manage': 'বাজি সেটল বা ম্যাচ ম্যানেজ করা',
  'fraud.view': 'ফ্রড/ডুপ্লিকেট ফ্ল্যাগ দেখা',
  'fraud.manage': 'ফ্রড ফ্ল্যাগ রিভিউ/রিজলভ করা',
  'kyc.view': 'KYC রিকোয়েস্ট দেখা',
  'kyc.manage': 'KYC অনুমোদন বা বাতিল করা',
  'support.chat': 'লাইভ সাপোর্ট চ্যাট ব্যবহার করা',
  'settings.manage': 'সাইট সেটিংস পরিবর্তন করা',
  'roles.manage': 'রোল তৈরি/এডিট/ডিলিট ও ইউজারকে রোল অ্যাসাইন করা',
  'admins.manage': 'অ্যাডমিন প্রোমোট/ডিমোট করা',
  'queue.view': 'ব্যাকগ্রাউন্ড জব কিউ মনিটর করা',
  'queue.manage': 'ফেইলড জব রিট্রাই/DLQ পার্জ করা',
  'reports.view': 'রিপোর্ট ও অ্যানালিটিক্স দেখা',
  'reports.export': 'রিপোর্ট/ডেটা এক্সপোর্ট করা',
  'backups.manage': 'ব্যাকআপ চালানো বা রিস্টোর করা',
  'api_keys.manage': 'API Key তৈরি/রিভোক করা',
  'logs.view': 'অ্যাডমিন অ্যাক্টিভিটি ও API লগ দেখা'
};

const DEFAULT_ROLE_PERMISSIONS = {
  super_admin: ['*'], // সব পারমিশন — legacy admin-দের ডিফল্ট
  admin: Object.keys(PERMISSIONS).filter(p => p !== 'roles.manage' && p !== 'admins.manage'),
  manager: [
    'users.view', 'users.manage', 'payments.view', 'payments.approve',
    'bets.view', 'bets.manage', 'fraud.view', 'fraud.manage',
    'kyc.view', 'kyc.manage', 'reports.view', 'reports.export', 'logs.view'
  ],
  moderator: ['users.view', 'fraud.view', 'kyc.view', 'kyc.manage', 'support.chat', 'reports.view'],
  support: ['users.view', 'support.chat', 'payments.view']
};

const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  manager: 'Manager',
  moderator: 'Moderator',
  support: 'Support'
};

const SYSTEM_ROLE_KEYS = Object.keys(DEFAULT_ROLE_PERMISSIONS);

/** সার্ভার স্টার্টআপে (migrations.js থেকে) ডিফল্ট ৫টা রোল seed করে — ইতিমধ্যে থাকলে ছুঁয়ে দেখে না */
async function seedDefaultRoles() {
  for (const key of SYSTEM_ROLE_KEYS) {
    const exists = await pool.query('SELECT id FROM roles WHERE key = $1', [key]);
    if (exists.rows.length) continue;
    await pool.query(
      `INSERT INTO roles (key, name, description, permissions, is_system) VALUES ($1,$2,$3,$4,true)`,
      [key, ROLE_LABELS[key], `ডিফল্ট সিস্টেম রোল: ${ROLE_LABELS[key]}`, JSON.stringify(DEFAULT_ROLE_PERMISSIONS[key])]
    );
  }
}

async function listRoles() {
  const r = await pool.query('SELECT * FROM roles ORDER BY is_system DESC, name ASC');
  return r.rows;
}

async function getRoleByKey(key) {
  const r = await pool.query('SELECT * FROM roles WHERE key = $1', [key]);
  return r.rows[0] || null;
}

async function createRole({ key, name, description, permissions }) {
  if (!/^[a-z0-9_]{2,30}$/.test(key)) throw new Error('Role key শুধু lowercase, সংখ্যা ও আন্ডারস্কোর হতে পারে');
  const r = await pool.query(
    `INSERT INTO roles (key, name, description, permissions, is_system) VALUES ($1,$2,$3,$4,false) RETURNING *`,
    [key, name, description || null, JSON.stringify(permissions || [])]
  );
  return r.rows[0];
}

async function updateRole(key, { name, description, permissions }) {
  const role = await getRoleByKey(key);
  if (!role) throw new Error('রোল পাওয়া যায়নি');
  // system role হলেও name/description/permissions এডিট করা যাবে, শুধু delete করা যাবে না (নিচে দেখুন)
  const r = await pool.query(
    `UPDATE roles SET name = $2, description = $3, permissions = $4, updated_at = NOW() WHERE key = $1 RETURNING *`,
    [key, name || role.name, description !== undefined ? description : role.description, JSON.stringify(permissions || role.permissions)]
  );
  return r.rows[0];
}

async function deleteRole(key) {
  const role = await getRoleByKey(key);
  if (!role) throw new Error('রোল পাওয়া যায়নি');
  if (role.is_system) throw new Error('সিস্টেম ডিফল্ট রোল ডিলিট করা যাবে না');
  const inUse = await pool.query('SELECT COUNT(*) FROM users WHERE role_key = $1', [key]);
  if (parseInt(inUse.rows[0].count, 10) > 0) throw new Error('এই রোলে এখনো ইউজার অ্যাসাইন করা আছে — আগে তাদের অন্য রোলে সরান');
  await pool.query('DELETE FROM roles WHERE key = $1', [key]);
}

async function assignUserRole(userId, roleKey) {
  if (roleKey) {
    const role = await getRoleByKey(roleKey);
    if (!role) throw new Error('রোল পাওয়া যায়নি');
  }
  await pool.query('UPDATE users SET role_key = $1 WHERE id = $2', [roleKey || null, userId]);
}

/** নির্দিষ্ট ইউজারের effective পারমিশন সেট বের করে — role.permissions ∪/− user.permissions override */
async function getEffectivePermissions(userId) {
  const r = await pool.query('SELECT role, role_key, permissions FROM users WHERE id = $1', [userId]);
  const row = r.rows[0];
  if (!row || row.role !== 'admin') return new Set();

  const roleKey = row.role_key || 'super_admin'; // legacy admin (role_key নেই) = super_admin
  const role = await getRoleByKey(roleKey);
  const basePerms = role ? role.permissions : DEFAULT_ROLE_PERMISSIONS.super_admin;

  const perms = new Set(basePerms);
  const overrides = row.permissions || {};
  for (const [perm, granted] of Object.entries(overrides)) {
    if (granted) perms.add(perm);
    else perms.delete(perm);
  }
  return perms;
}

function hasPermission(permSet, needed) {
  if (!permSet) return false;
  if (permSet.has('*')) return true;
  if (permSet.has(needed)) return true;
  const wildcard = needed.split('.')[0] + '.*';
  return permSet.has(wildcard);
}

/**
 * requirePermission(perm) — router.use(isAdmin) এর পরে ব্যবহার করা হয় (সেই বেস গেট অপরিবর্তিত থাকে)।
 * একটামাত্র জায়গায় consistent 403 + audit log হ্যান্ডেল করে, প্রতিটা রুটে আলাদা করে লেখা লাগে না।
 */
function requirePermission(perm) {
  return async (req, res, next) => {
    try {
      const permSet = await getEffectivePermissions(req.session.user.id);
      if (hasPermission(permSet, perm)) return next();

      logAdminAction(
        req.session.user.id, req.session.user.username, 'UNAUTHORIZED_ACCESS',
        `প্রয়োজনীয় পারমিশন ছাড়া অ্যাক্সেসের চেষ্টা: "${perm}" — ${req.method} ${req.originalUrl}`,
        req.ip
      ).catch(() => {});

      if (req.originalUrl.includes('/api/') || req.headers.accept?.includes('application/json')) {
        return res.status(403).json({ success: false, error: 'এই অ্যাকশনের জন্য প্রয়োজনীয় পারমিশন নেই।' });
      }
      req.flash && req.flash('error', '❌ এই অ্যাকশনের জন্য আপনার প্রয়োজনীয় পারমিশন নেই।');
      return res.status(403).redirect(req.get('Referrer') || '/admin');
    } catch (err) {
      console.error('requirePermission error:', err.message);
      return res.status(403).send('Forbidden');
    }
  };
}

module.exports = {
  PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  ROLE_LABELS,
  SYSTEM_ROLE_KEYS,
  seedDefaultRoles,
  listRoles,
  getRoleByKey,
  createRole,
  updateRole,
  deleteRole,
  assignUserRole,
  getEffectivePermissions,
  hasPermission,
  requirePermission
};
