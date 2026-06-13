const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { connectDB } = require('../db');

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  coins: { type: Number, default: 0 },
  is_banned: { type: Boolean, default: false },
  referral_code: String,
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

router.get('/', (_req, res) => res.render('index'));

router.get('/register', (req, res) => {
  const ref = req.query.ref || '';
  res.render('registration', { ref });
});

router.post('/register', async (req, res) => {
  const { username, email, password, referral_code } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const myCode = username.toUpperCase().slice(0,4) + Math.floor(1000 + Math.random() * 9000);

    const user = new User({ username, email, password: hashed, referral_code: myCode, coins: 500 });
    await user.save();

    req.session.user = user.toObject();
    req.flash('success', 'রেজিস্ট্রেশন সফল! ৫০০ কয়েন বোনাস পেয়েছেন');
    res.redirect('/');
  } catch (err) {
    req.flash('error', 'ইউজারনেম অথবা ইমেইল ইতিমধ্যে ব্যবহার করা হয়েছে');
    res.redirect('/register');
  }
});

router.get('/login', (_req, res) => res.render('login'));

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      req.flash('error', 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়');
      return res.redirect('/login');
    }
    if (user.is_banned) {
      req.flash('error', 'আপনার অ্যাকাউন্টটি ব্যান করা হয়েছে');
      return res.redirect('/login');
    }
    req.session.user = user.toObject();
    res.redirect('/');
  } catch (err) {
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
    let admin = await User.findOne({ email: 'admin@livo.com' });
    if (!admin) {
      admin = new User({
        username: 'admin',
        email: 'admin@livo.com',
        password: hashed,
        role: 'admin',
        coins: 9999999
      });
      await admin.save();
    } else {
      admin.role = 'admin';
      admin.password = hashed;
      await admin.save();
    }
    req.session.user = admin.toObject();
    res.send(`<h2 style="color:green;font-family:sans-serif">✅ Admin তৈরি হয়েছে!<br>Email: admin@livo.com<br>Password: admin123<br><a href="/login">Login করুন</a></h2>`);
  } catch (err) {
    res.send(`Error: ${err.message}`);
  }
});

module.exports = router;
