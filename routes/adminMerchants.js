// routes/adminMerchants.js
// ---------------------------------------------------------------------------
// Admin → Merchant Management (/admin/merchants)।
//
// মার্চেন্ট ও সাব-মার্চেন্ট হায়ারার্কি: merchants.parent_id নিজের টেবিলকেই রেফার করে
// (NULL = টপ-লেভেল মার্চেন্ট)। একটা পেজে লিস্ট + তৈরি + এডিট (?edit=ID) — ভিউ:
// views/admin/merchants.ejs।
//
// নিরাপত্তা (routes/adminLeaderboard.js-এর প্যাটার্নেই):
//  • isAdmin — app.js-এ মাউন্টের সময় বসানো
//  • rbac.requirePermission('merchants_manage') — প্রতিটা রুটে (GET সহ)। নতুন key হওয়ায়
//    বিদ্যমান role রো-তে নেই; super_admin (ও role_key=NULL admin) সরাসরি পায়, বাকিদের
//    Permission Matrix থেকে দিতে হবে।
//  • CSRF — গ্লোবাল middleware/csrf.js (ফর্মে হিডেন _csrf অটো-ইনজেক্ট হয়)
//  • Audit — প্রতিটা পরিবর্তন admin_logs + audit_logs-এ
//  • সব SQL প্যারামিটারাইজড; সার্চের LIKE মেটাক্যারেক্টার escape করা
//
// হায়ারার্কির অখণ্ডতা:
//  • চক্র (A→B→A) ও MAX_DEPTH-এর বেশি গভীরতা ঠেকানো হয় — তৈরি ও প্যারেন্ট বদলের সময়
//  • যাচাই + লেখা একই ট্রানজেকশনে, pg_advisory_xact_lock-এর নিচে — দুজন অ্যাডমিন একসাথে
//    উল্টো দিকে প্যারেন্ট বদলালে চক্র তৈরি হওয়ার race ঠেকাতে
//  • সাব-মার্চেন্ট আছে এমন মার্চেন্ট ডিলিট করা যায় না (DB-তেও ON DELETE RESTRICT)
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

const { pool } = require('../db');
const rbac = require('../services/rbac');
const { requireIntParam, clampPage } = require('../middleware/validate');
const { logAdminAction, logEvent: logAuditEvent } = require('../services/auditLog');

const PAGE_SIZE = 25;
const MAX_DEPTH = 5;                 // টপ-লেভেল = ১; সর্বোচ্চ ৫ স্তর
const STATUSES = ['active', 'suspended'];
const TREE_LOCK_KEY = 74210001;      // pg_advisory_xact_lock-এর ধ্রুব কী (merchants ট্রি)
const BASE = '/admin/merchants';

const requireManage = rbac.requirePermission('merchants_manage');

// ==================== ছোট হেল্পার ====================

function actorOf(req) {
  const u = req.session && req.session.user;
  return { id: u ? u.id : null, username: u ? u.username : 'UNKNOWN' };
}

function cleanStr(v, max) {
  if (v == null) return '';
  return String(v).trim().replace(/\s+/g, ' ').slice(0, max);
}

function parseOptionalId(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { ok: true, value: null };
  if (!/^\d{1,9}$/.test(String(v).trim())) return { ok: false, value: null };
  const n = parseInt(v, 10);
  return n > 0 ? { ok: true, value: n } : { ok: false, value: null };
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * ফর্ম ইনপুট যাচাই। ব্যর্থ হলে { errorKey }, সফল হলে { values }।
 * errorKey হলো locales-এর key (req.t দিয়ে অনুবাদ হয়)।
 */
function parseMerchantForm(body) {
  const b = body || {};
  const code = cleanStr(b.code, 30).toUpperCase();
  if (!/^[A-Z0-9_-]{2,30}$/.test(code)) return { errorKey: 'merchant_err_code' };

  const name = cleanStr(b.name, 100);
  if (!name) return { errorKey: 'merchant_err_name' };

  const email = cleanStr(b.email, 150).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { errorKey: 'merchant_err_email' };

  const phone = cleanStr(b.phone, 30);
  if (phone && !/^[0-9+\-() ]{5,30}$/.test(phone)) return { errorKey: 'merchant_err_phone' };

  const rateRaw = String(b.commission_rate == null || b.commission_rate === '' ? '0' : b.commission_rate).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(rateRaw)) return { errorKey: 'merchant_err_commission' };
  const commission = parseFloat(rateRaw);
  if (commission < 0 || commission > 100) return { errorKey: 'merchant_err_commission' };

  const status = STATUSES.includes(b.status) ? b.status : 'active';

  const parent = parseOptionalId(b.parent_id);
  if (!parent.ok) return { errorKey: 'merchant_err_parent_missing' };
  const user = parseOptionalId(b.user_id);
  if (!user.ok) return { errorKey: 'merchant_err_user_missing' };

  return {
    values: {
      code, name,
      contact_name: cleanStr(b.contact_name, 100) || null,
      phone: phone || null,
      email: email || null,
      commission_rate: commission,
      status,
      notes: cleanStr(b.notes, 1000) || null,
      parent_id: parent.value,
      user_id: user.value
    }
  };
}

/** একটা ট্রানজেকশনে tree-lock নিয়ে fn(client) চালায়। */
async function withTreeLock(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [TREE_LOCK_KEY]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** HierarchyError — যাচাই ব্যর্থ হলে errorKey সহ থ্রো হয়, ধরে ফ্ল্যাশ করা হয়। */
class HierarchyError extends Error {
  constructor(errorKey) { super(errorKey); this.errorKey = errorKey; }
}

/**
 * parentId-কে প্যারেন্ট বানানো বৈধ কিনা। merchantId = null হলে নতুন তৈরি।
 * client-এর ট্রানজেকশনের ভেতরে চালাতে হবে (tree-lock ধরা অবস্থায়)।
 */
async function assertValidParent(client, merchantId, parentId) {
  if (parentId == null) return;
  const up = await client.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, 1 AS depth FROM merchants WHERE id = $1
       UNION ALL
       SELECT m.id, m.parent_id, up.depth + 1 FROM merchants m JOIN up ON m.id = up.parent_id WHERE up.depth < 50
     ) SELECT id, depth FROM up`,
    [parentId]
  );
  if (!up.rows.length) throw new HierarchyError('merchant_err_parent_missing');
  if (merchantId != null && up.rows.some((r) => r.id === merchantId)) throw new HierarchyError('merchant_err_cycle');

  const parentDepth = Math.max(...up.rows.map((r) => r.depth));
  let height = 1;
  if (merchantId != null) {
    const down = await client.query(
      `WITH RECURSIVE down AS (
         SELECT id, 1 AS depth FROM merchants WHERE id = $1
         UNION ALL
         SELECT m.id, down.depth + 1 FROM merchants m JOIN down ON m.parent_id = down.id WHERE down.depth < 50
       ) SELECT COALESCE(MAX(depth), 1) AS h FROM down`,
      [merchantId]
    );
    height = parseInt(down.rows[0].h, 10) || 1;
  }
  if (parentDepth + height > MAX_DEPTH) throw new HierarchyError('merchant_err_depth');
}

async function assertUserExists(client, userId) {
  if (userId == null) return;
  const r = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!r.rows.length) throw new HierarchyError('merchant_err_user_missing');
}

/** DB constraint ত্রুটি → ব্যবহারবান্ধব errorKey (না মিললে null)। */
function constraintErrorKey(err) {
  if (!err) return null;
  if (err.code === '23505') {
    if (String(err.constraint || '').includes('user_id')) return 'merchant_err_user_taken';
    return 'merchant_err_code_taken';
  }
  if (err.code === '23503') return 'merchant_err_has_children';
  return null;
}

function audit(req, actionType, details, meta, risk = 'medium') {
  const actor = actorOf(req);
  logAdminAction(actor.id, actor.username, actionType, details, req.ip).catch(() => {});
  logAuditEvent({
    req, actorType: 'admin', actorId: actor.id, actorUsername: actor.username,
    action: actionType, category: 'other', status: 'success', riskLevel: risk,
    details: { ...meta, source: 'admin_merchants' }
  }).catch((e) => console.error('adminMerchants logAuditEvent error:', e.message));
}

function flashAndRedirect(req, res, kind, key, to = BASE) {
  req.flash(kind, req.t(key));
  return res.redirect(to);
}

// ==================== GET / — লিস্ট + তৈরি/এডিট ফর্ম ====================

router.get('/', requireManage, async (req, res) => {
  try {
    const q = cleanStr(req.query.q, 100);
    const status = STATUSES.includes(req.query.status) ? req.query.status : '';
    const parentFilter = cleanStr(req.query.parent, 12);
    const page = clampPage(req.query.page);

    const where = [];
    const params = [];
    if (q) {
      params.push('%' + escapeLike(q) + '%');
      const i = params.length;
      where.push(`(m.name ILIKE $${i} OR m.code ILIKE $${i} OR m.email ILIKE $${i} OR m.phone ILIKE $${i} OR m.contact_name ILIKE $${i})`);
    }
    if (status) { params.push(status); where.push(`m.status = $${params.length}`); }
    if (parentFilter === 'root') {
      where.push('m.parent_id IS NULL');
    } else if (/^\d{1,9}$/.test(parentFilter)) {
      params.push(parseInt(parentFilter, 10));
      where.push(`m.parent_id = $${params.length}`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const totalRes = await pool.query(`SELECT COUNT(*)::int AS c FROM merchants m ${whereSql}`, params);
    const total = totalRes.rows[0].c;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);

    const listParams = [...params, PAGE_SIZE, (safePage - 1) * PAGE_SIZE];
    const rows = await pool.query(
      `SELECT m.*, p.name AS parent_name, p.code AS parent_code, u.username AS user_username,
              (SELECT COUNT(*)::int FROM merchants c WHERE c.parent_id = m.id) AS child_count
         FROM merchants m
         LEFT JOIN merchants p ON p.id = m.parent_id
         LEFT JOIN users u ON u.id = m.user_id
         ${whereSql}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    const statsRes = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
              COUNT(*) FILTER (WHERE parent_id IS NOT NULL)::int AS sub
         FROM merchants`
    );

    // প্যারেন্ট ড্রপডাউন (সর্বোচ্চ ৫০০; খুব বড় তালিকায় সার্চ-ফিল্টার ব্যবহার করুন)
    const parents = await pool.query(`SELECT id, code, name FROM merchants ORDER BY name ASC LIMIT 500`);

    let editing = null;
    if (req.query.edit && /^\d{1,9}$/.test(String(req.query.edit))) {
      const er = await pool.query('SELECT * FROM merchants WHERE id = $1', [parseInt(req.query.edit, 10)]);
      editing = er.rows[0] || null;
    }

    res.render('admin/merchants', {
      merchants: rows.rows,
      total, page: safePage, totalPages, pageSize: PAGE_SIZE,
      filters: { q, status, parent: parentFilter },
      stats: statsRes.rows[0],
      parents: parents.rows,
      editing,
      maxDepth: MAX_DEPTH
    });
  } catch (err) {
    console.error('admin/merchants list error:', err && err.stack ? err.stack : err);
    req.flash('error', req.t('merchant_err_load'));
    res.redirect('/admin');
  }
});

// ==================== POST / — নতুন মার্চেন্ট / সাব-মার্চেন্ট ====================

router.post('/', requireManage, async (req, res) => {
  const parsed = parseMerchantForm(req.body);
  if (parsed.errorKey) return flashAndRedirect(req, res, 'error', parsed.errorKey);
  const v = parsed.values;
  const actor = actorOf(req);

  try {
    const created = await withTreeLock(async (client) => {
      await assertValidParent(client, null, v.parent_id);
      await assertUserExists(client, v.user_id);
      const r = await client.query(
        `INSERT INTO merchants (parent_id, user_id, code, name, contact_name, phone, email, commission_rate, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [v.parent_id, v.user_id, v.code, v.name, v.contact_name, v.phone, v.email, v.commission_rate, v.status, v.notes, actor.id]
      );
      return r.rows[0];
    });
    audit(req, 'MERCHANT_CREATED',
      `মার্চেন্ট তৈরি: ${v.code} — ${v.name} (#${created.id})${v.parent_id ? `, প্যারেন্ট #${v.parent_id}` : ''}`,
      { merchantId: created.id, code: v.code, parentId: v.parent_id, commission: v.commission_rate });
    return flashAndRedirect(req, res, 'success', 'merchant_created');
  } catch (err) {
    const key = err instanceof HierarchyError ? err.errorKey : constraintErrorKey(err);
    if (!key) console.error('admin/merchants create error:', err && err.stack ? err.stack : err);
    return flashAndRedirect(req, res, 'error', key || 'merchant_err_save');
  }
});

// ==================== POST /:id — আপডেট (প্যারেন্ট বদলসহ) ====================

router.post('/:id', requireManage, requireIntParam('id', BASE), async (req, res) => {
  const id = req.params.id;
  const parsed = parseMerchantForm(req.body);
  if (parsed.errorKey) return flashAndRedirect(req, res, 'error', parsed.errorKey, `${BASE}?edit=${id}`);
  const v = parsed.values;

  try {
    const result = await withTreeLock(async (client) => {
      const cur = await client.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [id]);
      if (!cur.rows.length) throw new HierarchyError('merchant_err_not_found');
      const before = cur.rows[0];
      if (v.parent_id !== before.parent_id) await assertValidParent(client, id, v.parent_id);
      if (v.user_id !== before.user_id) await assertUserExists(client, v.user_id);
      await client.query(
        `UPDATE merchants SET parent_id=$1, user_id=$2, code=$3, name=$4, contact_name=$5, phone=$6, email=$7,
                commission_rate=$8, status=$9, notes=$10, updated_at=NOW()
          WHERE id=$11`,
        [v.parent_id, v.user_id, v.code, v.name, v.contact_name, v.phone, v.email, v.commission_rate, v.status, v.notes, id]
      );
      return before;
    });
    const changed = [];
    if (result.parent_id !== v.parent_id) changed.push(`parent ${result.parent_id || '-'}→${v.parent_id || '-'}`);
    if (parseFloat(result.commission_rate) !== v.commission_rate) changed.push(`commission ${result.commission_rate}→${v.commission_rate}`);
    if (result.status !== v.status) changed.push(`status ${result.status}→${v.status}`);
    audit(req, 'MERCHANT_UPDATED',
      `মার্চেন্ট আপডেট: ${v.code} (#${id})${changed.length ? ' [' + changed.join(', ') + ']' : ''}`,
      { merchantId: id, code: v.code, changes: changed });
    return flashAndRedirect(req, res, 'success', 'merchant_updated');
  } catch (err) {
    const key = err instanceof HierarchyError ? err.errorKey : constraintErrorKey(err);
    if (!key) console.error('admin/merchants update error:', err && err.stack ? err.stack : err);
    return flashAndRedirect(req, res, 'error', key || 'merchant_err_save', `${BASE}?edit=${id}`);
  }
});

// ==================== POST /:id/status — active ⇄ suspended ====================

router.post('/:id/status', requireManage, requireIntParam('id', BASE), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE merchants
          SET status = CASE WHEN status = 'active' THEN 'suspended' ELSE 'active' END, updated_at = NOW()
        WHERE id = $1 RETURNING code, status`,
      [req.params.id]
    );
    if (!r.rows.length) return flashAndRedirect(req, res, 'error', 'merchant_err_not_found');
    audit(req, 'MERCHANT_STATUS_CHANGED',
      `মার্চেন্ট ${r.rows[0].code} (#${req.params.id}) স্ট্যাটাস → ${r.rows[0].status}`,
      { merchantId: req.params.id, status: r.rows[0].status });
    return flashAndRedirect(req, res, 'success', 'merchant_status_changed');
  } catch (err) {
    console.error('admin/merchants status error:', err && err.stack ? err.stack : err);
    return flashAndRedirect(req, res, 'error', 'merchant_err_save');
  }
});

// ==================== POST /:id/delete — শুধু সাব-মার্চেন্টবিহীন মার্চেন্ট ====================

router.post('/:id/delete', requireManage, requireIntParam('id', BASE), async (req, res) => {
  try {
    const r = await withTreeLock(async (client) => {
      const kids = await client.query('SELECT COUNT(*)::int AS c FROM merchants WHERE parent_id = $1', [req.params.id]);
      if (kids.rows[0].c > 0) throw new HierarchyError('merchant_err_has_children');
      return client.query('DELETE FROM merchants WHERE id = $1 RETURNING code, name', [req.params.id]);
    });
    if (!r.rows.length) return flashAndRedirect(req, res, 'error', 'merchant_err_not_found');
    audit(req, 'MERCHANT_DELETED',
      `মার্চেন্ট ডিলিট: ${r.rows[0].code} — ${r.rows[0].name} (#${req.params.id})`,
      { merchantId: req.params.id, code: r.rows[0].code }, 'high');
    return flashAndRedirect(req, res, 'success', 'merchant_deleted');
  } catch (err) {
    const key = err instanceof HierarchyError ? err.errorKey : constraintErrorKey(err);
    if (!key) console.error('admin/merchants delete error:', err && err.stack ? err.stack : err);
    return flashAndRedirect(req, res, 'error', key || 'merchant_err_save');
  }
});

module.exports = router;
// টেস্টের জন্য (tests/unit/adminMerchants.test.js) — রুটের আচরণে প্রভাব নেই
module.exports.parseMerchantForm = parseMerchantForm;
module.exports.escapeLike = escapeLike;
module.exports.MAX_DEPTH = MAX_DEPTH;
