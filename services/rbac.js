// services/rbac.js
// ---------------------------------------------------------------------------
// Role & Permission Management (RBAC)। বিদ্যমান users.role ('admin'/'user') এবং
// middleware/auth.js-এর isAdmin গেট সম্পূর্ণ অপরিবর্তিত রাখা হয়েছে — এটাই এখনো
// admin panel-এ ঢোকার মূল/প্রথম গেট (backward compatible)। এই ফাইলের
// requirePermission() একটা দ্বিতীয়, ঐচ্ছিক, আরও সূক্ষ্ম গেট — শুধু যেসব রুটে
// explicitly বসানো হয়েছে সেখানেই কাজ করে। কোনো admin-এর role_key সেট করা না থাকলে
// (NULL) সে super_admin-এর মতোই পূর্ণ অ্যাক্সেস পায় — অর্থাৎ role_key ফিচার চালুর
// আগে যত admin অ্যাকাউন্ট ছিল, তাদের অ্যাক্সেসে কোনো পরিবর্তন হয় না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const cache = require('./cache');

// ==================== Permission Catalog ====================
// key -> { label, group } — Admin UI-এর Permission Matrix এই লিস্ট থেকেই তৈরি হয়।
// নতুন ফিচারের জন্য নতুন permission লাগলে শুধু এখানে একটা এন্ট্রি যোগ করলেই চলবে।
const PERMISSIONS = {
  dashboard_view: { label: 'ড্যাশবোর্ড দেখা', group: 'General' },
  users_view: { label: 'ইউজার তালিকা দেখা', group: 'Users' },
  users_edit: { label: 'ইউজার তথ্য এডিট', group: 'Users' },
  users_ban: { label: 'ইউজার ব্যান/আনব্যান', group: 'Users' },
  users_delete: { label: 'ইউজার ডিলিট', group: 'Users' },
  payments_view: { label: 'পেমেন্ট রিকোয়েস্ট দেখা', group: 'Payments' },
  payments_approve: { label: 'ডিপোজিট/উইথড্র অনুমোদন', group: 'Payments' },
  payments_reject: { label: 'ডিপোজিট/উইথড্র বাতিল', group: 'Payments' },
  kyc_view: { label: 'KYC রিকোয়েস্ট দেখা', group: 'KYC' },
  kyc_approve: { label: 'KYC অনুমোদন', group: 'KYC' },
  kyc_reject: { label: 'KYC বাতিল', group: 'KYC' },
  support_view: { label: 'সাপোর্ট টিকিট দেখা', group: 'Support' },
  support_reply: { label: 'সাপোর্ট টিকিটে রিপ্লাই', group: 'Support' },
  games_manage: { label: 'গেমস ম্যানেজমেন্ট', group: 'Content' },
  matches_manage: { label: 'ম্যাচ/টুর্নামেন্ট ম্যানেজমেন্ট', group: 'Content' },
  settings_view: { label: 'সেটিংস দেখা', group: 'Settings' },
  settings_edit: { label: 'সেটিংস এডিট (Maintenance Mode সহ)', group: 'Settings' },
  roles_manage: { label: 'Role ও Permission ম্যানেজমেন্ট', group: 'Security' },
  activity_log_view: { label: 'অ্যাক্টিভিটি লগ দেখা', group: 'Security' },
  bot_monitoring_manage: { label: 'Bot Monitoring ও IP Block/Whitelist', group: 'Security' },
  backups_manage: { label: 'Backup তৈরি/রিস্টোর/ডিলিট', group: 'System' },
  cron_jobs_manage: { label: 'Cron Jobs enable/disable/run', group: 'System' },
  reports_view: { label: 'রিপোর্ট/ফাইন্যান্স সামারি দেখা', group: 'Reports' }
};

function permissionGroups() {
  const groups = {};
  for (const [key, meta] of Object.entries(PERMISSIONS)) {
    if (!groups[meta.group]) groups[meta.group] = [];
    groups[meta.group].push({ key, label: meta.label });
  }
  return groups;
}

// ==================== Role লুকআপ (ক্যাশড, ৩০ সেকেন্ড) ====================
async function getRoleByKey(key) {
  if (!key) return null;
  return cache.getOrSet(`role:${key}`, 30, async () => {
    const r = await pool.query('SELECT * FROM roles WHERE key = $1', [key]);
    return r.rows[0] || null;
  });
}

async function getUserPermissions(userId) {
  const r = await pool.query('SELECT role, role_key FROM users WHERE id = $1', [userId]);
  const row = r.rows[0];
  if (!row) return { isSuperAdmin: false, permissions: {} };

  // role_key সেট না থাকা admin = super_admin-সমতুল্য (backward compatible ডিফল্ট)
  if (!row.role_key) return { isSuperAdmin: row.role === 'admin', permissions: {} };

  const role = await getRoleByKey(row.role_key);
  if (!role) return { isSuperAdmin: false, permissions: {} };
  return { isSuperAdmin: role.key === 'super_admin', permissions: role.permissions || {} };
}

async function hasPermission(userId, permKey) {
  const { isSuperAdmin, permissions } = await getUserPermissions(userId);
  if (isSuperAdmin) return true;
  return permissions[permKey] === true;
}

/**
 * Express middleware factory। এই middleware বসানো রুটগুলোতে অতিরিক্ত সূক্ষ্ম-নিয়ন্ত্রণ যোগ হয়,
 * কিন্তু isAdmin গেট (role==='admin') আগে থেকেই পার হতে হবে (এটা তার বিকল্প না, সংযোজন)।
 * অনুমতি না থাকলে 403 + admin_logs-এ "UNAUTHORIZED_ACCESS" হিসেবে লগ হয়।
 */
function requirePermission(permKey) {
  return async function (req, res, next) {
    try {
      if (!req.session || !req.session.user) return res.redirect('/admin/login');
      const allowed = await hasPermission(req.session.user.id, permKey);
      if (allowed) return next();

      // routes/admin.js-এর logAdminAction এক্সপোর্ট করা নেই (module.exports = router মাত্র),
      // তাই সেই ফাইল স্পর্শ না করে এখানে সরাসরি admin_logs-এ লগ করা হচ্ছে (একই প্যাটার্ন — queue দিয়ে, ব্যর্থ হলে direct insert)
      (async () => {
        try {
          const jobId = await require('../queues').enqueueActivityLog({
            userId: req.session.user.id, username: req.session.user.username,
            actionType: 'UNAUTHORIZED_ACCESS',
            details: `প্রয়োজনীয় permission ছাড়া অ্যাক্সেসের চেষ্টা: ${permKey} (${req.method} ${req.originalUrl})`,
            ip: req.ip
          }).catch(() => null);
          if (jobId) return;
          await pool.query(
            `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address) VALUES ($1,$2,$3,$4,$5)`,
            [req.session.user.id, req.session.user.username, 'UNAUTHORIZED_ACCESS',
             `প্রয়োজনীয় permission ছাড়া অ্যাক্সেসের চেষ্টা: ${permKey} (${req.method} ${req.originalUrl})`, req.ip]
          );
        } catch (e) { console.error('UNAUTHORIZED_ACCESS log error:', e.message); }
      })();

      if (req.path.includes('/api/')) {
        return res.status(403).json({ success: false, error: 'এই অ্যাকশনের জন্য আপনার পর্যাপ্ত অনুমতি নেই।' });
      }
      req.flash && req.flash('error', '❌ এই অ্যাকশনের জন্য আপনার পর্যাপ্ত অনুমতি নেই।');
      return res.redirect('/admin');
    } catch (err) {
      console.error('requirePermission error:', err.message);
      return res.status(500).send('Permission check failed');
    }
  };
}

// ==================== Role CRUD ====================
async function listRoles() {
  const r = await pool.query(`
    SELECT r.*, COUNT(u.id)::int AS user_count
    FROM roles r LEFT JOIN users u ON u.role_key = r.key
    GROUP BY r.id ORDER BY r.is_system DESC, r.name ASC
  `);
  return r.rows;
}

async function getRole(idOrKey) {
  const r = await pool.query('SELECT * FROM roles WHERE id::text = $1 OR key = $1', [String(idOrKey)]);
  return r.rows[0] || null;
}

function sanitizeKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

async function createRole({ name, description, permissions }) {
  const key = sanitizeKey(name);
  if (!key) throw new Error('সঠিক Role নাম দিন।');
  const existing = await pool.query('SELECT 1 FROM roles WHERE key = $1', [key]);
  if (existing.rows.length) throw new Error('এই নামে ইতিমধ্যে একটা Role আছে।');
  const r = await pool.query(
    `INSERT INTO roles (key, name, description, is_system, permissions) VALUES ($1,$2,$3,false,$4) RETURNING *`,
    [key, name.trim(), description || null, JSON.stringify(permissions || {})]
  );
  return r.rows[0];
}

async function updateRole(id, { name, description, permissions }) {
  const role = await getRole(id);
  if (!role) throw new Error('Role পাওয়া যায়নি।');
  const r = await pool.query(
    `UPDATE roles SET name=$2, description=$3, permissions=$4, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [role.id, name || role.name, description ?? role.description, JSON.stringify(permissions || {})]
  );
  await cache.del(`role:${role.key}`);
  return r.rows[0];
}

async function deleteRole(id) {
  const role = await getRole(id);
  if (!role) throw new Error('Role পাওয়া যায়নি।');
  if (role.is_system) throw new Error('সিস্টেম Role (Super Admin/Admin/Moderator/Support/Finance) ডিলিট করা যাবে না।');
  const usersRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM users WHERE role_key = $1', [role.key]);
  if (usersRes.rows[0].cnt > 0) throw new Error(`এই Role-এ ${usersRes.rows[0].cnt} জন ইউজার আছে — আগে তাদের অন্য Role-এ সরান।`);
  await pool.query('DELETE FROM roles WHERE id = $1', [role.id]);
  await cache.del(`role:${role.key}`);
}

async function cloneRole(id, newName) {
  const role = await getRole(id);
  if (!role) throw new Error('Role পাওয়া যায়নি।');
  return createRole({ name: newName || `${role.name} (Copy)`, description: role.description, permissions: role.permissions });
}

async function bulkUpdatePermission(roleIds, permKey, value) {
  const roles = [];
  for (const id of roleIds) {
    const role = await getRole(id);
    if (!role) continue;
    if (role.key === 'super_admin') continue; // Super Admin সবসময় সব permission = true, override করা যাবে না
    const permissions = { ...(role.permissions || {}), [permKey]: value };
    await pool.query('UPDATE roles SET permissions=$2, updated_at=NOW() WHERE id=$1', [role.id, JSON.stringify(permissions)]);
    await cache.del(`role:${role.key}`);
    roles.push(role.name);
  }
  return roles;
}

async function assignUserRole(userId, roleKey) {
  if (roleKey) {
    const role = await getRole(roleKey);
    if (!role) throw new Error('Role পাওয়া যায়নি।');
  }
  await pool.query('UPDATE users SET role_key = $2 WHERE id = $1', [userId, roleKey || null]);
}

function exportRoles(roles) {
  return roles.map(r => ({ key: r.key, name: r.name, description: r.description, is_system: r.is_system, permissions: r.permissions }));
}

async function importRoles(data) {
  if (!Array.isArray(data)) throw new Error('সঠিক ফরম্যাটে JSON array দিন।');
  let created = 0, updated = 0, skipped = 0;
  for (const item of data) {
    if (!item.key || !item.name) { skipped++; continue; }
    const existing = await pool.query('SELECT * FROM roles WHERE key = $1', [item.key]);
    if (existing.rows.length) {
      if (existing.rows[0].is_system) { skipped++; continue; } // সিস্টেম Role import দিয়ে ওভাররাইট করা যাবে না
      await pool.query('UPDATE roles SET name=$2, description=$3, permissions=$4, updated_at=NOW() WHERE key=$1',
        [item.key, item.name, item.description || null, JSON.stringify(item.permissions || {})]);
      await cache.del(`role:${item.key}`);
      updated++;
    } else {
      await pool.query('INSERT INTO roles (key, name, description, is_system, permissions) VALUES ($1,$2,$3,false,$4)',
        [item.key, item.name, item.description || null, JSON.stringify(item.permissions || {})]);
      created++;
    }
  }
  return { created, updated, skipped };
}

module.exports = {
  PERMISSIONS, permissionGroups,
  getUserPermissions, hasPermission, requirePermission,
  listRoles, getRole, createRole, updateRole, deleteRole, cloneRole,
  bulkUpdatePermission, assignUserRole, exportRoles, importRoles
};
