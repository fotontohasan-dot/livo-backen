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

const { isAuth } = require('../middleware/auth');

function requireLogin(req, res, next) {
  // middleware/auth.js-এর isAuth পুনর্ব্যবহার — এই ফাইলের নিজস্ব সংস্করণে
  // শুধু সেশনের অস্তিত্ব দেখা হতো, ব্যান/self-exclude যাচাই হতো না। ফলে
  // ব্যান করার পরও পুরনো সেশন দিয়ে ডিপোজিট/উইথড্র/ওয়ালেট রুটে ঢোকা যেত
  // (isAuth-এই একমাত্র সঠিক, cache-ব্যাকড যাচাইটা আছে — ডুপ্লিকেট না করে
  // এখানে পুনর্ব্যবহার করা হলো)।
  return isAuth(req, res, next);
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/');
  next();
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

router.get('/deposit', requireLogin, async (req, res) => {
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
router.get('/deposit/methods', requireLogin, async (req, res) => {
  try {
    const methods = await paymentMethods.listActivePublic();
    res.json({ success: true, methods });
  } catch (err) {
    console.error('deposit/methods error:', err.message);
    res.status(500).json({ success: false, error: 'পেমেন্ট মেথড লোড করা যায়নি।' });
  }
});

router.post('/deposit', requireLogin, async (req, res) => {
  const { method, transaction_id, account_number } = req.body;
  const wantBonus = req.body.want_bonus === 'yes';
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;
  let channelId = req.body.channel_id ? parseInt(req.body.channel_id, 10) : null;
  if (!Number.isInteger(channelId)) channelId = null;

  if (!VALID_METHODS.includes(method)) {
    req.flash('error', 'অকার্যকর পেমেন্ট মেথড');
    return res.redirect('/payment/deposit');
  }
  if (!method || amount === null || !transaction_id || !account_number) {
    req.flash('error', 'সব তথ্য সঠিকভাবে দিন');
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
    req.flash('error', 'সর্বনিম্ন ডিপোজিট ১০০ টাকা');
    return res.redirect('/payment/deposit');
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
        req.flash('error', `দৈনিক ডিপোজিট সীমা ${limit} টাকা। আজ আর ${Math.max(0, limit - already)} টাকা ডিপোজিট করতে পারবেন।`);
        return res.redirect('/payment/deposit');
      }
    }

    await client.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status, want_bonus, channel_id) VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending', $6, $7)`,
      [userId, method, amount, transaction_id, account_number, wantBonus, channelId]
    );
    await client.query('COMMIT');
    await notifyAdmins('নতুন ডিপোজিট রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা ডিপোজিট চেয়েছে (${method})।`);
    req.flash('success', 'ডিপোজিট রিকোয়েস্ট পাঠানো হয়েছে!');
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deposit error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
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
    req.flash('success', 'পেমেন্ট মেথড তৈরি হয়েছে।');
  } catch (err) {
    req.flash('error', publicMessage(err, 'পেমেন্ট মেথড তৈরি করা যায়নি।'));
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
    req.flash('success', 'পেমেন্ট মেথড আপডেট হয়েছে।');
  } catch (err) {
    req.flash('error', publicMessage(err, 'পেমেন্ট মেথড আপডেট করা যায়নি।'));
  }
  res.redirect('/payment/admin/payment-methods');
});

router.post('/admin/payment-methods/:id/status', rbac.requirePermission('payment_methods_manage'), async (req, res) => {
  try {
    const { after } = await paymentMethods.setStatus(req.params.id, req.body.status, req.session.user.id);
    if (after) await auditPaymentMethodEvent(req, 'PAYMENT_METHOD_STATUS_CHANGED', after);
  } catch (err) {
    req.flash('error', publicMessage(err, 'স্ট্যাটাস বদলানো যায়নি।'));
  }
  res.redirect('/payment/admin/payment-methods');
});

router.post('/admin/payment-methods/:id/delete', rbac.requirePermission('payment_methods_manage'), async (req, res) => {
  try {
    const removed = await paymentMethods.remove(req.params.id, req.session.user.id);
    await auditPaymentMethodEvent(req, 'PAYMENT_METHOD_DELETED', removed);
    req.flash('success', 'পেমেন্ট মেথড মুছে ফেলা হয়েছে।');
  } catch (err) {
    req.flash('error', publicMessage(err, 'মুছে ফেলা যায়নি।'));
  }
  res.redirect('/payment/admin/payment-methods');
});

router.get('/withdraw', requireLogin, async (req, res) => {
  try {
    let coins = 0;
    let hasWithdrawPin = false;
    try {
      const result = await pool.query('SELECT coins, withdraw_pin_hash FROM users WHERE id=$1', [req.session.user.id]);
      // pg NUMERIC কলাম string হিসেবে আসে — Number() না করলে view-তে .toFixed() ক্র্যাশ করে
      coins = Number(result.rows[0]?.coins) || 0;
      hasWithdrawPin = !!(result.rows[0] && result.rows[0].withdraw_pin_hash);
    } catch (e) {
      // withdraw_pin_hash কলাম না থাকলে (migration.sql না চালানো থাকলে) শুধু coins আনি
      try {
        const fallback = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
        coins = Number(fallback.rows[0]?.coins) || 0;
      } catch (e2) { /* keep defaults */ }
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
    console.error('withdraw GET error:', err.message);
    res.redirect('/');
  }
});


router.post('/withdraw', requireLogin, async (req, res) => {
  const { method, account_number, password, withdraw_pin } = req.body;
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (!VALID_METHODS.includes(method)) {
    req.flash('error', 'অকার্যকর পেমেন্ট মেথড');
    return res.redirect('/payment/withdraw');
  }
  if (!method || amount === null || !account_number) {
    req.flash('error', 'সব তথ্য সঠিকভাবে দিন');
    return res.redirect('/payment/withdraw');
  }
  if (amount < 200) {
    req.flash('error', 'সর্বনিম্ন উইথড্র ২০০ টাকা');
    return res.redirect('/payment/withdraw');
  }

  // ---- Login-password re-check (as already shown on the form) ----
  try {
    const u = await pool.query('SELECT password, withdraw_pin_hash FROM users WHERE id=$1', [userId]);
    const row = u.rows[0];
    if (password && row && row.password) {
      const okPass = await bcrypt.compare(password, row.password);
      if (!okPass) {
        req.flash('error', 'পাসওয়ার্ড সঠিক নয়');
        return res.redirect('/payment/withdraw');
      }
    }
    // ---- Separate withdrawal PIN check ----
    if (row && row.withdraw_pin_hash) {
      if (!withdraw_pin) {
        req.flash('error', 'উইথড্র পিন দিন');
        return res.redirect('/payment/withdraw');
      }
      const okPin = await bcrypt.compare(withdraw_pin, row.withdraw_pin_hash);
      if (!okPin) {
        req.flash('error', 'উইথড্র পিন সঠিক নয়');
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
      req.flash('error', 'পর্যাপ্ত কয়েন নেই');
      return res.redirect('/payment/withdraw');
    }

    await client.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status) VALUES ($1, 'withdraw', $2, $3, $4, 'pending')`,
      [userId, method, amount, account_number]
    );

    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;

    await notifyAdmins('নতুন উইথড্র রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা উইথড্র চেয়েছে (${method})।`);

    req.flash('success', 'উইথড্র রিকোয়েস্ট পাঠানো হয়েছে!');
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('withdraw error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/withdraw');
  } finally {
    client.release();
  }
});

router.get('/history', requireLogin, async (req, res) => {
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

router.get('/wallet', requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userRes = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    const coins = Number(userRes.rows[0]?.coins) || 0;

    const cardRes = await pool.query('SELECT COUNT(*) FROM bank_cards WHERE user_id=$1', [userId]);
    const cardCount = parseInt(cardRes.rows[0].count, 10) || 0;

    const statsRes = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND status='approved'), 0) AS total_deposit,
         COALESCE(SUM(amount) FILTER (WHERE type='withdraw' AND status='approved'), 0) AS total_withdraw,
         COALESCE(SUM(amount) FILTER (WHERE type='deposit' AND status='approved' AND created_at >= NOW() - INTERVAL '30 days'), 0) AS deposit_30d,
         COALESCE(SUM(amount) FILTER (WHERE type='withdraw' AND status='approved' AND created_at >= NOW() - INTERVAL '30 days'), 0) AS withdraw_30d,
         COUNT(*) FILTER (WHERE status='pending') AS pending_count
       FROM payment_requests WHERE user_id=$1`,
      [userId]
    );
    const s = statsRes.rows[0];
    const walletStats = {
      totalDeposit: Number(s.total_deposit),
      totalWithdraw: Number(s.total_withdraw),
      deposit30d: Number(s.deposit_30d),
      withdraw30d: Number(s.withdraw_30d),
      pendingCount: parseInt(s.pending_count, 10) || 0
    };

    const recentRes = await pool.query(
      `SELECT * FROM payment_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [userId]
    );

    res.render('payment/wallet', {
      user: req.session.user,
      coins,
      cardCount,
      walletStats,
      recentTx: recentRes.rows
    });
  } catch (err) {
    console.error('wallet error:', err.message);
    req.flash('error', 'ওয়ালেট পেজ লোড করা যায়নি');
    res.redirect('/profile');
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
    res.render('payment/admin', { user: req.session.user, requests: [] });
  }
});

// approve-এর মূল ক্রেডিট-লজিক — routes/admin.js-এর /api/deposits/:id/approve
// এই একই ফাংশন `creditApprovedDeposit` নামে ইমপোর্ট করে (require('./payment')
// থেকে destructure), কিন্তু ফাংশনটা আগে এই ফাইলে কখনো export-ই হতো না —
// ফলে সেই রুটটা প্রতিবার কল করলেই "creditApprovedDeposit is not a function"
// দিয়ে 500 দিত। এখন তিনটা approve পাথই (একক রুট, বাল্ক, admin/api) এই একই
// ফাংশন ব্যবহার করে — লজিক তিন জায়গায় আলাদা করে লিখে ফলাফল ফাঁক থাকার ঝুঁকি নেই।
// কলার আগেই SELECT ... FOR UPDATE করে pending নিশ্চিত করে রাখবে; এই ফাংশন
// শুধু ক্রেডিট + স্ট্যাটাস আপডেট + নোটিফিকেশন করে, নিজে BEGIN/COMMIT করে না।
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

router.post('/admin/approve/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      req.flash('error', 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে');
      return res.redirect('/payment/admin/payments');
    }

    await creditApprovedDeposit(client, request);
    await client.query('COMMIT');
    req.flash('success', 'অনুমোদন হয়েছে');
    res.redirect('/payment/admin/payments');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('approve error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/admin/payments');
  } finally {
    client.release();
  }
});

router.post('/admin/reject/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      req.flash('error', 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে');
      return res.redirect('/payment/admin/payments');
    }
    if (request.type === 'withdraw') {
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'withdraw_refund',$3)`,
        [request.user_id, request.amount, `উইথড্র বাতিল, ফেরত (#${request.id})`]
      );
    }
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error')`,
      [request.user_id, 'পেমেন্ট বাতিল', `আপনার ${request.amount} টাকার রিকোয়েস্ট বাতিল হয়েছে।`]
    );
    await client.query('COMMIT');
    req.flash('error', 'বাতিল করা হয়েছে');
    res.redirect('/payment/admin/payments');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reject error:', err.message);
    res.redirect('/payment/admin/payments');
  } finally {
    client.release();
  }
});
// এই ফাংশনটা একটা ইতিমধ্যে-চলমান ট্রানজেকশনের (client) ভেতরে চলে — কলার নিজেই
// `SELECT ... FOR UPDATE` দিয়ে request-টা লক করে status==='pending' যাচাই করে
// নিয়েছে ধরে নেওয়া হয়। এটা coins ক্রেডিট, বোনাস, রেফারেল, লেজার এন্ট্রি ও
// status='approved' আপডেট করে — routes/admin.js ও services/gatewayReconcile.js
// দুটোই এটা ব্যবহার করে, তাই কোনো ডুপ্লিকেট ক্রেডিট-লজিক না থাকে।
async function creditApprovedDeposit(client, request) {
  let bonusGiven = 0;

  await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
  await client.query('UPDATE users SET total_deposited = COALESCE(total_deposited,0) + $1 WHERE id=$2', [request.amount, request.user_id]);
  await client.query(
    `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'deposit', $3)`,
    [request.user_id, request.amount, `ডিপোজিট #${request.id} অনুমোদিত`]
  );

  // বোনাস নিলে — রিলোড নিয়ম অনুযায়ী শতাংশ
  if (request.want_bonus) {
    const cnt = await client.query(
      `SELECT COUNT(*) FROM payment_requests WHERE user_id=$1 AND type='deposit' AND status='approved' AND id <> $2`,
      [request.user_id, request.id]
    );
    const before = parseInt(cnt.rows[0].count);
    const isFriday = new Date().getDay() === 5; // 5 = শুক্রবার
    const pct = bonusPercentFor(before, isFriday);

    bonusGiven = Math.min(MAX_BONUS, Math.floor(request.amount * pct / 100));

    if (bonusGiven > 0) {
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [bonusGiven, request.user_id]);
      await createBonus(client, request.user_id, 'deposit', bonusGiven);
    }
  }

  await processReferralDeposit(client, request.user_id, request.amount);
  await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [request.id]);

  const message = bonusGiven > 0
    ? `আপনার ${request.amount} টাকার ডিপোজিট + ${bonusGiven} বোনাস যোগ হয়েছে! (টার্নওভার প্রযোজ্য)`
    : `আপনার ${request.amount} টাকার ডিপোজিট অনুমোদন হয়েছে!`;

  await client.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
    [request.user_id, 'পেমেন্ট অনুমোদন', message]
  );

  return { bonusGiven, notification: { title: 'পেমেন্ট অনুমোদন', message, type: 'success' } };
}

// নিজের কানেকশন/ট্রানজেকশন খোলে, row-level লক (FOR UPDATE) দিয়ে concurrency-safe —
// একই id-তে একসাথে একাধিকবার কল হলেও ঠিক একবারই ক্রেডিট/স্ট্যাটাস-বদল হবে।
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

    await creditApprovedDeposit(client, request);
    let extra = {};
    if (request.type === 'deposit') {
      extra = await creditApprovedDeposit(client, request);
    } else {
      await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);
      const message = `আপনার ${request.amount} টাকার উইথড্র অনুমোদন হয়েছে!`;
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
        [request.user_id, 'পেমেন্ট অনুমোদন', message]
      );
      extra = { notification: { title: 'পেমেন্ট অনুমোদন', message, type: 'success' } };
    }

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
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'withdraw_refund', $3)`,
        [request.user_id, request.amount, `রিকোয়েস্ট #${request.id} বাতিলে ফেরত`]
      );
    }
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    const message = `আপনার ${request.amount} টাকার রিকোয়েস্ট বাতিল হয়েছে।`;
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error')`,
      [request.user_id, 'পেমেন্ট বাতিল', message]
    );
    await client.query('COMMIT');
    return { success: true, request, notification: { title: 'পেমেন্ট বাতিল', message, type: 'error' } };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('rejectPaymentRequestById error:', err.message);
    return { success: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

router.post('/admin/approve/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const result = await approvePaymentRequestById(id);
  if (!result.success) {
    req.flash('error', 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে');
    return res.redirect('/payment/admin/payments');
  }
  req.flash('success', 'অনুমোদন হয়েছে');
  res.redirect('/payment/admin/payments');
});

router.post('/admin/reject/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const result = await rejectPaymentRequestById(id);
  if (!result.success) {
    req.flash('error', 'রিকোয়েস্ট পাওয়া যায়নি অথবা আগেই প্রসেস হয়েছে');
    return res.redirect('/payment/admin/payments');
  }
  req.flash('error', 'বাতিল করা হয়েছে');
  res.redirect('/payment/admin/payments');
});

// --- বাল্ক অ্যাকশন — "wire up admin CRUD" স্কোপের অংশ, single approve/reject-এর
// concurrency-safe ফাংশনগুলোই পুনরায় ব্যবহার করে, যাতে ক্রেডিট-লজিক দুই জায়গায়
// আলাদাভাবে না লেখা হয়। ---
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
    return res.status(400).json({ success: false, error: 'কোনো আইডি নির্বাচন করা হয়নি' });
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
    return res.status(400).json({ success: false, error: 'কোনো আইডি নির্বাচন করা হয়নি' });
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

router.creditApprovedDeposit = creditApprovedDeposit;
module.exports = router;
module.exports.creditApprovedDeposit = creditApprovedDeposit;
module.exports.approvePaymentRequestById = approvePaymentRequestById;
module.exports.rejectPaymentRequestById = rejectPaymentRequestById;
