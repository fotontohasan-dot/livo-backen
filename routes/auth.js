const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    res.render('index', { user: req.session.user || null });
  } catch (err) {
    console.error('Error rendering index:', err);
    res.status(500).send('Render Error: ' + err.message);
  }
});

router.get('/register', (req, res) => {
  const ref = req.query.ref || '';
  res.render('registration', { ref });
});

router.post('/register', async (req, res) => {
  const { username, email, phone, password, confirmPassword, referralCode } = req.body;

  try {
    if (!username || !password) {
      req.flash('error', '❌ ইউজারনেম এবং পাসওয়ার্ড আবশ্যক।');
      return res.redirect('/register');
    }

    if (!email && !phone) {
      req.flash('error', '❌ ইমেইল অথবা ফোন নাম্বার অন্তত একটি দিতে হবে।');
      return res.redirect('/register');
    }

    if (password.length < 8) {
      req.flash('error', '❌ পাসওয়ার্ড কমপক্ষে ৮ অক্ষর হতে হবে।');
      return res.redirect('/register');
    }

    if (confirmPassword && password !== confirmPassword) {
      req.flash('error', '❌ পাসওয়ার্ড মিলছে না।');
      return res.redirect('/register');
    }

    if (email) {
      const existingEmail = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existingEmail.rows.length > 0) {
        req.flash('error', '❌ এই ইমেইল আগেই নিবন্ধিত।');
        return res.redirect('/register');
      }
    }

    if (phone) {
      const existingPhone = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (existingPhone.rows.length > 0) {
        req.flash('error', '❌ এই ফোন নাম্বার আগেই নিবন্ধিত।');
        return res.redirect('/register');
      }
    }

    const hashed = await bcrypt.hash(password, 10);
    const myCode = username.toUpperCase().slice(0, 4) + Math.floor(1000 + Math.random() * 9000);

    let referredById = null;
    if (ref) {
      const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [ref]);
      if (referrer.rows[0]) referredById = referrer.rows[0].id;
    }

    const result = await pool.query(`
      INSERT INTO users (username, email, phone, password, role, coins, referral_code, created_at)
      VALUES ($1, $2, $3, $4, 'user', 0, $5, NOW()) RETURNING *
    `, [username, email || null, phone || null, hashed, myCode]);

    req.session.user = result.rows[0];
    req.flash('success', '✅ রেজিস্ট্রেশন সফল হয়েছে! স্বাগতম!');
    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', '❌ রেজিস্ট্রেশন ব্যর্থ হয়েছে।');
    res.redirect('/register');
  }
});

router.get('/login', (req, res) => res.render('login'));

router.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR phone = $1',
      [identifier]
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password))) {
      req.flash('error', '❌ তথ্য অথবা পাসওয়ার্ড ভুল।');
      return res.redirect('/login');
    }
    if (user.is_banned) {
      req.flash('error', '❌ আপনার অ্যাকাউন্ট ব্যান করা হয়েছে।');
      return res.redirect('/login');
    }

    req.session.user = user;

    if (user.role && user.role.toLowerCase() === 'admin') {
      return res.redirect('/admin');
    }
    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', '❌ লগইন ব্যর্থ হয়েছে।');
    res.redirect('/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
