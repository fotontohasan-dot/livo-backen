const express = require('express');
const router = express.Router();
const { isAuth } = require('../middleware/auth');
const { pool } = require('../db');

// ==== KYC ইনপুট ভ্যালিডেশন ====
const KYC_NAME_RE = /^[\p{L}\p{M}\s.'-]{2,60}$/u;
const KYC_DOCNUM_RE = /^[A-Za-z0-9\-\s]{3,30}$/;
const KYC_DOCTYPE_RE = /^[A-Za-z_\-\s]{2,40}$/;

function isSafeCloudinaryUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com';
  } catch (e) {
    return false;
  }
}


router.get('/invitation', isAuth, async (req, res) => {
    try {
        const userResult = await pool.query('SELECT id, referral_code FROM users WHERE id = $1', [req.session.user.id]);
        const { id, referral_code } = userResult.rows[0] || {};
        const referralCode = referral_code || 'N/A';
        const referrals = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by_id = $1', [id]);
        res.render('extra/invitation', { referralCode, referralCount: parseInt(referrals.rows[0].count) });
    } catch (err) {
        console.error(err);
        res.render('extra/placeholder', { title: 'আমন্ত্রণ' });
    }
});

router.get('/promotion', isAuth, (req, res) => {
    res.render('extra/promotion');
});

router.get('/faq', (req, res) => {
    res.render('extra/faq');
});

// KYC পেজ (বর্তমান স্টাস সহ)
router.get('/kyc', isAuth, async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT * FROM kyc_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
            [req.session.user.id]
        );
        res.render('kyc', { kyc: r.rows[0] || null });
    } catch (err) {
        console.error('kyc page error:', err.message);
        res.render('kyc', { kyc: null });
    }
});

// KYC সাবমিট
router.post('/kyc', isAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { full_name, document_type, document_number, document_url } = req.body;

    if (!full_name || !document_number) {
        req.flash('error', 'নাম ও ডকুমেন্ট নাম্বার দিন!');
        return res.redirect('/extra/kyc');
    }
    if (!document_url) {
        req.flash('error', 'ডকুমেন্টের ছবি আপলোড করুন!');
        return res.redirect('/extra/kyc');
    }
    if (!isSafeCloudinaryUrl(document_url)) {
        req.flash('error', 'ডকুমেন্ট ছবি আমাদের নিজস্ব আপলোড সিস্টেম থেকে আসতে হবে।');
        return res.redirect('/extra/kyc');
    }
    if (!KYC_NAME_RE.test(full_name.trim())) {
        req.flash('error', 'নামে অস্বাভাবিক ক্যারেক্টার বা লিংক থাকা যাবে না।');
        return res.redirect('/extra/kyc');
    }
    if (!KYC_DOCNUM_RE.test(document_number.trim())) {
        req.flash('error', 'ডকুমেন্ট নম্বরে শুধু লেটার, সংখ্যা, স্পেস, হাইফেন ব্যবহার করা যাবে।');
        return res.redirect('/extra/kyc');
    }
    if (document_type && !KYC_DOCTYPE_RE.test(document_type.trim())) {
        req.flash('error', 'ডকুমেন্ট টাইপ সঠিক নয়।');
        return res.redirect('/extra/kyc');
    }

    try {
        // আগের পেন্ডিং রকোয়েস্ট থাকলে নতুন করে নয়
        const existing = await pool.query(
            "SELECT id FROM kyc_requests WHERE user_id = $1 AND status = 'pending'",
            [userId]
        );
        if (existing.rows[0]) {
            req.flash('error', 'আপনার একটি KYC রিকোয়েস্ট ইতিমধ্যে যাচাইযর অপেক্ষায় আছে।');
            return res.redirect('/extra/kyc');
        }

        await pool.query(
            `INSERT INTO kyc_requests (user_id, full_name, document_type, document_number, document_url, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [userId, full_name, document_type || null, document_number, document_url || null]
        );
        await pool.query("UPDATE users SET kyc_status = 'pending' WHERE id = $1", [userId]);

        req.flash('success', 'KYC তথ্য জমা হয়েছে! যাচাইয়ের পর জানানো হবে।');
        res.redirect('/extra/kyc');
    } catch (err) {
        console.error('kyc submit error:', err.message);
        req.flash('error', 'জমা দিতে সমস্যা হয়েছে।');
        res.redirect('/extra/kyc');
    }
});

module.exports = router;
