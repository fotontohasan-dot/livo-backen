const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { createBonus, canWithdraw } = require('../services/turnover');
const { processReferralDeposit } = require('../services/referral');
const crypto = require('crypto');
const sslcommerz = require('../services/sslcommerz');
const { broadcastDemoStats, emitAdminAlert } = require('../services/socket');

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

// Transaction IDs and account numbers should only ever be short alphanumeric
// codes. This allow-list (letters, digits, space, - _ .) rejects anything
// containing <, >, /, quotes, or other characters a link/script injection
// attempt would need, and caps the length so nothing large can be stuffed in.
const SAFE_FIELD_RE = /^[A-Za-z0-9 _.\-]{1,40}$/;
function isSafeField(value) {
  return typeof value === 'string' && SAFE_FIELD_RE.test(value.trim());
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

router.post('/deposit', requireLogin, async (req, res) => {
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
  if (!isSafeField(transaction_id) || !isSafeField(account_number)) {
    req.flash('error', 'ট্রানজেকশন আইডি বা নম্বরে শুধু লেটার, সংখ্যা, স্পেস, - _ . ব্যবহার করা যাবে। লিংক বা অন্য কোনো চিহ্ন গ্রহণযোগ্য নয়।');
    return res.redirect('/payment/deposit');
  }
  if (amount < 100) {
    req.flash('error', 'সর্বনিম্ন ডিপোজিট ১০০ টাকা');
    return res.redirect('/payment/deposit');
  }

  // একই ট্রানজেকশন আইডি আগে অন্য কোনো (বাতিল ছাড়া) ডিপোজিটে ব্যবহৃত হয়েছে কিনা তা আগেই চেক করা
  // (কেস-ইনসেনসিটিভ, যাতে "ABC123" আর "abc123" আলাদা করে বাইপাস করা না যায়)
  try {
    const dup = await pool.query(
      `SELECT id FROM payment_requests
       WHERE type = 'deposit' AND status <> 'cancelled'
         AND LOWER(TRIM(transaction_id)) = LOWER($1)
       LIMIT 1`,
      [transaction_id]
    );
    if (dup.rowCount) {
      req.flash('error', 'এই ট্রানজেকশন আইডি আগে থেকেই ব্যবহার হয়েছে। নতুন ট্রানজেকশন আইডি দিন।');
      return res.redirect('/payment/deposit');
    }
  } catch (e) {
    console.error('deposit duplicate trx check error:', e.message);
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

  try {
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status, want_bonus) VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending', $6)`,
      [userId, method, amount, transaction_id, account_number, wantBonus]
    );
    await notifyAdmins('নতুন ডিপোজিট রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা ডিপোজিট চেয়েছে (${method})।`, 'deposit');
    req.flash('success', 'ডিপোজিট রিকোয়েস্ট পাঠানো হয়েছে!');
    res.redirect('/payment/history');
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', 'এই ট্রানজেকশন আইডি আগে থেকেই ব্যবহার হয়েছে। নতুন ট্রানজেকশন আইডি দিন।');
      return res.redirect('/payment/deposit');
    }
    console.error('deposit error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/deposit');
  }
});

// ইউজার নিজে পেন্ডিং ডিপোজিট রিকোয়েস্ট বাতিল করতে পারবে
router.post('/deposit/:id/cancel', requireLogin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE payment_requests SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND type='deposit' AND status='pending' RETURNING id`,
      [id, req.session.user.id]
    );
    if (!result.rowCount) {
      req.flash('error', 'এই রিকোয়েস্ট বাতিল করা যাচ্ছে না (হয়তো আগেই প্রসেস হয়ে গেছে)');
    } else {
      req.flash('success', 'ডিপোজিট রিকোয়েস্ট বাতিল হয়েছে');
    }
  } catch (err) {
    console.error('deposit cancel error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/payment/history');
});

// পেন্ডিং ডিপোজিট রিকোয়েস্টের এডিট ফর্ম
router.get('/deposit/:id/edit', requireLogin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM payment_requests WHERE id=$1 AND user_id=$2 AND type='deposit' AND status='pending'`,
      [id, req.session.user.id]
    );
    if (!result.rows.length) {
      req.flash('error', 'এই রিকোয়েস্ট এডিট করা যাচ্ছে না');
      return res.redirect('/payment/history');
    }
    res.render('payment/deposit-edit', { user: req.session.user, request: result.rows[0] });
  } catch (err) {
    console.error('deposit edit form error:', err.message);
    res.redirect('/payment/history');
  }
});

// পেন্ডিং ডিপোজিট রিকোয়েস্ট এডিট সাবমিট
router.post('/deposit/:id/edit', requireLogin, async (req, res) => {
  const { id } = req.params;
  const account_number = (req.body.account_number || '').trim();
  const transaction_id = (req.body.transaction_id || '').trim();
  if (!transaction_id || !account_number) {
    req.flash('error', 'সব তথ্য সঠিকভাবে দিন');
    return res.redirect(`/payment/deposit/${id}/edit`);
  }
  if (!isSafeField(transaction_id) || !isSafeField(account_number)) {
    req.flash('error', 'ট্রানজেকশন আইডি বা নম্বরে শুধু লেটার, সংখ্যা, স্পেস, - _ . ব্যবহার করা যাবে। লিংক বা অন্য কোনো চিহ্ন গ্রহণযোগ্য নয়।');
    return res.redirect(`/payment/deposit/${id}/edit`);
  }

  try {
    const dup = await pool.query(
      `SELECT id FROM payment_requests
       WHERE type = 'deposit' AND status <> 'cancelled'
         AND LOWER(TRIM(transaction_id)) = LOWER($1)
         AND id <> $2
       LIMIT 1`,
      [transaction_id, id]
    );
    if (dup.rowCount) {
      req.flash('error', 'এই ট্রানজেকশন আইডি আগে থেকেই ব্যবহার হয়েছে। নতুন ট্রানজেকশন আইডি দিন।');
      return res.redirect(`/payment/deposit/${id}/edit`);
    }
  } catch (e) {
    console.error('deposit edit duplicate trx check error:', e.message);
  }

  try {
    const result = await pool.query(
      `UPDATE payment_requests SET transaction_id=$1, account_number=$2, updated_at=NOW()
       WHERE id=$3 AND user_id=$4 AND type='deposit' AND status='pending' RETURNING id`,
      [transaction_id, account_number, id, req.session.user.id]
    );
    if (!result.rowCount) {
      req.flash('error', 'এই রিকোয়েস্ট এডিট করা যাচ্ছে না');
    } else {
      req.flash('success', 'ডিপোজিট রিকোয়েস্ট আপডেট হয়েছে');
    }
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', 'এই ট্রানজেকশন আইডি আগে থেকেই ব্যবহার হয়েছে');
      return res.redirect(`/payment/deposit/${id}/edit`);
    }
    console.error('deposit edit error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/payment/history');
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

    let withdrawLock = { allowed: true, pending: [] };
    try {
      withdrawLock = await canWithdraw(req.session.user.id);
    } catch (e) {
      console.error('withdraw lock check error:', e.message);
    }

    res.render('payment/withdraw', { user: req.session.user, coins, cards, withdrawLock });
  } catch (err) {
    console.error('withdraw GET error:', err.message);
    res.redirect('/');
  }
});


router.post('/withdraw', requireLogin, async (req, res) => {
  const { method, account_number } = req.body;
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

  // নিরাপত্তা: ইউজার শুধু তার নিজের যুক্ত করা ই-ওয়ালেট নাম্বারেই উইথড্র করতে পারবে —
  // hidden ফিল্ড ক্লায়েন্ট সাইডে ম্যানিপুলেট করলেও সার্ভার এখানে ম্যাচ যাচাই করবে
  try {
    const ownedWallet = await pool.query(
      `SELECT id FROM bank_cards WHERE user_id = $1 AND account_number = $2 AND LOWER(bank_name) LIKE '%' || LOWER($3) || '%'`,
      [userId, account_number, method]
    );
    if (ownedWallet.rowCount === 0) {
      req.flash('error', 'শুধুমাত্র আপনার সংযুক্ত ই-ওয়ালেট নাম্বারেই উত্তোলন করা যাবে');
      return res.redirect('/payment/withdraw');
    }
  } catch (e) {
    console.error('wallet ownership check error:', e.message);
    req.flash('error', 'সমস্যা হয়েছে, আবার চেষ্টা করুন');
    return res.redirect('/payment/withdraw');
  }
  if (amount < 200) {
    req.flash('error', 'সর্বনিম্ন উইথড্র ২০০ টাকা');
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
