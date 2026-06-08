const express = require('express');
const router = express.Router();
const { pool } = require('../db');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/');
  next();
}

router.get('/deposit', requireLogin, (req, res) => {
  res.render('payment/deposit', { user: req.session.user });
});

router.post('/deposit', requireLogin, async (req, res) => {
  const { method, amount, transaction_id, account_number } = req.body;
  const userId = req.session.user.id;
  if (!method || !amount || !transaction_id || !account_number) {
    req.flash('error', 'সব তথ্য দিন');
    return res.redirect('/payment/deposit');
  }
  if (amount < 100) {
    req.flash('error', 'সর্বনিম্ন ডপোজিট ১০০ টাকা');
    return res.redirect('/payment/deposit');
  }
  try {
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status) VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending')`,
      [userId, method, amount, transaction_id, account_number]
    );
    req.flash('success', 'ডিপোজিট রিকোয়েস্ট পাঠানো হয়ছে!');
    res.redirect('/payment/history');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/deposit');
  }
});

router.get('/withdraw', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
  const coins = result.rows[0]?.coins || 0;
  res.render('payment/withdraw', { user: req.session.user, coins });
});

router.post('/withdraw', requireLogin, async (req, res) => {
  const { method, amount, account_number } = req.body;
  const userId = req.session.user.id;
  if (!method || !amount || !account_number) {
    req.flash('error', 'সব তথ্য দিন');
    return res.redirect('/payment/withdraw');
  }
  if (amount < 200) {
    req.flash('error', 'সর্বনিম্ন উইথড্র ২০০ টাকা');
    return res.redirect('/payment/withdraw');
  }
  try {
    const result = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    const coins = result.rows[0]?.coins || 0;
    if (coins < amount) {
      req.flash('error', 'পর্যাপ্ত কয়েন নই');
      return res.redirect('/payment/withdraw');
    }
    await pool.query('UPDATE users SET coins = coins - $1 WHERE id=$2', [amount, userId]);
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status) VALUES ($1, 'withdraw', $2, $3, $4, 'pending')`,
      [userId, method, amount, account_number]
    );
    req.flash('success', 'উইথড্র রিকোয়েস্ট পাঠানো হয়েছে!');
    res.redirect('/payment/history');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/withdraw');
  }
});

router.get('/history', requireLogin, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM payment_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.session.user.id]
  );
  res.render('payment/history', { user: req.session.user, requests: result.rows });
});

router.get('/admin/payments', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id ORDER BY pr.created_at DESC`
  );
  res.render('payment/admin', { user: req.session.user, requests: result.rows });
});

router.post('/admin/approve/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM payment_requests WHERE id=$1', [id]);
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      req.flash('error', 'রিকোয়েস্ট পাওয়া যায়নি');
      return res.redirect('/payment/admin/payments');
    }
    if (request.type === 'deposit') {
      await pool.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
    }
    await pool.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);
    const message = request.type === 'deposit'
      ? `আপনার ${request.amount} টাকার ডিপোজিট অনুমোদন হয়েছে!`
      : `আপনার ${request.amount} টাকার উইথড্র অনুমোদন হয়েছে!`;
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
      [request.user_id, 'পেমেন্ট অনুমোদন', message]
    );
    req.flash('success', 'অনুমোদন হয়েছে');
    res.redirect('/payment/admin/payments');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/payment/admin/payments');
  }
});

router.post('/admin/reject/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM payment_requests WHERE id=$1', [id]);
    const request = result.rows[0];
    if (request && request.type === 'withdraw' && request.status === 'pending') {
      await pool.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [request.amount, request.user_id]);
    }
    await pool.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error')`,
      [request.user_id, 'পমেন্ট বাতিল', `আপনার ${request.amount} টাকার রিকোয়েস্ট বাতিল হয়েছে।`]
    );
    req.flash('error', 'বাতিল করা হয়েছে');
    res.redirect('/payment/admin/payments');
  } catch (err) {
    res.redirect('/payment/admin/payments');
  }
});

module.exports = router;
