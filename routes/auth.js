const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

router.get('/', (_req, res) => {
  res.render('index');
});

router.get('/register', (req, res) => {
  const ref = req.query.ref || '';
  res.render('registration', { ref });
});

router.post('/register', async (req, res) => {
  const { username, email, password, referral_code } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);

    // ইউনিক রেফারেল কোড তৈরি
    const myCode = username.toUpperCase().slice(0,4) + Math.floor(1000 + Math.random() * 9000);

    const result = await pool.query(
      `INSERT INTO users (username, email, password, referral_code) VALUES ($1,$2,$3,$4) RETURNING *`,
      [username, email, hashed, myCode]
    );
    const user = result.rows[0];

    // ওয়েলকাম বোনাস
    await pool.query(`UPDATE users SET coins=coins+500 WHERE id=$1`, [user.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,500,'bonus','Welcome bonus')`, [user.id]);
    await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'স্বাগতম!','আপনি ৫০০ কয়েন ওয়েলকাম বোনাস পেয়েছেন','success')`, [user.id]);

    // রেফারেল বোনাস
    if (referral_code) {
      const refUser = await pool.query(`SELECT * FROM users WHERE referral_code=$1`, [referral_code]);
      if (refUser.rows.length > 0) {
        const referId = refUser.rows[0].id;
        // রেফারার পাবে ২০০ কয়েন
        await pool.query(`UPDATE users SET coins=coins+200 WHERE id=$1`, [referId]);
        await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,200,'referral','রফারেল বোনাস')`, [referId]);
        await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'রেফারেল বোনাস!','আপনার রেফারেলে নতুন ইউজার যোগ দয়েছে! ২০০ কয়েন পেয়েছেন','success')`, [referId]);
        // নতুন ইউজার পাবে ১০০ এক্সট
        await pool.query(`UPDATE users SET coins=coins+100 WHERE id=$1`, [user.id]);
        await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'রেফারেল বোনাস!','রেফারেল কোড ব্যবহার ১০০ এক্সট্রা কয়েন পেয়েছেন','success')`, [user.id]);
      }
    }

    req.session.user = { ...user, coins: user.coins + 500 };
    req.flash('success', 'রেজিস্ট্রেশন সফল! ৫০০ কয়েন বোনাস পেয়েছেন');
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
      ✅ Admin তৈরি হয়ছে!<br>
      Email: admin@livo.com<br>
      Password: admin123<br>
      <a href="/login">এখানে Login করুন</a>
    </h2>`);
  } catch (err) {
    res.send(`<pre style="color:red">${JSON.stringify(err, null, 2)}</pre>`);
  }
});

module.exports = router;
