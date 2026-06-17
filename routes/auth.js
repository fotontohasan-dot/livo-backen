const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sendOTP } = require('../services/email');

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

router.get('/', (req, res) => res.render('index', { user: req.session.user || null }));

router.get('/register', (req, res) => {
  const ref = req.query.ref || '';
  res.render('registration', { ref });
});

// Step 1: Send OTP
router.post('/register/send-otp', async (req, res) => {
  const email = req.body.email ? req.body.email.trim().toLowerCase() : '';
  if (!email) return res.json({ success: false, message: '❌ ইমেইল প্রদান করুন।' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.json({ success: false, message: '❌ এই ইমেইল আগেই নিবন্ধিত।' });
    }
    const otp = generateOTP();

    // Store in session for better reliability
    req.session.otp = otp;
    req.session.otpEmail = email;
    req.session.otpExpiry = Date.now() + 5 * 60 * 1000;

    await sendOTP(email, otp);
    res.json({ success: true, message: '✅ OTP পাঠানো হয়েছে!' });
  } catch (err) {
    console.error('OTP Send Error:', err);
    res.json({ success: false, message: '❌ OTP পাঠাতে ব্যর্থ হয়েছে। ইমেইল সেটিংস চেক করুন।' });
  }
});

// Step 2: Verify OTP and Register
router.post('/register', async (req, res) => {
  const { username, password, otp } = req.body;
  const email = req.body.email ? req.body.email.trim().toLowerCase() : '';

  try {
    if (!req.session.otp || req.session.otpEmail !== email) {
      req.flash('error', '❌ আগে সঠিক ইমেইলে OTP পাঠান।');
      return res.redirect('/register');
    }
    if (req.session.otp !== otp) {
      req.flash('error', '❌ OTP ভুল হয়েছে।');
      return res.redirect('/register');
    }
    if (Date.now() > req.session.otpExpiry) {
      req.flash('error', '❌ OTP মেয়াদ শেষ। আবার চেষ্টা করুন।');
      delete req.session.otp;
      delete req.session.otpEmail;
      delete req.session.otpExpiry;
      return res.redirect('/register');
    }

    // Clear OTP from session
    delete req.session.otp;
    delete req.session.otpEmail;
    delete req.session.otpExpiry;

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
    req.flash('error', '❌ রেজিস্ট্রেশন ব্যর্থ হয়েছে।');
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

module.exports = router;
