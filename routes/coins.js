const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/', isAuth, async (req, res) => {
  const transactions = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.session.user.id]);
  const user = await pool.query(`SELECT coins FROM users WHERE id=$1`, [req.session.user.id]);
  res.render('coins', { transactions: transactions.rows, coins: user.rows[0].coins });
});

router.get('/history', isAuth, async (req, res) => {
  const transactions = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC`, [req.session.user.id]);
  res.render('coins', { transactions: transactions.rows, coins: req.session.user.coins });
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


module.exports = router;
