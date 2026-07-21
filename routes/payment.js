const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { createBonus, canWithdraw } = require('../services/turnover');
const { processReferralDeposit } = require('../services/referral');
const crypto = require('crypto');
const sslcommerz = require('../services/sslcommerz');
const { broadcastDemoStats, emitAdminAlert } = require('../services/socket');
const { notifyTelegram } = require('../services/telegramNotify');
const { verifyPin, getPinStatus } = require('../services/withdrawPin');
const { evaluateTransaction } = require('../services/fraudDetection');
const { checkIp } = require('../services/vpnDetection');
const { requireVerifiedEmail } = require('../middleware/auth');
const RedisRateLimitStore = require('../services/redisRateLimitStore');

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: 'অনেকবার চেষ্টা করেছেন। কিছুক্ষণ পর আবার চেষ্টা করুন।',
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:payment:')
});

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
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

async function notifyAdmins(title, message, alertType) {
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
  if (alertType) emitAdminAlert(alertType, { title, message });
  notifyTelegram(`🔔 <b>${title}</b>\n${message}`);
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

// ডিপোজিট অনুমোদন হলে কয়েন+বোনাস+রেফারেল প্রসেস করে — অ্যাডমিন approve
// এবং SSLCommerz অটো-ক্রেডিট দুই জায়গা থেকেই এই একই ফাংশন কল হয়
async function creditApprovedDeposit(client, request) {
  let bonusGiven = 0;
  const amount = Math.round(Number(request.amount));

  await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [amount, request.user_id]);
  await client.query('UPDATE users SET total_deposited = COALESCE(total_deposited,0) + $1 WHERE id=$2', [request.amount, request.user_id]);

  // ডিপোজিট করলে ইউজারের ডেমো ব্যালেন্সও একই পরিমাণ বেড়ে যাবে (স্বয়ংক্রিয়)
  await client.query('UPDATE users SET demo_balance = COALESCE(demo_balance,0) + $1 WHERE id=$2', [amount, request.user_id]);
  broadcastDemoStats().catch(e => console.error('demo stats broadcast:', e.message));

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
      await client.query('SAVEPOINT bonus_sp');
      try {
        await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [bonusGiven, request.user_id]);
        await createBonus(client, request.user_id, 'deposit', bonusGiven);
        await client.query('RELEASE SAVEPOINT bonus_sp');
      } catch (bonusErr) {
        await client.query('ROLLBACK TO SAVEPOINT bonus_sp');
        console.error('createBonus failed, bonus skipped but deposit continues:', bonusErr.message);
        bonusGiven = 0;
      }
    }
  }

  await client.query('SAVEPOINT referral_sp');
  try {
    await processReferralDeposit(client, request.user_id, request.amount);
    await client.query('RELEASE SAVEPOINT referral_sp');
  } catch (refErr) {
    await client.query('ROLLBACK TO SAVEPOINT referral_sp');
    console.error('processReferralDeposit failed, referral bonus skipped:', refErr.message);
  }

  await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [request.id]);

  const message = bonusGiven > 0
    ? `আপনার ${request.amount} টাকার ডিপোজিট + ${bonusGiven} বোনাস যোগ হয়েছে! (টার্নওভার প্রযোজ্য)`
    : `আপনার ${request.amount} টাকার ডিপোজিট অনুমোদন হয়েছে!`;
  await client.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
    [request.user_id, 'পেমেন্ট অনুমোদন', message]
  );

  return bonusGiven;
}

const VALID_METHODS = ['bkash', 'nagad', 'rocket', 'upay', 'bank', 'crypto'];

const DEPOSIT_NUMBERS = [
  '01781732144',
  '01714275156',
  '01840199199',
  '01620992072'
];
let depositRotation = 0;

router.get('/deposit', requireLogin, (req, res) => {
  const current = DEPOSIT_NUMBERS[depositRotation % DEPOSIT_NUMBERS.length];
  depositRotation = (depositRotation + 1) % DEPOSIT_NUMBERS.length;
  res.render('payment/deposit', { user: req.session.user, payNumber: current });
});

router.post('/deposit', requireLogin, paymentLimiter, async (req, res) => {
  const { method, account_number } = req.body;
  const transaction_id = (req.body.transaction_id || '').trim();
  const wantBonus = req.body.want_bonus === 'yes';
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (!VALID_METHODS.includes(method)) {
    req.flash('error', 'অকার্যকর পেমেন্ট মেথড');
    return res.redirect('/payment/deposit');
  }
  if (!method || amount === null || !transaction_id || !account_number) {
    req.flash('error', 'সব তথ্য সঠিকভাবে দিন');
    return res.redirect('/payment/deposit');
  }
  if (amount < 100) {
    req.flash('error', 'সর্বনিম্ন ডিপোজিট ১০০ টাকা');
    return res.redirect('/payment/deposit');
  }

  try {
    const u = await pool.query(`SELECT daily_deposit_limit FROM users WHERE id = $1`, [userId]);
    const limit = u.rows[0] && u.rows[0].daily_deposit_limit ? Number(u.rows[0].daily_deposit_limit) : null;
    if (limit) {
      const todayDep = await pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests
         WHERE user_id = $1 AND type = 'deposit' AND status != 'rejected'
           AND created_at::date = CURRENT_DATE`,
        [userId]
      );
      const already = Number(todayDep.rows[0].total);
      if (already + amount > limit) {
        req.flash('error', `দৈনিক ডিপোজিট সীমা ${limit} টাকা। আজ আর ${Math.max(0, limit - already)} টাকা ডিপোজিট করতে পারবেন।`);
        return res.redirect('/payment/deposit');
      }
    }
  } catch (e) {
    console.error('deposit limit check error:', e.message);
  }

  // ==== Duplicate Transaction ID ব্লক ====
  // একই TrxID দিয়ে আগে pending/approved ডিপোজিট থাকলে আটকানো হচ্ছে —
  // rejected বাদ রাখা হয়েছে যাতে ভুল/টাইপো করে reject হওয়া ট্রানজেকশন আইডি বৈধভাবে আবার সাবমিট করা যায়
  try {
    const dupCheck = await pool.query(
      `SELECT id FROM payment_requests
       WHERE type='deposit' AND method=$1 AND transaction_id=$2 AND status != 'rejected'
       LIMIT 1`,
      [method, transaction_id]
    );
    if (dupCheck.rows.length > 0) {
      req.flash('error', 'এই ট্রানজেকশন আইডি আগে ব্যবহার করা হয়েছে।');
      return res.redirect('/payment/deposit');
    }
  } catch (e) {
    console.error('duplicate trx_id check error:', e.message);
  }

  try {
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status, want_bonus) VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending', $6)`,
      [userId, method, amount, transaction_id, account_number, wantBonus]
    );
    checkIp((req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()).then(vpnInfo => {
      evaluateTransaction(userId, 'deposit', { accountNumber: account_number, vpnInfo })
        .catch(e => console.error('fraud evaluateTransaction (deposit) error:', e.message));
    }).catch(e => console.error('vpn checkIp (deposit) error:', e.message));
    await notifyAdmins('নতুন ডিপোজিট রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা ডিপোজিট চেয়েছে (${method})।`, 'deposit');
    req.flash('success', 'ডিপোজিট রিকোয়েস্ট পাঠানো হয়েছে!');
    res.redirect('/payment/history');
  } catch (err) {
    // DB-এর unique constraint (race condition-এ দুইটা রিকোয়েস্ট একসাথে এলে) ধরার জন্য দ্বিতীয় স্তরের সুরক্ষা
    if (err.code === '23505') {
      req.flash('error', 'এই ট্রানজেকশন আইডি আগে ব্যবহার করা হয়েছে।');
      return res.redirect('/payment/deposit');
    }
    console.error('deposit error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/deposit');
  }
});

router.get('/withdraw', requireLogin, async (req, res) => {
  try {
    const result = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    const coins = result.rows[0]?.coins || 0;
    let cards = [];
    try {
      const cardRes = await pool.query('SELECT * FROM bank_cards WHERE user_id=$1', [req.session.user.id]);
      cards = cardRes.rows;
    } catch (e) { cards = []; }
    let pinStatus = { configured: false, locked: false };
    try { pinStatus = await getPinStatus(req.session.user.id); } catch (e) {}
    res.render('payment/withdraw', { user: req.session.user, coins, cards, pinStatus });
  } catch (err) {
    console.error('withdraw GET error:', err.message);
    res.redirect('/');
  }
});


router.post('/withdraw', requireLogin, requireVerifiedEmail, paymentLimiter, async (req, res) => {
  const { method, account_number, withdraw_pin } = req.body;
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

  // ==================== Withdraw PIN ভেরিফিকেশন (নতুন নিরাপত্তা স্তর) ====================
  // প্রতিটি উইথড্র রিকোয়েস্টের আগে PIN যাচাই করা বাধ্যতামূলক। এটা একটা আলাদা গেট —
  // নিচের বিদ্যমান উইথড্র বিজনেস লজিক (turnover check, coins deduction ইত্যাদি) অপরিবর্তিত রাখা হয়েছে।
  try {
    const pinCheck = await verifyPin(userId, withdraw_pin, req.ip);

    if (pinCheck.notConfigured) {
      req.flash('error', 'উত্তোলনের আগে আপনার Withdraw PIN সেট করতে হবে। Security পেজ থেকে PIN তৈরি করুন।');
      return res.redirect('/profile/security');
    }
    if (pinCheck.locked) {
      const mins = Math.max(1, Math.ceil((pinCheck.remainingMs || 0) / 60000));
      req.flash('error', `অনেকবার ভুল Withdraw PIN দেওয়ার কারণে উত্তোলন সাময়িকভাবে লক করা হয়েছে। ${mins} মিনিট পর আবার চেষ্টা করুন।`);
      return res.redirect('/payment/withdraw');
    }
    if (!pinCheck.success) {
      const left = pinCheck.attemptsLeft != null ? ` (আর ${pinCheck.attemptsLeft} বার সুযোগ আছে)` : '';
      req.flash('error', `Withdraw PIN ভুল হয়েছে${left}।`);
      return res.redirect('/payment/withdraw');
    }
  } catch (e) {
    console.error('withdraw pin verification error:', e.message);
    req.flash('error', 'PIN যাচাই করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।');
    return res.redirect('/payment/withdraw');
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
    broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;

    checkIp((req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()).then(vpnInfo => {
      evaluateTransaction(userId, 'withdraw', { accountNumber: account_number, vpnInfo })
        .catch(e => console.error('fraud evaluateTransaction (withdraw) error:', e.message));
    }).catch(e => console.error('vpn checkIp (withdraw) error:', e.message));

    await notifyAdmins('নতুন উইথড্র রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা উইথড্র চেয়েছে (${method})।`, 'withdraw');

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
  try {
    const { type, quick, from, to } = req.query;
    const conditions = ['user_id=$1'];
    const params = [req.session.user.id];

    if (type === 'deposit' || type === 'withdraw') {
      params.push(type);
      conditions.push(`type=$${params.length}`);
    }

    let dateFrom = from, dateTo = to;
    if (quick === 'today') {
      dateFrom = new Date().toISOString().slice(0, 10);
      dateTo = dateFrom;
    } else if (quick === 'yesterday') {
      const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      dateFrom = y; dateTo = y;
    } else if (quick === '7days') {
      dateFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      dateTo = new Date().toISOString().slice(0, 10);
    }

    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`created_at::date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`created_at::date <= $${params.length}`);
    }

    const result = await pool.query(
      `SELECT * FROM payment_requests WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.render('payment/history', {
      user: req.session.user,
      requests: result.rows,
      filter: { type: type || '', quick: quick || '', from: dateFrom || '', to: dateTo || '' }
    });
  } catch (err) {
    console.error('history error:', err.message);
    res.render('payment/history', { user: req.session.user, requests: [], filter: { type: '', quick: '', from: '', to: '' } });
  }
});

router.get('/admin/payments', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id ORDER BY pr.created_at DESC`
    );
    res.render('payment/admin', { user: req.session.user, requests: result.rows });
  } catch (err) {
    res.render('payment/admin', { user: req.session.user, requests: [] });
  }
});

function dhakaTodayStr() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00+06:00');
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function dhakaStartOf(dateStr) { return new Date(dateStr + 'T00:00:00+06:00'); }
function dhakaEndOf(dateStr) { return new Date(dateStr + 'T23:59:59.999+06:00'); }

router.get('/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const method = ['bkash', 'nagad', 'rocket'].includes(req.query.method) ? req.query.method : 'bkash';
    const quick = req.query.quick || 'today';
    const today = dhakaTodayStr();
    let fromStr, toStr;

    if (quick === '7d') { fromStr = addDaysStr(today, -6); toStr = today; }
    else if (quick === '30d') { fromStr = addDaysStr(today, -29); toStr = today; }
    else if (quick === '90d') { fromStr = addDaysStr(today, -89); toStr = today; }
    else if (quick === 'year') { fromStr = today.slice(0, 4) + '-01-01'; toStr = today; }
    else if (quick === 'custom') { fromStr = req.query.from || today; toStr = req.query.to || today; }
    else { fromStr = today; toStr = today; }

    const fromTs = dhakaStartOf(fromStr);
    const toTs = dhakaEndOf(toStr);

    // তিনটা মেথডেরই টোটাল (বর্তমান ডেট রেঞ্জে) — ট্যাব হেডারে দেখানোর জন্য, শুধু approved হিসাব করা হচ্ছে
    const totalsResult = await pool.query(
      `SELECT method, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM payment_requests
       WHERE type='deposit' AND status='approved' AND method = ANY($1) AND created_at BETWEEN $2 AND $3
       GROUP BY method`,
      [['bkash', 'nagad', 'rocket'], fromTs, toTs]
    );
    const totals = { bkash: { total: 0, cnt: 0 }, nagad: { total: 0, cnt: 0 }, rocket: { total: 0, cnt: 0 } };
    totalsResult.rows.forEach(r => { totals[r.method] = { total: Number(r.total), cnt: parseInt(r.cnt) }; });

    // সিলেক্টেড ট্যাবের সব ট্রানজেকশন (pending/approved/rejected সবই — অ্যাডমিন অ্যাকশন নেওয়ার জন্য)
    const listResult = await pool.query(
      `SELECT pr.*, u.username FROM payment_requests pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.type='deposit' AND pr.method=$1 AND pr.created_at BETWEEN $2 AND $3
       ORDER BY pr.created_at DESC`,
      [method, fromTs, toTs]
    );

    res.render('payment/deposits', {
      user: req.session.user,
      method,
      quick,
      from: fromStr,
      to: toStr,
      totals,
      requests: listResult.rows
    });
  } catch (err) {
    console.error('deposits admin error:', err.message);
    res.render('payment/deposits', {
      user: req.session.user,
      method: 'bkash',
      quick: 'today',
      from: dhakaTodayStr(),
      to: dhakaTodayStr(),
      totals: { bkash: { total: 0, cnt: 0 }, nagad: { total: 0, cnt: 0 }, rocket: { total: 0, cnt: 0 } },
      requests: []
    });
  }
});

router.get('/admin/summary', requireAdmin, async (req, res) => {
  try {
    const quick = req.query.quick || 'today';
    const today = dhakaTodayStr();
    let fromStr, toStr;

    if (quick === '7d') {
      fromStr = addDaysStr(today, -6);
      toStr = today;
    } else if (quick === '30d') {
      fromStr = addDaysStr(today, -29);
      toStr = today;
    } else if (quick === 'all') {
      fromStr = '1970-01-01';
      toStr = today;
    } else if (quick === 'custom') {
      fromStr = req.query.from || today;
      toStr = req.query.to || today;
    } else {
      fromStr = today;
      toStr = today;
    }

    const fromTs = dhakaStartOf(fromStr);
    const toTs = dhakaEndOf(toStr);

    const grandResult = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END),0) AS total_deposit,
         COALESCE(SUM(CASE WHEN type='withdraw' THEN amount ELSE 0 END),0) AS total_withdraw,
         COUNT(*) FILTER (WHERE type='deposit') AS deposit_count,
         COUNT(*) FILTER (WHERE type='withdraw') AS withdraw_count
       FROM payment_requests
       WHERE status='approved' AND created_at BETWEEN $1 AND $2`,
      [fromTs, toTs]
    );

    const dailyResult = await pool.query(
      `SELECT
         DATE(created_at AT TIME ZONE 'Asia/Dhaka') AS day,
         COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END),0) AS deposit_total,
         COALESCE(SUM(CASE WHEN type='withdraw' THEN amount ELSE 0 END),0) AS withdraw_total
       FROM payment_requests
       WHERE status='approved' AND created_at BETWEEN $1 AND $2
       GROUP BY DATE(created_at AT TIME ZONE 'Asia/Dhaka')
       ORDER BY day DESC`,
      [fromTs, toTs]
    );

    const userResult = await pool.query(
      `SELECT u.id, u.username,
         COALESCE(SUM(CASE WHEN pr.type='deposit' THEN pr.amount ELSE 0 END),0) AS total_deposit,
         COALESCE(SUM(CASE WHEN pr.type='withdraw' THEN pr.amount ELSE 0 END),0) AS total_withdraw
       FROM payment_requests pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.status='approved' AND pr.created_at BETWEEN $1 AND $2
       GROUP BY u.id, u.username
       ORDER BY total_deposit DESC`,
      [fromTs, toTs]
    );

    res.render('payment/summary', {
      user: req.session.user,
      quick,
      from: fromStr,
      to: toStr,
      grand: grandResult.rows[0],
      daily: dailyResult.rows,
      users: userResult.rows
    });
  } catch (err) {
    console.error('summary error:', err.message);
    res.render('payment/summary', {
      user: req.session.user,
      quick: 'today',
      from: dhakaTodayStr(),
      to: dhakaTodayStr(),
      grand: { total_deposit: 0, total_withdraw: 0, deposit_count: 0, withdraw_count: 0 },
      daily: [],
      users: []
    });
  }
});

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

    if (request.type === 'deposit') {
      await creditApprovedDeposit(client, request);
    } else {
      await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
        [request.user_id, 'পেমেন্ট অনুমোদন', `আপনার ${request.amount} টাকার উইথড্র অনুমোদন হয়েছে!`]
      );
    }
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
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [Math.round(Number(request.amount)), request.user_id]);
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

// ==================== SSLCommerz (বিকাশ/নগদ/রকেট/কার্ড) — সম্পূর্ণ অটোমেটিক ====================
// অ্যাডমিনকে কোনো কিছু ম্যানুয়ালি অনুমোদন করতে হয় না — গেটওয়ে ভ্যালিডেশন পাশ করলেই কয়েন যোগ হয়ে যায়।

router.post('/sslcommerz/init', requireLogin, async (req, res) => {
  const wantBonus = req.body.want_bonus === 'yes';
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (amount === null || amount < 100) {
    req.flash('error', 'সর্বনিম্ন ডিপোজিট ১০০ টাকা');
    return res.redirect('/payment/deposit');
  }

  const tranId = `LIVO${userId}${Date.now()}${crypto.randomBytes(3).toString('hex')}`;

  try {
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status, want_bonus, gateway, gateway_tran_id)
       VALUES ($1, 'deposit', 'sslcommerz', $2, 'pending', $3, 'sslcommerz', $4)`,
      [userId, amount, wantBonus, tranId]
    );

    const baseUrl = req.protocol + '://' + req.get('host');
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
    req.flash('error', 'পেমেন্ট গেটওয়ে চালু করা যায়নি। আবার চেষ্টা করুন।');
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
      req.flash('error', 'ট্রানজেকশন খুঁজে পাওয়া যায়নি');
      return res.redirect('/payment/deposit');
    }
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.redirect('/payment/history'); // আগেই IPN দিয়ে ক্রেডিট হয়ে গেছে
    }

    const verification = await sslcommerz.validatePayment(val_id);
    const validStatus = verification.status === 'VALID' || verification.status === 'VALIDATED';
    const amountMatches = Math.round(Number(verification.amount)) === Math.round(Number(request.amount));

    if (!validStatus || !amountMatches) {
      await client.query(
        `UPDATE payment_requests SET status='rejected', gateway_val_id=$1, gateway_response=$2, updated_at=NOW() WHERE id=$3`,
        [val_id, JSON.stringify(verification), request.id]
      );
      await client.query('COMMIT');
      req.flash('error', 'পেমেন্ট ভেরিফাই করা যায়নি।');
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
    req.flash('success', `আপনার ${request.amount} টাকার ডিপোজিট সফল হয়েছে!`);
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sslcommerz success error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে, সাপোর্টে যোগাযোগ করুন।');
    res.redirect('/payment/deposit');
  } finally {
    client.release();
  }
});

router.post('/sslcommerz/fail', async (req, res) => {
  const { tran_id } = req.body;
  try {
    await pool.query(
      `UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE gateway_tran_id=$1 AND status='pending'`,
      [tran_id]
    );
  } catch (e) { console.error('sslcommerz fail error:', e.message); }
  req.flash('error', 'পেমেন্ট ব্যর্থ হয়েছে।');
  res.redirect('/payment/deposit');
});

router.post('/sslcommerz/cancel', async (req, res) => {
  const { tran_id } = req.body;
  try {
    await pool.query(
      `UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE gateway_tran_id=$1 AND status='pending'`,
      [tran_id]
    );
  } catch (e) { console.error('sslcommerz cancel error:', e.message); }
  req.flash('error', 'পেমেন্ট বাতিল করা হয়েছে।');
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
    const amountMatches = Math.round(Number(verification.amount)) === Math.round(Number(request.amount));

    if (validStatus && amountMatches) {
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
    res.sendStatus(200);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.creditApprovedDeposit = creditApprovedDeposit;
