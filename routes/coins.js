const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');

router.get('/', isAuth, async (req, res) => {
  try {
    const transactions = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.session.user.id]);
    const user = await pool.query(`SELECT coins FROM users WHERE id=$1`, [req.session.user.id]);
    res.render('coins', { transactions: transactions.rows, coins: user.rows[0].coins });
  } catch (err) {
    req.flash('error', req.t('common_server_error_short'));
    res.redirect('/');
  }
});

// LIMIT ছাড়া পুরো coin_transactions হিস্ট্রি ফেরত দিত — দীর্ঘদিনের সক্রিয় ইউজারের (প্রতিটা
// bet/reward/bonus আলাদা row) হাজার হাজার row জমে HTML রেসপন্স ও রেন্ডারিং ভারী হয়ে যেত।
// Phase 11-এ /chat/history-তে একই প্যাটার্নের ফিক্স করা হয়েছিল — এখানেও একই কৌশল: সাম্প্রতিক
// ৫০০টা রাখা হচ্ছে (ক্রম ও রেসপন্স শেপ অপরিবর্তিত)।
router.get('/history', isAuth, async (req, res) => {
  try {
    const transactions = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500`, [req.session.user.id]);
    res.render('coins', { transactions: transactions.rows, coins: req.session.user.coins });
  } catch (err) {
    req.flash('error', req.t('common_server_error_short'));
    res.redirect('/coins');
  }
});

// রিয়েল-টাইম ব্যালেন্স (navbar এই endpoint থেকে আপডেট নেয়)
router.get('/balance', isAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    const coins = r.rows[0] ? r.rows[0].coins : 0;
    if (req.session.user) req.session.user.coins = coins;
    res.json({ success: true, coins });
  } catch (err) {
    res.json({ success: false, coins: null });
  }
});

router.post('/daily-bonus', isAuth, requireFeature('daily_rewards'), async (req, res) => {
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
      req.flash('error', req.t('coins_daily_bonus_already_claimed'));
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
    req.flash('error', req.t('common_server_error_short'));
    res.redirect('/coins');
  } finally {
    client.release();
  }
});

module.exports = router;
