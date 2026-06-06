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
    await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'স্বাগতম!','আপনি ৫০০ কয়েন ওয়েলকাম বোনাস পেয়েছেন','success')`, [user.id]);
    req.session.user = user;
    req.flash('success', 'রেজিস্ট্রেশন সফল হয়েছে! আপনি ৫০০ কয়েন বোনাস পেয়েছেন');
    res.redirect('/');
  } catch (_err) {
    req.flash('error', 'ইউজারনেম অথবা ইমেইল ইতিমধ্যে ব্যবহার করা হয়েছে');
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
      req.flash('error', 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়');
      return res.redirect('/login');
    }
    if (user.is_banned) {
      req.flash('error', 'আপনার অ্যাকাউন্টটি ব্যান করা হয়েছে');
      return res.redirect('/login');
    }
    req.session.user = user;
    res.redirect('/');
  } catch (_err) {
    req.flash('error', 'লগইন করতে সমস্যা হয়েছে');
    res.redirect('/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

router.get('/create-admin', async (req, res) => {
  try {
    const hashed = await bcrypt.hash('admin123', 10);
    const result = await pool.query(
      `INSERT INTO users (username, email, password, role, coins) 
       VALUES ('admin', 'admin@livo.com', $1, 'admin', 9999999) 
       ON CONFLICT (email) DO UPDATE SET role='admin', password=$1
       RETURNING id, username, email, role`,
      [hashed]
    );
    const user = result.rows[0];
    req.session.user = user;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<h2 style="color:green;font-family:sans-serif">
      ✅ Admin তৈরি হয়েছে!<br>
      Email: admin@livo.com<br>
      Password: admin123<br>
      <a href="/login">এখানে Login করুন</a>
    </h2>`);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<pre style="color:red">${JSON.stringify(err, null, 2)}</pre>`);
  }
});

module.exports = router;
