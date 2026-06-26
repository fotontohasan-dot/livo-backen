const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/', isAuth, async (req, res) => {
  try {
    const transactions = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.session.user.id]);
    const user = await pool.query(`SELECT coins FROM users WHERE id=$1`, [req.session.user.id]);
    res.render('coins', { transactions: transactions.rows, coins: user.rows[0].coins });
  } catch (err) {
    req.flash('error', 'সার্ভার ত্রুটি');
    res.redirect('/');
  }
});

router.get('/history', isAuth, async (req, res) => {
  try {
    const transactions = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC`, [req.session.user.id]);
    res.render('coins', { transactions: transactions.rows, coins: req.session.user.coins });
  } catch (err) {
    req.flash('error', 'সার্ভার ত্রুটি');
    res.redirect('/coins');
  }
});

router.post('/daily-bonus', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  const bonusAmount = 100;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upd = await client.query(
      `UPDATE users
         SET coins = coins + $1, last_bonus_date = NOW()
       WHERE id = $2
         AND (last_bonus_date IS NULL OR last_bonus_date::date < CURRENT_DATE)
       RETURNING coins`,
      [bonusAmount, userId]
    );

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      req.flash('error', 'আজকের বোনাস আগেই নেওয়া হয়েছে! আগামীকাল আবার আসুন।');
      return res.redirect('/coins');
    }

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'daily_bonus','Daily login bonus')`,
      [userId, bonusAmount]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'Daily Bonus!','You claimed 100 daily coins','success')`,
      [userId]
    );

    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;
    req.flash('success', `Daily bonus claimed! +${bonusAmount} coins`);
    res.redirect('/coins');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('daily-bonus error:', err.message);
    req.flash('error', 'সার্ভার ত্রুটি');
    res.redirect('/coins');
  } finally {
    client.release();
  }
});

module.exports = router;
