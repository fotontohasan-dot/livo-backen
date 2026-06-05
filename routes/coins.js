const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/', isAuth, async (req, res) => {
  const transactions = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.session.user.id]);
  const user = await pool.query(`SELECT coins FROM users WHERE id=$1`, [req.session.user.id]);
  res.render('coins', { transactions: transactions.rows, coins: user.rows[0].coins });
});

router.post('/daily-bonus', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
  const today = new Date().toDateString();
  const lastBonus = user.rows[0].last_bonus_date ? new Date(user.rows[0].last_bonus_date).toDateString() : null;
  if (lastBonus === today) {
    req.flash('error', 'Already claimed today! Come back tomorrow');
    return res.redirect('/coins');
  }
  const bonusAmount = 100;
  await pool.query(`UPDATE users SET coins=coins+$1, last_bonus_date=NOW() WHERE id=$2`, [bonusAmount, userId]);
  await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'daily_bonus','Daily login bonus')`, [userId, bonusAmount]);
  await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'Daily Bonus!','You claimed 100 daily coins','success')`, [userId]);
  req.session.user.coins += bonusAmount;
  req.flash('success', `Daily bonus claimed! +${bonusAmount} coins`);
  res.redirect('/coins');
});

router.get('/deposit', isAuth, (_req, res) => {
  res.render('deposit');
});

router.post('/deposit', isAuth, async (req, res) => {
  const { method, amount, phone, txid } = req.body;
  const depositAmount = parseInt(amount);
  const coins = depositAmount * 10;
  const userId = req.session.user.id;
  const isAutomatic = method === 'card';
  const status = isAutomatic ? 'completed' : 'pending';

  try {
    if (isAutomatic) {
      await pool.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [coins, userId]);
      req.session.user.coins += coins;
    }

    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description, status, txid, method, phone, is_automatic)
       VALUES ($1, $2, 'deposit', $3, $4, $5, $6, $7, $8)`,
      [userId, coins, `Deposit via ${method}`, status, txid || 'AUTO', method, phone || 'AUTO', isAutomatic]
    );

    const msg = isAutomatic ? `ডিপোজিট সফল! ${coins} কয়েন যোগ করা হয়েছে।` : `ডিপোজিট রিকোয়েস্ট পেন্ডিং আছে। যাচাই শেষে কয়েন যোগ করা হবে।`;
    await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'ডিপোজিট', $2, 'info')`, [userId, msg]);

    req.flash('success', msg);
    res.redirect('/coins');
  } catch (err) {
    console.error(err);
    req.flash('error', 'ডিপোজিট প্রসেস করতে সমস্যা হয়েছে।');
    res.redirect('/coins/deposit');
  }
});

router.get('/withdraw', isAuth, (_req, res) => {
  res.render('withdraw');
});

router.post('/withdraw', isAuth, async (req, res) => {
  const { method, amount, phone } = req.body;
  const coins = parseInt(amount);
  const userId = req.session.user.id;

  try {
    const user = await pool.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
    if (user.rows[0].coins < coins) {
      req.flash('error', 'পর্যাপ্ত কয়েন নেই!');
      return res.redirect('/coins/withdraw');
    }

    await pool.query(`UPDATE users SET coins=coins-$1 WHERE id=$2`, [coins, userId]);
    req.session.user.coins -= coins;

    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description, status, method, phone)
       VALUES ($1, $2, 'withdraw', $3, 'pending', $4, $5)`,
      [userId, -coins, `Withdraw via ${method}`, method, phone]
    );

    await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'উইথড্র রিকোয়েস্ট', 'আপনার ${coins} কয়েন উইথড্র রিকোয়েস্টটি পেন্ডিং আছে।', 'info')`, [userId]);

    req.flash('success', 'উইথড্র রিকোয়েস্ট সফলভাবে পাঠানো হয়েছে।');
    res.redirect('/coins');
  } catch (err) {
    console.error(err);
    req.flash('error', 'উইথড্র রিকোয়েস্ট পাঠাতে সমস্যা হয়েছে।');
    res.redirect('/coins/withdraw');
  }
});

module.exports = router;
