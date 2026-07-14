const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db');
const { createReferral } = require('../services/referral');
const { sendPasswordReset } = require('../services/email');

function sanitizeUser(u) {
  if (!u) return null;
  const safe = { ...u };
  delete safe.password;
  delete safe.reset_token;
  delete safe.reset_token_expiry;
  return safe;
}

async function recordLogin(req, userId) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ua = req.get('user-agent') || '';
    await pool.query(
      `UPDATE users SET last_login = NOW(), last_ip = $1, last_device = $2, login_count = COALESCE(login_count,0) + 1 WHERE id = $3`,
      [ip, ua, userId]
    );
    await pool.query(
      `INSERT INTO login_logs (user_id, ip, user_agent) VALUES ($1, $2, $3)`,
      [userId, ip, ua]
    );
  } catch (e) {
    console.error('recordLogin error:', e.message);
  }
}

router.get('/', async (req, res) => {
  try {
    res.render('index', { user: req.session.user || null });
  } catch (err) {
    console.error('Error rendering index:', err);
    res.status(500).send('Render Error');
  }
});

router.get('/register', (req, res) => {
  const ref = req.query.ref || '';
  res.render('registration', { ref });
});

router.post('/register', async (req, res) => {
  const { username, email, phone, password, confirmPassword, referralCode } = req.body;
  const ref = referralCode || req.query.ref || '';

  try {
    if (!username || !password) {
      req.flash('error', '❌ ইউজারনেম এবং পাসওয়ার্ড আবশ্যক।');
      return res.redirect('/register');
    }
    if (!/^[A-Za-z0-9_.]{3,20}$/.test(username.trim())) {
      req.flash('error', '❌ ইউজারনেমে শুধু লেটার, সংখ্যা, আন্ডারস্কোর, ডট ব্যবহার করা যাবে (৩-২০ ক্যারেক্টার)।');
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
      INSERT INTO users (username, email, phone, password, role, coins, referral_code, referred_by_id, created_at)
      VALUES ($1, $2, $3, $4, 'user', 0, $5, $6, NOW()) RETURNING *
    `, [username, email || null, phone || null, hashed, myCode, referredById]);

    const newUserId = result.rows[0].id;

    if (referredById) {
      await createReferral(null, referredById, newUserId);
    }

    await recordLogin(req, newUserId);
    req.session.user = sanitizeUser(result.rows[0]);
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

    // সেল্ফ-এক্সকশন চেক — নির্দিষ্ট সময় পর্যন্ত লগইন বন্ধ
    if (user.self_exclude_until && new Date(user.self_exclude_until) > new Date()) {
      const until = new Date(user.self_exclude_until).toLocaleDateString('bn-BD');
      req.flash('error', `আপনি নিজে অ্যাকাউন্ট বন্ধ রেখেছেন। ${until} পর্যন্ত লগইন করা যাবে না।`);
      return res.redirect('/login');
    }

    await recordLogin(req, user.id);
    req.session.user = sanitizeUser(user);

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

// ==================== পাসওয়ার্ড রিসেট (Forgot Password) ====================

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { sent: false });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    if (!email) {
      req.flash('error', '❌ ইমেইল দিন।');
      return res.redirect('/forgot-password');
    }

    const result = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // ইউজার থাকুক বা না থাকুক একই সাফল্যের মেসেজ দেখানো হয় (ইমেইল enumeration ঠেকাতে)
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 60 * 60 * 1000); // ১ ঘণ্টা
      await pool.query(
        'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
        [token, expiry, user.id]
      );

      const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${token}`;
      try {
        await sendPasswordReset(user.email, resetUrl);
      } catch (mailErr) {
        console.error('sendPasswordReset error:', mailErr.message);
      }
    }

    res.render('forgot-password', { sent: true });
  } catch (err) {
    console.error('forgot-password error:', err.message);
    req.flash('error', '❌ কিছু একটা সমস্যা হয়েছে, আবার চেষ্টা করুন।');
    res.redirect('/forgot-password');
  }
});

router.get('/reset-password/:token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
      [req.params.token]
    );
    if (result.rows.length === 0) {
      req.flash('error', '❌ লিঙ্কটি অকার্যকর অথবা মেয়াদ শেষ হয়ে গেছে। আবার চেষ্টা করুন।');
      return res.redirect('/forgot-password');
    }
    res.render('reset-password', { token: req.params.token });
  } catch (err) {
    console.error('reset-password GET error:', err.message);
    res.redirect('/forgot-password');
  }
});

router.post('/reset-password/:token', async (req, res) => {
  const { password, confirmPassword } = req.body;
  const { token } = req.params;
  try {
    if (!password || password.length < 8) {
      req.flash('error', '❌ পাসওয়ার্ড কমপক্ষে ৮ অক্ষর হতে হবে।');
      return res.redirect(`/reset-password/${token}`);
    }
    if (password !== confirmPassword) {
      req.flash('error', '❌ পাসওয়ার্ড মিলছে না।');
      return res.redirect(`/reset-password/${token}`);
    }

    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
      [token]
    );
    if (result.rows.length === 0) {
      req.flash('error', '❌ লিঙ্কটি অকার্যকর অথবা মেয়াদ শেষ হয়ে গেছে। আবার চেষ্টা করুন।');
      return res.redirect('/forgot-password');
    }

    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
      [hashed, result.rows[0].id]
    );

    req.flash('success', '✅ পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে। এখন লগইন করুন।');
    res.redirect('/login');
  } catch (err) {
    console.error('reset-password POST error:', err.message);
    req.flash('error', '❌ কিছু একটা সমস্যা হয়েছে, আবার চেষ্টা করুন।');
    res.redirect(`/reset-password/${token}`);
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
