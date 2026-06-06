const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

router.get('/', (_req, res) => {
  res.render('index');
});

router.get('/register', (_req, res) => res.render('registration'));
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, email, password) VALUES ($1,$2,$3) RETURNING *`,
      [username, email, hashed]
    );
    const user = result.rows[0];
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,500,'bonus','Welcome bonus')`, [user.id]);
    await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'Welcome!','You got 500 coins as welcome bonus','success')`, [user.id]);
    req.session.user = user;
    req.flash('success', 'রেজিস্ট্রেশন সফল হয়েছে! আপনি ৫০০ কয়েন বোনাস পেয়েছেন।');
    res.redirect('/');
  } catch (err) {
    console.error('Registration error:', err);
    if (err.code === '23505') {
      req.flash('error', 'এই ইউজারনেম বা ইমেইল দিয়ে ইতিপূর্বে রেজিস্ট্রেশন করা হয়েছে।');
    } else if (err.code === 'ECONNREFUSED' || err.code === '57P03') {
      req.flash('error', 'সিস্টেমে যান্ত্রিক ত্রুটি দেখা দিয়েছে। দয়া করে কিছুক্ষণ পর আবার চেষ্টা করুন।');
    } else {
      req.flash('error', 'রেজিস্ট্রেশন করতে সমস্যা হয়েছে।');
    }
    res.redirect('/register');
  }
});

router.get('/login', (_req, res) => res.render('login'));
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      req.flash('error', 'ভুল ইমেইল বা পাসওয়ার্ড');
      return res.redirect('/login');
    }
    if (user.is_banned) {
      req.flash('error', 'Your account has been banned');
      return res.redirect('/login');
    }
    req.session.user = user;
    res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    if (err.code === 'ECONNREFUSED' || err.code === '57P03') {
      req.flash('error', 'সিস্টেমে যান্ত্রিক ত্রুটি দেখা দিয়েছে। দয়া করে কিছুক্ষণ পর আবার চেষ্টা করুন।');
    } else {
      req.flash('error', 'লগইন করতে সমস্যা হয়েছে।');
    }
    res.redirect('/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
