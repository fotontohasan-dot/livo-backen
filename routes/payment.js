const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const { createBonus, canWithdraw } = require('../services/turnover');
const { processReferralDeposit } = require('../services/referral');
const paymentMethods = require('../services/paymentMethods');
const rbac = require('../services/rbac');
const { logEvent: logAuditEvent } = require('../services/auditLog');
const { PublicError, publicMessage } = require('../utils/safeError');
const businessTime = require('../utils/businessTime');
const { requireFeature } = require('../middleware/featureGate');
const { verifyPin, getPinStatus } = require('../services/withdrawPin');
const withdrawalWindowSvc = require('../services/withdrawalWindow');
const { requireWithdrawalWindow, attachWithdrawalWindow } = require('../middleware/withdrawalWindow');

const { isAuth, requireVerifiedEmail, requireApprovedKyc } = require('../middleware/auth');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getBaseUrl } = require('../utils/publicUrl');
const sslcommerz = require('../services/sslcommerz');
const paymentVerification = require('../services/paymentVerification');
const RedisRateLimitStore = require('../services/redisRateLimitStore');

// ডিপোজিট/উইথড্র/গেটওয়ে endpoint-গুলোর জন্য rate limit। bd8b1b2-এর rewrite-এ এটা
// হারিয়ে গিয়েছিল, ফলে পেমেন্ট রুটগুলো সম্পূর্ণ unthrottled ছিল।
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: (req) => req.t('common_rate_limited'),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:payment:')
});

async function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.role === 'admin') return next();
  // সেশন তৈরির পর কাউকে সরাসরি DB-তে admin করা হলে (যেমন টেস্টের
  // register→UPDATE role প্যাটার্ন, বা ম্যানুয়াল প্রমোশনের পরপরই যদি
  // ওই ইউজার রি-লগইন না করে থাকেন) — সেশনে cached পুরনো role থেকে যায়,
  // ফলে আসল admin-ও ব্লক হয়ে যেতেন। এখানে একবার DB থেকে ঝালিয়ে দেখা হয়,
  // শুধু তখনই যখন সেশন ইতিমধ্যে 'admin' বলছে না (তাই সাধারণ পথে এক্সট্রা
  // কোয়েরি লাগে না)।
  try {
    const row = await pool.query('SELECT role FROM users WHERE id=$1', [req.session.user.id]);
    if (row.rows[0] && row.rows[0].role === 'admin') {
      req.session.user.role = 'admin';
      return next();
    }
  } catch (e) { /* নিচের fail-closed redirect-এ যাবে */ }
  return res.redirect('/');
}

function parseAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function notifyAdmins(title, message) {
  try {
    const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    for (const a of admins.rows) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
        [a.id, title, message]
      );
    }
  } catch (e) {
    console.error('notifyAdmins error:', e.message);
  }
}

// ==================== রিলোড বোনাসের হার ====================
// কততম ডিপোজিট ও কোন বার অনুযায়ী বোনাস শতাংশ ঠিক হয়।
//  ১ম ডিপোজিট: ১০০%
//  ২য় ডিপোজিট: ৫০%
//  শুক্রবার (যেকোনো ডিপোজিট): ৮০% (রিলোড)
//  ৩য়+ সাধারণ দিন: ১৫%
//  সর্বোচ্চ বোনাস ১৫০০০ কয়েন
function bonusPercentFor(depositCountBefore, isFriday) {
  if (depositCountBefore === 0) return 100;   // প্রথম ডিপোজিট
  if (isFriday) return 80;                      // শুক্রবার রিলোড
  if (depositCountBefore === 1) return 50;      // দ্বিতীয় ডিপোজিট
  return 15;                                    // সাধারণ রিলোড
}
const MAX_BONUS = 15000;

const VALID_METHODS = ['bkash', 'nagad', 'rocket', 'upay', 'bank', 'crypto'];

router.get('/deposit', isAuth, requireFeature('deposit'), async (req, res) => {
  let channelsByMethod = {};
  try {
    const ch = await pool.query(
      `SELECT * FROM payment_channels WHERE active = true ORDER BY method, sort_order, id`
    );
    ch.rows.forEach(row => {
      if (!channelsByMethod[row.method]) channelsByMethod[row.method] = [];
      channelsByMethod[row.method].push(row);
    });
  } catch (e) {
    console.error('load payment_channels error:', e.message);
  }

  // নম্বর এখন payment_methods (অ্যাডমিন-নিয়ন্ত্রিত) থেকে আসে — আগের
  // হার্ডকোড করা DEPOSIT_NUMBERS/rotation সরানো হয়েছে। ক্যোয়ারি ব্যর্থ হলে
  // পেজ ভাঙে না — শুধু একটা এরর ব্যানার দেখায় (নিচে loadError)।
  let payNumber = '';
  let loadError = false;
  try {
    const methods = await paymentMethods.listActivePublic();
    const preferred = methods.find(m => m.method === 'bkash') || methods[0];
    payNumber = preferred ? preferred.accountNumber : '';
  } catch (e) {
    console.error('load payment_methods error:', e.message);
    loadError = true;
  }

  res.render('payment/deposit', {
    user: req.session.user,
    payNumber,
    channelsByMethod,
    loadError
  });
});

// ইউজার ডিপোজিট পেজ — active পেমেন্ট মেথড/নম্বরের JSON তালিকা (পাবলিক ফিল্ড মাত্র)
router.get('/deposit/methods', isAuth, async (req, res) => {
  try {
    const methods = await paymentMethods.listActivePublic();
    res.json({ success: true, methods });
  } catch (err) {
    console.error('deposit/methods error:', err.message);
    res.status(500).json({ success: false, error: req.t('payment_methods_load_failed') });
  }
});

router.post('/deposit', isAuth, requireFeature('deposit'), async (req, res) => {
  const { method, transaction_id, account_number } = req.body;
  const wantBonus = req.body.want_bonus === 'yes';
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;
  let channelId = req.body.channel_id ? parseInt(req.body.channel_id, 10) : null;
  if (!Number.isInteger(channelId)) channelId = null;

  if (!VALID_METHODS.includes(method)) {
    req.flash('error', req.t('payment_invalid_method'));
    return res.redirect('/payment/deposit');
  }
  if (!method || amount === null || !transaction_id || !account_number) {
    req.flash('error', req.t('payment_all_fields_required'));
    return res.redirect('/payment/deposit');
  }

  if (channelId !== null) {
    try {
      const chk = await pool.query(
        `SELECT id FROM payment_channels WHERE id=$1 AND method=$2 AND active=true`,
        [channelId, method]
      );
      if (chk.rowCount === 0) channelId = null; // ignore mismatched/invalid channel silently
    } catch (e) {
      channelId = null;
    }
  }
  if (amount < 100) {
    req.flash('error', req.t('payment_min_deposit_100'));
    return res.redirect('/payment/deposit');
  }

  // ==== Duplicate Transaction ID ব্লক ====
  // bd8b1b2-এর rewrite-এ এই চেকটা সম্পূর্ণ হারিয়ে গিয়েছিল — অর্থাৎ যেকোনো
  // TrxID যতবার খুশি, যেকোনো অ্যাকাউন্ট থেকে দাবি করা যাচ্ছিল।
  //
  // দুটো আলাদা নিয়ম, কারণ ঝুঁকিও আলাদা:
  //
  //   ১. **অন্য ইউজারের ব্যবহার করা TrxID** — status যাই হোক, সবসময় ব্লক।
  //      একই পেমেন্ট রেফারেন্স দুই অ্যাকাউন্টে বসানো মানে payment identity
  //      confusion — কোন জমাটা আসলে কার, রেকর্ড থেকে আর বলা যায় না।
  //
  //   ২. **নিজের rejected TrxID** — আবার সাবমিট করা যাবে। টাইপো করে reject
  //      হওয়া আইডি শুদ্ধ করে দেওয়ার বৈধ প্রয়োজন আছে, আর নিজের রেকর্ডে
  //      পরিচয়-বিভ্রান্তির ঝুঁকি নেই।
  try {
    const dupCheck = await pool.query(
      `SELECT id FROM payment_requests
       WHERE type='deposit' AND method=$1 AND transaction_id=$2
         AND (user_id <> $3 OR status <> 'rejected')
       LIMIT 1`,
      [method, transaction_id, userId]
    );
    if (dupCheck.rows.length > 0) {
      req.flash('error', req.t('payment_duplicate_transaction_id'));
      return res.redirect('/payment/deposit');
    }
  } catch (e) {
    console.error('duplicate trx_id check error:', e.message);
  }

  // দৈনিক লিমিট-চেক ও INSERT একই ট্রানজেকশনে, users রো-তে FOR UPDATE লক সহ —
  // আগে দুটো আলাদা pool.query() ছিল, তাই একই মুহূর্তে দুটো রিকোয়েস্ট একসাথে
  // লিমিট চেক পাস করে দুটোই ঢুকে যেতে পারত (race condition)। দিনের সীমানাও
  // এখন ব্যবসায়িক টাইমজোন (Asia/Dhaka) থেকে, DB সার্ভারের CURRENT_DATE (UTC) নয়।
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(`SELECT daily_deposit_limit FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const limit = u.rows[0] && u.rows[0].daily_deposit_limit ? Number(u.rows[0].daily_deposit_limit) : null;
    if (limit) {
      const todayDep = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests
         WHERE user_id = $1 AND type = 'deposit' AND status != 'rejected'
           AND created_at >= $2`,
        [userId, businessTime.startOfDay()]
      );
      const already = Number(todayDep.rows[0].total);
      if (already + amount > limit) {
        await client.query('ROLLBACK');
        req.flash('error', req.t('payment_deposit_limit_hit').replace('{value}', limit).replace('{value2}', Math.max(0, limit - already)));
        return res.redirect('/payment/deposit');
      }
    }

    await client.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status, want_bonus, channel_id) VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending', $6, $7)`,
      [userId, method, amount, transaction_id, account_number, wantBonus, channelId]
    );
    await client.query('COMMIT');
    await notifyAdmins('নতুন ডিপোজিট রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা ডিপোজিট চেয়েছে (${method})।`);
    req.flash('success', req.t('payment_deposit_request_sent'));
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deposit error:', err.message);
    req.flash('error', req.t('payment_generic_error'));
    res.redirect('/payment/deposit');
  } finally {
    client.release();
  }
});

// ==================== অ্যাডমিন: পেমেন্ট মেথড (ডিপোজিট অ্যাকাউন্ট) ম্যানেজমেন্ট ====================
// services/paymentMethods.js-এর উপর পাতলা রুট লেয়ার — সব ভ্যালিডেশন/normalization
// ওই সার্ভিসেই। এখানে শুধু: permission গেট, allowlisted ইনপুট (mass-assignment
// প্রতিরোধ), CSRF (গ্লোবাল middleware/csrf.js), আর প্রতিটা mutation-এ audit log।

function paymentMethodActor(req) {
  return {
    id: req.session && req.session.user ? req.session.user.id : null,
    username: req.session && req.session.user ? req.session.user.username : 'UNKNOWN'
  };
}

async function auditPaymentMethodEvent(req, action, record) {
  const actor = paymentMethodActor(req);
  await logAuditEvent({
    req,
    actorType: 'admin',
    actorId: actor.id,
    actorUsername: actor.username,
    action,
    category: 'settings',
    riskLevel: 'medium',
    details: {
      recordId: record.id,
      method: record.method,
      accountNumberMasked: paymentMethods.maskAccountNumber(record.account_number)
    }
  });
}

router.get('/admin/payment-methods', rbac.requirePermission('payment_methods_manage'), async (req, res) => {
  try {
    const { method, status } = req.query;
    const methods = await paymentMethods.listForAdmin({ method, status });
    res.render('payment/admin-payment-methods', {
      user: req.session.user,
      methods,
      methodKeys: paymentMethods.METHOD_KEYS,
      accountTypes: paymentMethods.ACCOUNT_TYPES,
      filter: { method: method || '', status: status || '' }
    });
  } catch (err) {
    console.error('admin payment-methods list error:', err.message);
    res.render('payment/admin-payment-methods', {
      user: req.session.user,
      methods: [],
      methodKeys: paymentMethods.METHOD_KEYS,
      accountTypes: paymentMethods.ACCOUNT_TYPES,
      filter: { method: '', status: '' }
    });
  }
});

router.post('/admin/payment-methods', rbac.requirePermission('payment_methods_manage'), async (req, res) => {
  try {
    // allowlist — req.body সরাসরি পাস করা হয় না, তাই created_by/deleted_at/id
    // ইত্যাদি ক্লায়েন্ট mass-assign করতে পারে না।
    const created = await paymentMethods.create({
      method: req.body.method,
      accountNumber: req.body.account_number,
      accountName: req.body.account_name,
      status: req.body.status,
      accountType: req.body.account_type
    }, req.session.user.id);
    await auditPaymentMethodEvent(req, 'PAYMENT_METHOD_CREATED', created);
    req.flash('success', req.t('payment_method_created'));
  } catch (err) {
    req.flash('error', publicMessage(err, req.t('payment_method_create_failed')));
  }
  res.redirect('/payment/admin/payment-methods');
});

router.post('/admin/payment-methods/:id/update', rbac.requirePermission('payment_methods_manage'), async (req, res) => {
  try {
    const { after } = await paymentMethods.update(req.params.id, {
      method: req.body.method,
      accountNumber: req.body.account_number,
      accountName: req.body.account_name,
      status: req.body.status,
      accountType: req.body.account_type
    }, req.session.user.id);
    if (after) await auditPaymentMethodEvent(req, 'PAYMENT_METHOD_UPDATED', after);
    req.flash('success', req.t('payment_method_updated'));
  } catch (err) {
    req.flash('error', publicMessage(err, req.t('payment_method_update_failed')));
  }
  res.redirect('/payment/admin/payment-methods');
});

router.post('/admin/payment-methods/:id/status', rbac.requirePermission('payment_methods_manage'), async (req, res) => {
  try {
    const { after } = await paymentMethods.setStatus(req.params.id, req.body.status, req.session.user.id);
    if (after) await auditPaymentMethodEvent(req, 'PAYMENT_METHOD_STATUS_CHANGED', after);
  } catch (err) {
    req.flash('error', publicMessage(err, req.t('common_status_change_failed')));
  }
  res.redirect('/payment/admin/payment-methods');
});

router.post('/admin/payment-methods/:id/delete', rbac.requirePermission('payment_methods_manage'), async (req, res) => {
  try {
    const removed = await paymentMethods.remove(req.params.id, req.session.user.id);
    await auditPaymentMethodEvent(req, 'PAYMENT_METHOD_DELETED', removed);
    req.flash('success', req.t('payment_method_deleted'));
  } catch (err) {
    req.flash('error', publicMessage(err, req.t('common_delete_failed')));
  }
  res.redirect('/payment/admin/payment-methods');
});

// ইউজার ওয়ালেট হাব — views/payment/wallet.ejs আগে থেকেই ছিল, কিন্তু কোনো
// রুট সেটা রেন্ডার করত না (/payment/wallet 404 করত)।
router.get('/admin/withdrawal-window', rbac.requirePermission('withdrawal_window_manage'), async (req, res) => {
  try {
    const config = await withdrawalWindowSvc.readConfig();
    const state = await withdrawalWindowSvc.getState();
    res.render('admin/withdrawal-window', { user: req.session.user, config, state });
  } catch (err) {
    console.error('withdrawal-window admin load error:', err.message);
    res.render('admin/withdrawal-window', { user: req.session.user, config: null, state: { open: true, timezone: 'Asia/Dhaka' }, loadError: true });
  }
});

router.post('/admin/withdrawal-window', rbac.requirePermission('withdrawal_window_manage'), async (req, res) => {
  const result = await withdrawalWindowSvc.saveConfig(req.body);
  if (!result.ok) {
    req.flash('error', result.error || req.t('common_save_failed'));
  } else {
    req.flash('success', req.t('tg_saved'));
    logAuditEvent({
      req,
      actorType: 'admin',
      actorId: req.session.user.id,
      actorUsername: req.session.user.username,
      action: 'WITHDRAWAL_WINDOW_UPDATED',
      category: 'settings',
      riskLevel: 'medium',
      details: { mode: req.body.mode, start: req.body.start, end: req.body.end, timezone: req.body.timezone }
    }).catch((e) => console.error('audit log error:', e.message));
  }
  res.redirect('/payment/admin/withdrawal-window');
});

router.get('/wallet', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const u = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    const coins = Number(u.rows[0]?.coins) || 0;

    let cardCount = 0;
    try {
      const cardRes = await pool.query('SELECT COUNT(*) FROM bank_cards WHERE user_id=$1', [userId]);
      cardCount = parseInt(cardRes.rows[0].count, 10) || 0;
    } catch (e) { /* bank_cards টেবিল/কলাম না থাকলেও ওয়ালেট পেজ ভাঙবে না */ }

    const statsRes = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND status='approved'), 0) AS total_deposit,
         COALESCE(SUM(amount) FILTER (WHERE type='withdraw' AND status='approved'), 0) AS total_withdraw,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND status='approved' AND created_at >= $2), 0) AS deposit_30d,
         COALESCE(SUM(amount) FILTER (WHERE type='withdraw' AND status='approved' AND created_at >= $2), 0) AS withdraw_30d,
         COUNT(*) FILTER (WHERE status='pending') AS pending_count
       FROM payment_requests WHERE user_id = $1`,
      [userId, businessTime.startOfDay(businessTime.addDays(businessTime.today(), -30))]
    );
    const s = statsRes.rows[0];
    const walletStats = {
      totalDeposit: Number(s.total_deposit) || 0,
      totalWithdraw: Number(s.total_withdraw) || 0,
      deposit30d: Number(s.deposit_30d) || 0,
      withdraw30d: Number(s.withdraw_30d) || 0,
      pendingCount: parseInt(s.pending_count, 10) || 0
    };

    const txRes = await pool.query(
      `SELECT type, method, amount, status, created_at FROM payment_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [userId]
    );

    res.render('payment/wallet', {
      user: req.session.user,
      coins,
      cardCount,
      walletStats,
      recentTx: txRes.rows
    });
  } catch (err) {
    console.error('wallet load error:', err.message);
    req.flash('error', req.t('payment_wallet_load_failed'));
    return res.redirect('/profile');
  }
});

router.get('/withdraw', isAuth, requireFeature('withdrawal'), attachWithdrawalWindow(), async (req, res) => {
  try {
    // ব্যালেন্স আর PIN স্ট্যাটাস আলাদা করে আনা হয়। আগে দুটো একসাথে
    // `SELECT coins, withdraw_pin_hash` দিয়ে আনা হতো আর ব্যর্থ হলে একটা
    // fallback ০ কয়েন বসিয়ে দিত — অর্থাৎ ব্যালেন্স আনা না গেলেও পেজটা
    // "৳ ০.০০" দেখিয়ে রেন্ডার হয়ে যেত। টাকার পেজে এটা সবচেয়ে খারাপ
    // ধরনের নীরব ব্যর্থতা, তাই এখন এরর উপরের catch-এ যায়।
    //
    // pg ড্রাইভার NUMERIC(14,2) কলাম স্ট্রিং হিসেবে ফেরত দেয় ("1499.00"),
    // Number() না করলে টেমপ্লেটের (coins || 0).toFixed(2) ক্র্যাশ করত।
    const result = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    const coins = Number(result.rows[0]?.coins) || 0;

    // PIN স্ট্যাটাস আনতে না পারা মারাত্মক নয় — সেক্ষেত্রে fail-closed ধরে
    // নেওয়া হয় (PIN নেই), ফলে ফর্মটা gated থাকে।
    let hasWithdrawPin = false;
    try {
      const pinStatus = await getPinStatus(req.session.user.id);
      hasWithdrawPin = !!(pinStatus && pinStatus.configured);
    } catch (e) {
      console.error('withdraw pin status error:', e.message);
    }
    let ewalletCards = [];
    let cryptoCards = [];
    try {
      const cardRes = await pool.query('SELECT * FROM bank_cards WHERE user_id=$1 ORDER BY created_at DESC', [req.session.user.id]);
      ewalletCards = cardRes.rows.filter(c => c.wallet_kind !== 'crypto');
      cryptoCards = cardRes.rows.filter(c => c.wallet_kind === 'crypto');
    } catch (e) { /* wallet_kind column may not exist yet if migration hasn't run */ }
    res.render('payment/withdraw', {
      user: req.session.user,
      coins,
      cards: ewalletCards,
      cryptoCards,
      hasWithdrawPin
    });
  } catch (err) {
    // আগে নীরবে '/'-এ ফেলে দেওয়া হতো, কোনো বার্তা ছাড়া — ইউজারের কাছে
    // মনে হতো লিংকটাই কাজ করছে না।
    console.error('withdraw GET error:', err.message);
    req.flash('error', req.t('payment_withdraw_load_error'));
    res.redirect('/profile');
  }
});


router.post('/withdraw', isAuth, requireFeature('withdrawal'), requireWithdrawalWindow(), async (req, res) => {
  const { method, account_number, password, withdraw_pin } = req.body;
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (!VALID_METHODS.includes(method)) {
    req.flash('error', req.t('payment_invalid_method'));
    return res.redirect('/payment/withdraw');
  }
  if (!method || amount === null || !account_number) {
    req.flash('error', req.t('payment_all_fields_required'));
    return res.redirect('/payment/withdraw');
  }
  if (amount < 200) {
    req.flash('error', req.t('payment_min_withdraw_200'));
    return res.redirect('/payment/withdraw');
  }

  // ---- Login-password re-check (as already shown on the form) ----
  try {
    const u = await pool.query('SELECT password, withdraw_pin_hash FROM users WHERE id=$1', [userId]);
    const row = u.rows[0];
    if (password && row && row.password) {
      const okPass = await bcrypt.compare(password, row.password);
      if (!okPass) {
        req.flash('error', req.t('payment_password_incorrect'));
        return res.redirect('/payment/withdraw');
      }
    }
    // ---- Separate withdrawal PIN check ----
    if (row && row.withdraw_pin_hash) {
      if (!withdraw_pin) {
        req.flash('error', req.t('payment_pin_required'));
        return res.redirect('/payment/withdraw');
      }
      // bcrypt.compare সরাসরি করলে ব্রুট-ফোর্স লকআউট হতো না — verifyPin-এ
      // ব্যর্থ চেষ্টা গোনা ও ১৫-মিনিট লক-আউট আগে থেকেই বিল্ট-ইন আছে (PIN
      // পাল্টানোর নিজস্ব রুটেও এটাই ব্যবহার হয়), এখানে শুধু কল করা হয়নি এতদিন।
      const pinCheck = await verifyPin(userId, withdraw_pin, req.ip);
      if (!pinCheck.success) {
        if (pinCheck.locked) {
          const mins = Math.ceil((pinCheck.remainingMs || 0) / 60000);
          req.flash('error', req.t('payment_pin_locked').replace('{value}', mins));
        } else {
          req.flash('error', req.t('payment_pin_incorrect'));
        }
        return res.redirect('/payment/withdraw');
      }
    }
  } catch (e) {
    console.error('withdraw auth check error:', e.message);
  }

  try {
    const check = await canWithdraw(userId);
    if (!check.allowed) {
      let msg = 'উত্তোলনের আগে বোনাসের টার্নওভার পূরণ করুন। বাকি: ';
      const parts = [];
      check.pending.forEach(p => {
        if (p.sportsLeft > 0) parts.push(`স্পোর্টস ${p.sportsLeft.toFixed(0)}`);
        if (p.casinoLeft > 0) parts.push(`ক্যাসিনো ${p.casinoLeft.toFixed(0)}`);
      });
      msg += parts.join(', ');
      req.flash('error', msg);
      return res.redirect('/payment/withdraw');
    }
  } catch (e) {
    console.error('turnover check error:', e.message);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upd = await client.query(
      `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins`,
      [amount, userId]
    );

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      req.flash('error', req.t('payment_insufficient_coins'));
      return res.redirect('/payment/withdraw');
    }

    await client.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status) VALUES ($1, 'withdraw', $2, $3, $4, 'pending')`,
      [userId, method, amount, account_number]
    );

    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;

    await notifyAdmins('নতুন উইথড্র রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা উইথড্র চেয়েছে (${method})।`);

    req.flash('success', req.t('payment_withdraw_request_sent'));
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('withdraw error:', err.message);
    req.flash('error', req.t('payment_generic_error'));
    res.redirect('/payment/withdraw');
  } finally {
    client.release();
  }
});

router.get('/history', isAuth, async (req, res) => {
  const type = ['deposit', 'withdraw'].includes(req.query.type) ? req.query.type : null;
  const filter = {
    type: type || '',
    quick: ['today', 'yesterday', '7days'].includes(req.query.quick) ? req.query.quick : '',
    from: req.query.from || '',
    to: req.query.to || ''
  };
  try {
    const result = type
      ? await pool.query(
          `SELECT * FROM payment_requests WHERE user_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 50`,
          [req.session.user.id, type]
        )
      : await pool.query(
          `SELECT * FROM payment_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
          [req.session.user.id]
        );
    res.render('payment/history', { user: req.session.user, requests: result.rows, filter });
  } catch (err) {
    console.error('history error:', err.message);
    // আগে এখানে loadError পাঠানো হতো না — ব্যর্থতাকে "খালি তালিকা" হিসেবে দেখানো হতো,
    // যেটা "সত্যিই কোনো রেকর্ড নেই"-র থেকে আলাদা করা যেত না।
    res.render('payment/history', { user: req.session.user, requests: [], filter, loadError: true });
  }
});

const DEPOSIT_METHOD_META = {
  bkash:  { icon: 'fa-mobile-screen', label: 'bKash' },
  nagad:  { icon: 'fa-mobile-screen', label: 'Nagad' },
  rocket: { icon: 'fa-mobile-screen', label: 'Rocket' },
  upay:   { icon: 'fa-mobile-screen', label: 'Upay' },
  bank:   { icon: 'fa-university',    label: 'Bank Transfer' },
  crypto: { icon: 'fa-coins',         label: 'Crypto' }
};

function resolveDepositDateRange(query) {
  const { quick, from, to } = query;
  const fmt = (d) => d.toISOString().slice(0, 10);
  let dateFrom = from || '', dateTo = to || '';
  const today = new Date();
  if (quick === 'today') {
    dateFrom = dateTo = fmt(today);
  } else if (quick === '7d') {
    const d = new Date(today); d.setDate(d.getDate() - 7);
    dateFrom = fmt(d); dateTo = fmt(today);
  } else if (quick === '30d') {
    const d = new Date(today); d.setDate(d.getDate() - 30);
    dateFrom = fmt(d); dateTo = fmt(today);
  } else if (quick === '90d') {
    const d = new Date(today); d.setDate(d.getDate() - 90);
    dateFrom = fmt(d); dateTo = fmt(today);
  } else if (quick === 'year') {
    dateFrom = `${today.getFullYear()}-01-01`; dateTo = fmt(today);
  }
  return { dateFrom, dateTo };
}

// মেথড-ভিত্তিক ডিপোজিট রিপোর্ট — আগে এই পেজেই তিন জায়গায় আলাদা করে
// ['bkash','nagad','rocket'] হার্ডকোড ছিল (ট্যাব, টোটাল কোয়েরি, ফলব্যাক),
// VALID_METHODS-এ থাকা upay/bank/crypto কোথাও ধরা পড়ত না — সবসময় HTTP 200
// আসায় লুকিয়ে থাকত। এখন VALID_METHODS-ই একমাত্র সত্যের উৎস।
router.get('/admin/deposits', rbac.requirePermission('payments_view'), async (req, res) => {
  const methods = VALID_METHODS.map((key) => ({ key, ...(DEPOSIT_METHOD_META[key] || { icon: 'fa-coins', label: key }) }));
  const rawMethod = String(req.query.method || '');
  const method = VALID_METHODS.includes(rawMethod) ? rawMethod : 'bkash';
  const { dateFrom, dateTo } = resolveDepositDateRange(req.query);
  const quick = req.query.quick || '';
  const from = dateFrom;
  const to = dateTo;

  try {
    const params = [method];
    let dateClause = '';
    if (dateFrom && dateTo) {
      dateClause = ` AND pr.created_at::date BETWEEN $2 AND $3`;
      params.push(dateFrom, dateTo);
    }

    const listRes = await pool.query(
      `SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id
       WHERE pr.type = 'deposit' AND pr.method = $1${dateClause}
       ORDER BY pr.created_at DESC LIMIT 500`,
      params
    );

    const totalsRes = await pool.query(
      `SELECT method, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
       FROM payment_requests
       WHERE type='deposit' AND status='approved' AND method = ANY($1::text[])
       ${dateFrom && dateTo ? 'AND created_at::date BETWEEN $2 AND $3' : ''}
       GROUP BY method`,
      dateFrom && dateTo ? [VALID_METHODS, dateFrom, dateTo] : [VALID_METHODS]
    );
    const totals = {};
    VALID_METHODS.forEach((m) => { totals[m] = { total: 0, cnt: 0 }; });
    totalsRes.rows.forEach((r) => { totals[r.method] = { total: Number(r.total), cnt: parseInt(r.cnt, 10) }; });

    res.render('payment/deposits', {
      user: req.session.user,
      methods, method, quick, from, to,
      totals,
      requests: listRes.rows
    });
  } catch (err) {
    console.error('admin deposits load error:', err.message);
    res.render('payment/deposits', {
      user: req.session.user,
      methods, method, quick, from, to,
      totals: Object.fromEntries(VALID_METHODS.map((m) => [m, { total: 0, cnt: 0 }])),
      requests: [],
      loadError: true
    });
  }
});

router.get('/admin/payments', rbac.requirePermission('payments_view'), async (req, res) => {
  try {
    // আনবাউন্ডেড কোয়েরি ছিল — এখন সাম্প্রতিক ২,০০০টায় সীমাবদ্ধ (মেমরি/লেটেন্সি নিরাপত্তা)।
    const result = await pool.query(
      `SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id ORDER BY pr.created_at DESC LIMIT 2000`
    );
    res.render('payment/admin', { user: req.session.user, requests: result.rows });
  } catch (err) {
    console.error('admin payments load error:', err.message);
    res.render('payment/admin', { user: req.session.user, requests: [], loadError: true });
  }
});

// approve-এর মূল ক্রেডিট-লজিক — routes/admin.js-এর /api/deposits/:id/approve
// এই একই ফাংশন `creditApprovedDeposit` নামে ইমপোর্ট করে (require('./payment')
// থেকে destructure), কিন্তু ফাংশনটা আগে এই ফাইলে কখনো export-ই হতো না —
// ফলে সেই রুটটা প্রতিবার কল করলেই "creditApprovedDeposit is not a function"
// দিয়ে 500 দিত। এখন approve-এর সব পাথই (একক রুট, বাল্ক, admin/api,
// gatewayReconcile) এই একই ফাংশন ব্যবহার করে — লজিক আলাদা জায়গায় লিখে
// ফলাফল ফাঁক থাকার ঝুঁকি নেই। কলার আগেই SELECT ... FOR UPDATE করে pending
// নিশ্চিত করে রাখবে; এই ফাংশন শুধু ক্রেডিট + স্ট্যাটাস আপডেট + নোটিফিকেশন
// করে, নিজে BEGIN/COMMIT করে না।
async function creditApprovedDeposit(client, request) {
  let bonusGiven = 0;

  if (request.type === 'deposit') {
    await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'deposit',$3)`,
      [request.user_id, request.amount, `ডিপোজিট অনুমোদন (#${request.id})`]
    );
    await client.query('UPDATE users SET total_deposited = COALESCE(total_deposited,0) + $1 WHERE id=$2', [request.amount, request.user_id]);

    if (request.want_bonus) {
      const cnt = await client.query(
        `SELECT COUNT(*) FROM payment_requests WHERE user_id=$1 AND type='deposit' AND status='approved' AND id <> $2`,
        [request.user_id, request.id]
      );
      const before = parseInt(cnt.rows[0].count);
      const isFriday = new Date().getDay() === 5;
      const pct = bonusPercentFor(before, isFriday);
      bonusGiven = Math.min(MAX_BONUS, Math.floor(request.amount * pct / 100));
      if (bonusGiven > 0) {
        await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [bonusGiven, request.user_id]);
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'deposit_bonus',$3)`,
          [request.user_id, bonusGiven, `ডিপোজিট বোনাস (#${request.id})`]
        );
        await createBonus(client, request.user_id, 'deposit', bonusGiven);
      }
    }
    await processReferralDeposit(client, request.user_id, request.amount);
  }

  await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [request.id]);

  const message = request.type === 'deposit'
    ? (bonusGiven > 0
      ? `আপনার ${request.amount} টাকার ডিপোজিট + ${bonusGiven} বোনাস যোগ হয়েছে! (টার্নওভার প্রযোজ্য)`
      : `আপনার ${request.amount} টাকার ডিপোজিট অনুমোদন হয়েছে!`)
    : `আপনার ${request.amount} টাকার উইথড্র অনুমোদন হয়েছে!`;
  const notifRes = await client.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success') RETURNING *`,
    [request.user_id, 'পেমেন্ট অনুমোদন', message]
  );

  return { bonusGiven, notification: notifRes.rows[0] };
}

// নিজের কানেকশন/ট্রানজেকশন খোলে, row-level লক (FOR UPDATE) দিয়ে concurrency-safe —
// একই id-তে একসাথে একাধিকবার কল হলেও ঠিক একবারই ক্রেডিট/স্ট্যাটাস-বদল হবে।
// একক রুট ও বাল্ক রুট দুটোই এই একই ফাংশন কল করে।
async function approvePaymentRequestById(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, reason: 'not_found_or_processed' };
    }
    const extra = await creditApprovedDeposit(client, request);
    await client.query('COMMIT');
    return { success: true, request, ...extra };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('approvePaymentRequestById error:', err.message);
    return { success: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

async function rejectPaymentRequestById(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, reason: 'not_found_or_processed' };
    }
    if (request.type === 'withdraw') {
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'withdraw_refund',$3)`,
        [request.user_id, request.amount, `উইথড্র বাতিল, ফেরত (#${request.id})`]
      );
    }
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    const message = `আপনার ${request.amount} টাকার রিকোয়েস্ট বাতিল হয়েছে।`;
    const notifRes = await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error') RETURNING *`,
      [request.user_id, 'পেমেন্ট বাতিল', message]
    );
    await client.query('COMMIT');
    return { success: true, request, notification: notifRes.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('rejectPaymentRequestById error:', err.message);
    return { success: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

router.post('/admin/approve/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    req.flash('error', req.t('payment_invalid_request_id'));
    return res.redirect('/payment/admin/payments');
  }
  const result = await approvePaymentRequestById(id);
  if (!result.success) {
    req.flash('error', req.t('payment_request_not_found_or_processed'));
    return res.redirect('/payment/admin/payments');
  }
  await logAuditEvent({
    req,
    actorType: 'admin',
    actorId: req.session.user.id,
    actorUsername: req.session.user.username,
    action: 'PAYMENT_APPROVED',
    category: 'financial',
    riskLevel: 'high',
    details: { requestId: id, userId: result.request.user_id, type: result.request.type, amount: result.request.amount }
  }).catch((e) => console.error('audit log error:', e.message));
  req.flash('success', req.t('payment_approved'));
  res.redirect('/payment/admin/payments');
});

router.post('/admin/reject/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    req.flash('error', req.t('payment_invalid_request_id'));
    return res.redirect('/payment/admin/payments');
  }
  const result = await rejectPaymentRequestById(id);
  if (!result.success) {
    req.flash('error', req.t('payment_request_not_found_or_processed'));
    return res.redirect('/payment/admin/payments');
  }
  await logAuditEvent({
    req,
    actorType: 'admin',
    actorId: req.session.user.id,
    actorUsername: req.session.user.username,
    action: 'PAYMENT_REJECTED',
    category: 'financial',
    riskLevel: 'medium',
    details: { requestId: id, userId: result.request.user_id, type: result.request.type, amount: result.request.amount }
  }).catch((e) => console.error('audit log error:', e.message));
  req.flash('error', req.t('payment_rejected'));
  res.redirect('/payment/admin/payments');
});

// --- বাল্ক অ্যাকশন — single approve/reject-এর concurrency-safe ফাংশনগুলোই
// পুনরায় ব্যবহার করে, যাতে ক্রেডিট-লজিক দুই জায়গায় আলাদাভাবে না লেখা হয়। ---
function parseBulkIds(body) {
  const ids = Array.isArray(body.ids) ? body.ids : (body.ids ? [body.ids] : []);
  return [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))];
}

async function logBulkPaymentAction(req, actionType, label, succeeded, failed, ids) {
  try {
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address) VALUES ($1,$2,$3,$4,$5)`,
      [req.session.user.id, req.session.user.username, actionType,
       `${label}: ${succeeded}টা সফল, ${failed}টা ব্যর্থ (আইডি: ${ids.join(',')})`, req.ip]
    );
  } catch (e) {
    console.error('admin_logs insert error:', e.message);
  }
}

router.post('/admin/payments/bulk-approve', rbac.requirePermission('payments_approve'), async (req, res) => {
  const cleanIds = parseBulkIds(req.body);
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: req.t('payment_no_ids_selected') });
  }
  const results = [];
  for (const id of cleanIds) {
    const r = await approvePaymentRequestById(id);
    results.push({ id, success: r.success });
  }
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  await logBulkPaymentAction(req, 'BULK_PAYMENT_APPROVE', 'বাল্ক পেমেন্ট অনুমোদন', succeeded, failed, cleanIds);
  res.json({ success: true, total: cleanIds.length, succeeded, failed, results });
});

router.post('/admin/payments/bulk-reject', rbac.requirePermission('payments_reject'), async (req, res) => {
  const cleanIds = parseBulkIds(req.body);
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: req.t('payment_no_ids_selected') });
  }
  const results = [];
  for (const id of cleanIds) {
    const r = await rejectPaymentRequestById(id);
    results.push({ id, success: r.success });
  }
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  await logBulkPaymentAction(req, 'BULK_PAYMENT_REJECT', 'বাল্ক পেমেন্ট বাতিল', succeeded, failed, cleanIds);
  res.json({ success: true, total: cleanIds.length, succeeded, failed, results });
});

// ---------------------------------------------------------------------------
// SSLCommerz গেটওয়ে রুট। commit bd8b1b2-এর rewrite এগুলো সম্পূর্ণ মুছে দিয়েছিল,
// যদিও services/sslcommerz.js আর middleware/csrf.js-এর CSRF-exemption রয়ে
// গিয়েছিল। ফলে গেটওয়ের success/fail/cancel/ipn কলব্যাক ৪০৪ পাচ্ছিল এবং অনলাইন
// ডিপোজিট কখনো ক্রেডিট হতো না। bd8b1b2~1 থেকে অপরিবর্তিত অবস্থায় ফেরানো হলো।
// ---------------------------------------------------------------------------
// একই টাকা দিয়ে সীমাহীন ক্রেডিট। এখন verification-এর tran_id অবশ্যই যে রিকোয়েস্টটা ক্রেডিট হচ্ছে
// তার gateway_tran_id-র সমান হতে হবে। গেটওয়ে tran_id না দিলে fail-closed (ক্রেডিট হবে না)।
function isVerificationForRequest(verification, request) {
  const returnedTran = verification && (verification.tran_id || verification.tranId);
  if (!returnedTran) return false;
  return String(returnedTran) === String(request.gateway_tran_id);
}

router.post('/sslcommerz/init', isAuth, requireFeature('deposit'), paymentLimiter, async (req, res) => {
  const wantBonus = req.body.want_bonus === 'yes';
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (amount === null || amount < 100) {
    req.flash('error', req.t('payment_min_deposit_100'));
    return res.redirect('/payment/deposit');
  }

  const tranId = `LIVO${userId}${Date.now()}${crypto.randomBytes(3).toString('hex')}`;

  try {
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status, want_bonus, gateway, gateway_tran_id)
       VALUES ($1, 'deposit', 'sslcommerz', $2, 'pending', $3, 'sslcommerz', $4)`,
      [userId, amount, wantBonus, tranId]
    );

    const baseUrl = getBaseUrl(req);
    const gatewayUrl = await sslcommerz.initPayment({
      amount,
      tranId,
      customer: {
        name: req.session.user.username,
        email: req.session.user.email,
        phone: req.session.user.phone
      },
      baseUrl
    });

    res.redirect(gatewayUrl);
  } catch (err) {
    console.error('sslcommerz init error:', err.message);
    // গেটওয়ে সেশন শুরু করা যায়নি (timeout/network/config এরর) — উপরে ইতিমধ্যে ঢোকানো
    // pending রো-টা চিরস্থায়ীভাবে pending থেকে যাওয়ার বদলে rejected করে দেওয়া হচ্ছে,
    // নাহলে ইউজারের history/admin ড্যাশবোর্ডে একটা কখনো-সেটল-না-হওয়া রো থেকে যায়।
    await pool.query(
      `UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE gateway_tran_id=$1 AND status='pending'`,
      [tranId]
    ).catch((e) => console.error('sslcommerz init cleanup error:', e.message));
    req.flash('error', req.t('payment_gateway_init_failed'));
    res.redirect('/payment/deposit');
  }
});

// SSLCommerz পেমেন্ট সফল হলে ইউজারের ব্রাউজার এখানে রিডাইরেক্ট হয়ে আসে
router.post('/sslcommerz/success', async (req, res) => {
  const { tran_id, val_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM payment_requests WHERE gateway_tran_id=$1 FOR UPDATE`, [tran_id]
    );
    const request = result.rows[0];

    if (!request) {
      await client.query('ROLLBACK');
      req.flash('error', req.t('payment_transaction_not_found'));
      return res.redirect('/payment/deposit');
    }
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.redirect('/payment/history'); // আগেই IPN দিয়ে ক্রেডিট হয়ে গেছে
    }

    const verification = await sslcommerz.validatePayment(val_id);
    const validStatus = verification.status === 'VALID' || verification.status === 'VALIDATED';
    // অঙ্ক তুলনা সবসময় স্টোর-কারেন্সির (BDT) মানের সাথে — currency_amount নয়।
    const amountMatches = paymentVerification.amountMatchesRequest(verification, request.amount);
    const tranMatches = isVerificationForRequest(verification, request);
    // আগে currency কখনো যাচাই হতো না — অন্য মুদ্রায় সেটল হওয়া ট্রানজেকশনের সংখ্যাগত
    // তুলনা পাস করে যেতে পারত যদিও আসল মূল্য বহুগুণ কম।
    const currencyMatches = paymentVerification.isExpectedCurrency(verification);

    if (!validStatus || !amountMatches || !tranMatches || !currencyMatches) {
      await client.query(
        `UPDATE payment_requests SET status='rejected', gateway_val_id=$1, gateway_response=$2, updated_at=NOW() WHERE id=$3`,
        [val_id, JSON.stringify(verification), request.id]
      );
      await client.query('COMMIT');
      req.flash('error', req.t('payment_verification_failed'));
      return res.redirect('/payment/deposit');
    }

    await client.query(
      `UPDATE payment_requests SET gateway_val_id=$1, gateway_response=$2 WHERE id=$3`,
      [val_id, JSON.stringify(verification), request.id]
    );
    await creditApprovedDeposit(client, request);
    await client.query('COMMIT');

    if (req.session.user) {
      const u = await pool.query('SELECT coins FROM users WHERE id=$1', [request.user_id]);
      req.session.user.coins = u.rows[0].coins;
    }
    req.flash('success', req.t('payment_deposit_success_amount').replace('{value}', request.amount));
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sslcommerz success error:', err.message);
    req.flash('error', req.t('payment_error_contact_support'));
    res.redirect('/payment/deposit');
  } finally {
    client.release();
  }
});

// fail/cancel কলব্যাক দুটো CSRF-এক্সেম্পট (middleware/csrf.js) এবং /success ও /ipn-এর মতো
// গেটওয়ে ভ্যালিডেশনও করে না — আগে শুধু tran_id মিললেই pending রিকোয়েস্ট rejected করে দিত।
// অর্থাৎ কারো tran_id জানা থাকলে (এটা গোপন নয় — গেটওয়েতে যায়, /payment/history-তেও দেখা যায়)
// সে অন্যের চলমান ডিপোজিট বাতিল করে দিতে পারত। এখন দুই স্তরের যাচাই:
//   ১) লগইন করা ইউজারের নিজের রিকোয়েস্ট হলে সরাসরি বাতিল করা যায় (user_id দিয়ে স্কোপড),
//   ২) সেশন না থাকলে (গেটওয়ে সরাসরি সার্ভার-টু-সার্ভার পোস্ট করলে) গেটওয়েতে ভ্যালিডেট করে
//      নিশ্চিত হওয়া হয় যে পেমেন্টটা আসলেই সফল হয়নি — তবেই rejected করা হয়।
async function rejectPendingGatewayRequest(req, tranId) {
  if (!tranId) return false;

  const sessionUserId = req.session && req.session.user ? req.session.user.id : null;
  if (sessionUserId) {
    const scoped = await pool.query(
      `UPDATE payment_requests SET status='rejected', updated_at=NOW()
       WHERE gateway_tran_id=$1 AND status='pending' AND user_id=$2`,
      [tranId, sessionUserId]
    );
    return scoped.rowCount > 0;
  }

  const existing = await pool.query(
    `SELECT id FROM payment_requests WHERE gateway_tran_id=$1 AND status='pending'`,
    [tranId]
  );
  if (!existing.rows[0]) return false;

  // সেশন নেই — গেটওয়ের কাছে যাচাই না করে কিছুতেই স্ট্যাটাস বদলানো হবে না।
  let verification = null;
  try {
    verification = await sslcommerz.validateByTransactionId(tranId);
  } catch (e) {
    console.error('sslcommerz fail/cancel validation error:', e.message);
    return false;
  }
  const paidStatus = verification && (verification.status === 'VALID' || verification.status === 'VALIDATED');
  if (paidStatus) return false; // আসলে পেমেন্ট সফল — /ipn এটাকে ক্রেডিট করবে, এখানে হাত দেওয়া যাবে না

  const updated = await pool.query(
    `UPDATE payment_requests SET status='rejected', gateway_response=$2, updated_at=NOW()
     WHERE gateway_tran_id=$1 AND status='pending'`,
    [tranId, JSON.stringify(verification || {})]
  );
  return updated.rowCount > 0;
}

router.post('/sslcommerz/fail', async (req, res) => {
  try {
    await rejectPendingGatewayRequest(req, req.body.tran_id);
  } catch (e) { console.error('sslcommerz fail error:', e.message); }
  req.flash('error', req.t('payment_failed'));
  res.redirect('/payment/deposit');
});

router.post('/sslcommerz/cancel', async (req, res) => {
  try {
    await rejectPendingGatewayRequest(req, req.body.tran_id);
  } catch (e) { console.error('sslcommerz cancel error:', e.message); }
  req.flash('error', req.t('payment_cancelled'));
  res.redirect('/payment/deposit');
});

// সার্ভার-টু-সার্ভার IPN — ব্যাকআপ হিসেবে, যদি ইউজারের ব্রাউজার success_url এ ফিরে না আসে
router.post('/sslcommerz/ipn', async (req, res) => {
  const { tran_id, val_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM payment_requests WHERE gateway_tran_id=$1 FOR UPDATE`, [tran_id]
    );
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.sendStatus(200);
    }

    const verification = await sslcommerz.validatePayment(val_id);
    const validStatus = verification.status === 'VALID' || verification.status === 'VALIDATED';
    // অঙ্ক তুলনা সবসময় স্টোর-কারেন্সির (BDT) মানের সাথে — currency_amount নয়।
    const amountMatches = paymentVerification.amountMatchesRequest(verification, request.amount);
    const tranMatches = isVerificationForRequest(verification, request);
    // আগে currency কখনো যাচাই হতো না — অন্য মুদ্রায় সেটল হওয়া ট্রানজেকশনের সংখ্যাগত
    // তুলনা পাস করে যেতে পারত যদিও আসল মূল্য বহুগুণ কম।
    const currencyMatches = paymentVerification.isExpectedCurrency(verification);

    if (validStatus && amountMatches && tranMatches && currencyMatches) {
      await client.query(
        `UPDATE payment_requests SET gateway_val_id=$1, gateway_response=$2 WHERE id=$3`,
        [val_id, JSON.stringify(verification), request.id]
      );
      await creditApprovedDeposit(client, request);
    }
    await client.query('COMMIT');
    res.sendStatus(200);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sslcommerz ipn error:', err.message);
    // IPN হলো ব্রাউজার success_url-এ ফিরে না এলে ব্যাকআপ ডেলিভারি পথ (উপরের কমেন্ট দ্রষ্টব্য)।
    // আগে এখানে সবসময় 200 রিটার্ন হতো — অভ্যন্তরীণ ব্যর্থতাতেও (DB এরর, গেটওয়ে timeout) —
    // ফলে SSLCommerz সেটাকে "ডেলিভারড" ধরে নিয়ে আর রিট্রাই করত না, আর যে ডিপোজিট আসলে
    // সফল হয়েছিল সেটা চিরস্থায়ীভাবে pending থেকে যেতে পারত। এখন শুধু "কিছু করার নেই"
    // কেসগুলোতেই (রিকোয়েস্ট নেই / ইতিমধ্যে প্রসেসড — try ব্লকের প্রথম দিকে) 200 যায়;
    // সত্যিকারের অভ্যন্তরীণ ব্যর্থতায় 500 যায় যাতে গেটওয়ে তার নিজস্ব রিট্রাই নীতি অনুযায়ী আবার পাঠায়।
    res.sendStatus(500);
  } finally {
    client.release();
  }
});

router.creditApprovedDeposit = creditApprovedDeposit;
module.exports = router;
module.exports.creditApprovedDeposit = creditApprovedDeposit;
module.exports.approvePaymentRequestById = approvePaymentRequestById;
module.exports.rejectPaymentRequestById = rejectPaymentRequestById;
