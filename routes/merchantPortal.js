// routes/merchantPortal.js
// ---------------------------------------------------------------------------
// মার্চেন্ট / সাব-মার্চেন্টের ব্যাকএন্ড (/merchant)।
//
// প্রবেশ: এখন শুধু অ্যাডমিন "Login" বাটন (POST /admin/merchants/:id/login-as) দিয়ে —
// সেটা req.session.merchantPortal = { merchantId, adminId, startedAt } বসায়। অ্যাডমিনের
// নিজের req.session.user অপরিবর্তিত থাকে, তাই "Exit" চাপলেই অ্যাডমিন প্যানেলে ফেরা যায়
// এবং কোনো সেশন-বদল/পাসওয়ার্ড-শেয়ারিং লাগে না।
//
// নিরাপত্তা:
//  • isAdmin (app.js-এ মাউন্টের সময়) + merchants_manage — প্রতিটা রিকোয়েস্টে DB থেকে যাচাই,
//    তাই অ্যাডমিনকে ডিমোট/ব্যান করলে চলমান পোর্টাল-সেশনও সাথে সাথে অচল
//  • merchantPortal.adminId অবশ্যই বর্তমান সেশনের অ্যাডমিন হতে হবে (সেশন-মার্কার অন্যের নামে চলে না)
//  • API Key পেজের HTML-এ বসানো হয় না — আইকনে ক্লিক করলে POST /credentials থেকে আসে
//    (CSRF-সুরক্ষিত, Cache-Control: no-store, প্রতিটা দেখা অডিট-লগে)
//  • মার্চেন্ট নিজের সাব-ট্রি ছাড়া কিছু দেখে না — এই পেজে শুধু নিজের তথ্য ও সরাসরি সাব-মার্চেন্ট
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

const { pool } = require('../db');
const rbac = require('../services/rbac');
const creds = require('../services/merchantCredentials');
const { logAdminAction, logEvent: logAuditEvent } = require('../services/auditLog');

const requireManage = rbac.requirePermission('merchants_manage');
const ADMIN_LIST = '/admin/merchants';

function actorOf(req) {
  const u = req.session && req.session.user;
  return { id: u ? u.id : null, username: u ? u.username : 'UNKNOWN' };
}

function audit(req, actionType, details, meta, risk = 'high') {
  const actor = actorOf(req);
  logAdminAction(actor.id, actor.username, actionType, details, req.ip).catch(() => {});
  logAuditEvent({
    req, actorType: 'admin', actorId: actor.id, actorUsername: actor.username,
    action: actionType, category: 'other', status: 'success', riskLevel: risk,
    details: { ...meta, source: 'merchant_portal' }
  }).catch((e) => console.error('merchantPortal logAuditEvent error:', e.message));
}

// ---- সব রুটে: নো-ইনডেক্স, নো-ক্যাশ; পোর্টাল-সেশন মার্কার ও মার্চেন্ট যাচাই ----
router.use(requireManage);

router.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  next();
});

async function portalGuard(req, res, next) {
  const mp = req.session && req.session.merchantPortal;
  const me = actorOf(req);
  if (!mp || !mp.merchantId || mp.adminId !== me.id) {
    if (mp) delete req.session.merchantPortal;
    return res.redirect(ADMIN_LIST);
  }
  try {
    const r = await pool.query(
      `SELECT m.id, m.parent_id, m.merchant_uid, m.code, m.name, m.contact_name, m.phone, m.email,
              m.commission_rate, m.status, m.api_key_prefix, m.api_key_created_at, m.created_at,
              p.name AS parent_name, p.merchant_uid AS parent_uid
         FROM merchants m LEFT JOIN merchants p ON p.id = m.parent_id
        WHERE m.id = $1`, [mp.merchantId]
    );
    if (!r.rows.length) {
      delete req.session.merchantPortal;
      req.flash('error', req.t('merchant_err_not_found'));
      return res.redirect(ADMIN_LIST);
    }
    req.merchant = r.rows[0];
    return next();
  } catch (err) {
    console.error('merchantPortal guard error:', err && err.stack ? err.stack : err);
    req.flash('error', req.t('merchant_err_load'));
    return res.redirect(ADMIN_LIST);
  }
}
router.use(portalGuard);

// ==================== GET / — ড্যাশবোর্ড ====================
router.get('/', async (req, res) => {
  try {
    const subs = await pool.query(
      `SELECT id, merchant_uid, name, commission_rate, status, created_at
         FROM merchants WHERE parent_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
      [req.merchant.id]
    );
    res.render('merchant/dashboard', {
      user: req.session.user,
      merchant: req.merchant,
      subMerchants: subs.rows
    });
  } catch (err) {
    console.error('merchantPortal dashboard error:', err && err.stack ? err.stack : err);
    req.flash('error', req.t('merchant_err_load'));
    res.redirect(ADMIN_LIST);
  }
});

// ==================== POST /credentials — রেবিট আইকনে ক্লিক ====================
// GET নয়: ক্রেডেনশিয়াল লিংক-প্রিফেচ/ছবি-ট্যাগ/ক্যাশে পড়ার সুযোগ রাখা হয়নি।
router.post('/credentials', async (req, res) => {
  const m = req.merchant;
  try {
    const r = await pool.query('SELECT api_key_enc, api_key_created_at FROM merchants WHERE id = $1', [m.id]);
    const raw = creds.revealApiKey(r.rows[0] && r.rows[0].api_key_enc);
    if (!raw) {
      // কী নেই, বা এনক্রিপশন-কী বদলে গেছে — অ্যাডমিন "Regenerate key" দিয়ে সারাবে
      return res.status(409).json({ success: false, error: req.t('merchant_portal_key_unavailable') });
    }
    audit(req, 'MERCHANT_CREDENTIALS_VIEWED',
      `মার্চেন্ট পোর্টালে ক্রেডেনশিয়াল দেখা হয়েছে: ${m.merchant_uid} (#${m.id})`,
      { merchantId: m.id, merchantUid: m.merchant_uid });
    return res.json({
      success: true,
      merchantId: m.merchant_uid,
      apiKey: raw,
      createdAt: r.rows[0].api_key_created_at
    });
  } catch (err) {
    console.error('merchantPortal credentials error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: req.t('merchant_err_load') });
  }
});

// ==================== POST /exit — অ্যাডমিন প্যানেলে ফেরা ====================
router.post('/exit', (req, res) => {
  const m = req.merchant;
  delete req.session.merchantPortal;
  audit(req, 'MERCHANT_PORTAL_EXIT', `মার্চেন্ট পোর্টাল থেকে বের হওয়া: ${m.merchant_uid} (#${m.id})`,
    { merchantId: m.id, merchantUid: m.merchant_uid }, 'low');
  return req.session.save(() => res.redirect(ADMIN_LIST));
});

module.exports = router;
