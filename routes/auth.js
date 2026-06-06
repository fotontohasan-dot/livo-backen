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
    req.flash('success', 'Registration successful! You got 500 welcome coins');
    res.redirect('/');
  } catch (_err) {
    req.flash('error', 'Username or email already exists');
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
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }
    if (user.is_banned) {
      req.flash('error', 'Your account has been banned');
      return res.redirect('/login');
    }
    req.session.user = user;
    res.redirect('/');
  } catch (_err) {
    req.flash('error', 'Login failed');
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
    await pool.query(
      `INSERT INTO users (username, email, password, role, coins) 
       VALUES ('admin', 'admin@livo.com', $1, 'admin', 9999999) 
       ON CONFLICT (email) DO UPDATE SET role='admin', password=$1`,
      [hashed]
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h2 style="color:green">✅ Admin তৈরি হয়েছে!<br>Email: admin@livo.com<br>Password: admin123<br><a href="/login">এখানে Login করুন</a></

    } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h3 style="color:red">Error: ' + err.message + '</h3>');
  }

module.exports = router;
