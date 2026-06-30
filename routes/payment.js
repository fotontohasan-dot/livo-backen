const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { createBonus, canWithdraw } = require('../services/turnover');
const { processReferralDeposit } = require('../services/referral');

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
  const { method, transaction_id, account_number } = req.body;
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

  try {
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status, want_bonus) VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending', $6)`,
      [userId, method, amount, transaction_id, account_number, wantBonus]
    );
    await notifyAdmins('নতুন ডিপোজিট রিকোয়েস্ট', `${req.session.user.username} ${amount} টাকা ডিপোজিট চেয়েছে (${method})।`);
    req.flash('success', 'ডিপোজিট রিকোয়েস্ট পাঠানো হয়েছে!');
    res.redirect('/payment/history');
  } catch (err) {
    console.error('deposit error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/deposit');
  }
});

router.get('/withdraw', requireLogin, async (req, res) => {
  try {
    const result = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    const coins = result.rows[0]?.coins || 0;

    const cardsResult = await pool.query('SELECT * FROM bank_cards WHERE user_id=$1', [req.session.user.id]);
    const cards = cardsResult.rows;

    res.render('payment/withdraw', { user: req.session.user, coins, cards });
  } catch (err) {
    console.error('withdraw GET error:', err.message);
    res.redirect('/');
  }
});

router.post('/withdraw', requireLogin, async (req, res) => {
  const { amount: rawAmount, password } = req.body;
  const amount = parseAmount(rawAmount);
  const userId = req.session.user.id;

  if (amount === null || !password) {
    req.flash('error', 'সব তথ্য সঠিকভাবে দিন');
    return res.redirect('/payment/withdraw');
  }

  try {
    // পাসওয়ার্ড যাচাই (বিকাশ/নগদ এর মত সিকিউরিটি পিন)
    const userRes = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    const isMatch = await require('bcryptjs').compare(password, userRes.rows[0].password);
    if (!isMatch) {
      req.flash('error', 'ভুল সিকিউরিটি পাসওয়ার্ড');
      return res.redirect('/payment/withdraw');
    }
  } catch (e) {
    req.flash('error', 'সার্ভার সমস্যা');
    return res.redirect('/payment/withdraw');
  }

  // ওয়ালেট নির্বাচন চেক
  const cardsRes = await pool.query('SELECT * FROM bank_cards WHERE user_id = $1 LIMIT 1', [userId]);
  if (cardsRes.rows.length === 0) {
    req.flash('error', 'অনুগ্রহ করে আগে একটি ই-ওয়ালেট যোগ করুন');
    return res.redirect('/profile/cards');
  }
  const method = cardsRes.rows[0].bank_name.toLowerCase();
  const account_number = cardsRes.rows[0].account_number;

  if (!method || amount === null || !account_number) {
    req.flash('error', 'সব তথ্য সঠিকভাবে দিন');
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
  try {
    const result = await pool.query(
      `SELECT * FROM payment_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.session.user.id]
    );
    res.render('payment/history', { user: req.session.user, requests: result.rows });
  } catch (err) {
    res.render('payment/history', { user: req.session.user, requests: [] });
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

    let bonusGiven = 0;

    if (request.type === 'deposit') {
      // আসল কয়েন যোগ
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
      await client.query('UPDATE users SET total_deposited = COALESCE(total_deposited,0) + $1 WHERE id=$2', [request.amount, request.user_id]);

      // বোনাস নিলে — রিলোড নিয়ম অনুযায়ী শতাংশ
      if (request.want_bonus) {
        // এই ডিপোজিটের আগে কতগুলো approved ডিপোজিট হয়েছে
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
    }

    await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);

    let message;
    if (request.type === 'deposit') {
      message = bonusGiven > 0
        ? `আপনার ${request.amount} টাকার ডিপোজিট + ${bonusGiven} বোনাস যোগ হয়েছে! (টার্নওভার প্রযোজ্য)`
        : `আপনার ${request.amount} টাকার ডিপোজিট অনুমোদন হয়েছে!`;
    } else {
      message = `আপনার ${request.amount} টাকার উইথড্র অনুমোদন হয়েছে!`;
    }
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
      [request.user_id, 'পেমেন্ট অনুমোদন', message]
    );
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

module.exports = router;
