const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

router.get('/', (req, res) => res.render('index', { user: req.session.user || null }));

router.get('/register', (req, res) => {
  const ref = req.query.ref || '';
  res.render('registration', { ref });
});

router.post('/register', async (req, res) => {
  const { username, email, password, referral_code } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const myCode = username.toUpperCase().slice(0, 4) + Math.floor(1000 + Math.random() * 9000);

    const result = await pool.query(`
      INSERT INTO users (username, email, password, role, coins, referral_code, created_at)
      VALUES ($1, $2, $3, 'user', 500, $4, NOW()) RETURNING *
    `, [username, email, hashed, myCode]);

    req.session.user = result.rows[0];
    req.flash('success', '✅ রেজিস্ট্রেশন সফল হয়েছে! স্বাগতম!');
    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', '❌ রেজিস্ট্রেশন ব্যর্থ হয়েছে। আবার চেষ্টা করুন।');
    res.redirect('/register');
  }
});

router.get('/login', (req, res) => res.render('login'));

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password))) {
      req.flash('error', '❌ ইমেইল অথবা পাসওয়ার্ড ভুল।');
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

// Create Admin Route
router.get('/create-admin', async (req, res) => {
  try {
    const hashed = await bcrypt.hash('admin123', 10);
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', ['admin@livo.com']);

    let admin;
    if (existing.rows.length === 0) {
      const result = await pool.query(`
        INSERT INTO users (username, email, password, role, coins, created_at)
        VALUES ('admin', 'admin@livo.com', $1, 'admin', 99999999, NOW()) RETURNING *
      `, [hashed]);
      admin = result.rows[0];
    } else {
      const result = await pool.query(`
        UPDATE users SET role = $1, password = $2 WHERE email = $3 RETURNING *
      `, ['admin', hashed, 'admin@livo.com']);
      admin = result.rows[0];
    }

    req.session.user = admin;
    res.send(`<h2 style="color:green;font-family:sans-serif">
      ✅ Admin Created Successfully!<br>
      Email: admin@livo.com<br>
      Password: admin123<br>
      <a href="/login">Login</a>
    </h2>`);
  } catch (err) {
    res.send(`Error: ${err.message}`);
  }
});

module.exports = router;
