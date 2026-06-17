const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { pool } = require('../db');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

router.get('/', (req, res) => res.render('index', { user: req.session.user || null }));

router.post('/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'ইমেইল প্রয়োজন' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.otp = otp;
  req.session.otpEmail = email;
  req.session.otpExpiry = Date.now() + 5 * 60 * 1000; // 5 mins

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: email,
    subject: 'LIVO Registration OTP',
    text: `আপনার রেজিস্ট্রেশন OTP হলো: ${otp}. এটি ৫ মিনিটের জন্য কার্যকর থাকবে।`
  };

  try {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
        console.warn('Gmail credentials not set, logging OTP instead:', otp);
        return res.json({ success: true, message: 'OTP পাঠানো হয়েছে (সিমুলেটেড)' });
    }
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'আপনার ইমেইলে OTP পাঠানো হয়েছে' });
  } catch (error) {
    console.error('Email Error:', error);
    res.status(500).json({ success: false, message: 'OTP পাঠাতে সমস্যা হয়েছে' });
  }
});

router.get('/register', (req, res) => {
 const ref = req.query.ref || '';
 res.render('registration', { ref });
});

router.post('/register', async (req, res) => {
 const { username, email, password, otp } = req.body;
 try {
   // OTP Verification
   if (!req.session.otp || !req.session.otpExpiry || Date.now() > req.session.otpExpiry) {
     req.flash('error', '❌ OTP মেয়াদ শেষ হয়েছে। আবার পাঠান।');
     return res.redirect('/register');
   }
   if (otp !== req.session.otp) {
     req.flash('error', '❌ ভুল OTP কোড।');
     return res.redirect('/register');
   }
   if (email !== req.session.otpEmail) {
     req.flash('error', '❌ ইমেইল মেলেনি।');
     return res.redirect('/register');
   }

   // Clear OTP after verification
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
   if (err.code === '23505') { // Unique violation
     if (err.detail.includes('email')) {
       req.flash('error', '❌ এই ইমেইলটি ইতিপূর্বে ব্যবহার করা হয়েছে।');
     } else if (err.detail.includes('username')) {
       req.flash('error', '❌ এই ইউজারনেমটি ইতিপূর্বে ব্যবহার করা হয়েছে।');
     } else {
       req.flash('error', '❌ এই তথ্যগুলো ইতিপূর্বে ব্যবহার করা হয়েছে।');
     }
   } else {
     req.flash('error', '❌ রেজিস্ট্রেশন ব্যর্থ হয়েছে। আবার চেষ্টা করুন।');
   }
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
     req.flash('error', '❌ ইমেইল অথব পাসওয়ার্ড ভুল।');
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
