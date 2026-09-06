const express = require('express');
const router = express.Router();
const { isAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
const { pool } = require('../db');
const { createLimiter } = require('../middleware/rateLimitFactory');

// KYC জমাদানে সীমা — পরিচয়পত্র/ডকুমেন্ট বারবার জমা দেওয়া স্প্যাম/রিসোর্স অপব্যবহার
// (অ্যাডমিন রিভিউ কিউ ভরিয়ে ফেলা) ঠেকাতে ঘণ্টায় সর্বোচ্চ ৫ বার।
const kycLimiter = createLimiter('kyc_submit', {
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: (req) => req.t('kyc_rate_limited'),
  keyGenerator: (req) => (req.session && req.session.user) ? `u_${req.session.user.id}` : req.ip
});

// ==== KYC ইনপুট ভ্যালিডেশন ====
const KYC_NAME_RE = /^[\p{L}\p{M}\s.'-]{2,60}$/u;
const KYC_DOCNUM_RE = /^[A-Za-z0-9\-\s]{3,30}$/;
const KYC_DOCTYPE_RE = /^[A-Za-z_\-\s]{2,40}$/;

// res.cloudinary.com একটা শেয়ার্ড মাল্টি-টেন্যান্ট CDN হোস্ট — আসল টেন্যান্ট শনাক্ত হয়
// URL পাথের প্রথম সেগমেন্ট (cloud_name) দিয়ে। শুধু হোস্টনেম চেক করলে যে কেউ *যেকোনো*
// Cloudinary অ্যাকাউন্টের পাবলিক URL (এমনকি Cloudinary-র নিজের পাবলিক ডেমো অ্যাসেট)
// document_url হিসেবে জমা দিতে পারত এবং সেটা নিজের KYC ডকুমেন্ট হিসেবে গৃহীত হয়ে যেত।
// এখন cloud_name আমাদের নিজের (CLOUDINARY_CLOUD_NAME) কিনা এবং পাথ আমাদের নিজস্ব
// আপলোড ফোল্ডারের (routes/chat.js-এর 'livo/chat', যেটা KYC আপলোডও ব্যবহার করে) ভেতরে
// কিনা — দুটোই যাচাই করা হয়।
function isSafeCloudinaryUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') return false;
    const expectedPrefix = `/${cloudName}/`;
    if (!parsed.pathname.startsWith(expectedPrefix)) return false;
    return parsed.pathname.includes('/livo/chat/');
  } catch (e) {
    return false;
  }
}


router.get('/invitation', isAuth, requireFeature('referral'), async (req, res) => {
    try {
        const userResult = await pool.query('SELECT id, referral_code FROM users WHERE id = $1', [req.session.user.id]);
        const { id, referral_code } = userResult.rows[0] || {};
        const referralCode = referral_code || 'N/A';
        const referrals = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by_id = $1', [id]);
        res.render('extra/invitation', { referralCode, referralCount: parseInt(referrals.rows[0].count) });
    } catch (err) {
        console.error(err);
        res.render('extra/placeholder', { title: req.t('invite') });
    }
});

router.get('/promotion', isAuth, requireFeature('promotions'), (req, res) => {
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
        res.render('kyc', { kyc: r.rows[0] || null, loadError: false });
    } catch (err) {
        console.error('kyc page error:', err.message);
        // আগে এখানে `{ kyc: null }` রেন্ডার হত — অর্থাৎ ডেটাবেস ব্যর্থ হলে
        // পেজটা হুবহু "আপনি এখনো KYC জমা দেননি" অবস্থার মতো দেখাত। ইউজার
        // তখন আবার জমা দিতে যেত, অথচ তার আগের অনুরোধ হয়তো approved। তাই
        // দুটো অবস্থা এখন আলাদা: loadError=true মানে "জানা যায়নি"।
        res.render('kyc', { kyc: null, loadError: true });
    }
});

// KYC সাবমিট
router.post('/kyc', isAuth, kycLimiter, async (req, res) => {
    const userId = req.session.user.id;
    const { full_name, document_type, document_number, document_url } = req.body;

    if (!full_name || !document_number) {
        req.flash('error', req.t('kyc_name_and_number_required'));
        return res.redirect('/extra/kyc');
    }
    if (!document_url) {
        req.flash('error', req.t('kyc_document_image_required'));
        return res.redirect('/extra/kyc');
    }
    if (!isSafeCloudinaryUrl(document_url)) {
        req.flash('error', req.t('kyc_document_image_source_invalid'));
        return res.redirect('/extra/kyc');
    }
    if (!KYC_NAME_RE.test(full_name.trim())) {
        req.flash('error', req.t('common_name_invalid_characters'));
        return res.redirect('/extra/kyc');
    }
    if (!KYC_DOCNUM_RE.test(document_number.trim())) {
        req.flash('error', req.t('kyc_document_number_format'));
        return res.redirect('/extra/kyc');
    }
    if (document_type && !KYC_DOCTYPE_RE.test(document_type.trim())) {
        req.flash('error', req.t('kyc_document_type_invalid'));
        return res.redirect('/extra/kyc');
    }

    try {
        // আগের পেন্ডিং রকোয়েস্ট থাকলে নতুন করে নয়
        const existing = await pool.query(
            "SELECT id FROM kyc_requests WHERE user_id = $1 AND status = 'pending'",
            [userId]
        );
        if (existing.rows[0]) {
            req.flash('error', req.t('kyc_request_already_pending'));
            return res.redirect('/extra/kyc');
        }

        // উপরের SELECT-টা দ্রুত ও বন্ধুত্বপূর্ণ বার্তা দেয়, কিন্তু সেটাই একমাত্র
        // ভরসা নয় — সমান্তরাল দুটো সাবমিশন দুটোই ওই চেক পাস করতে পারে।
        // আসল নিশ্চয়তা DB-র partial unique index (uniq_kyc_pending_per_user)।
        // দুই টেবিল একই ট্রানজেকশনে, যাতে রিকোয়েস্ট ঢুকে গিয়ে users.kyc_status
        // পিছিয়ে না থাকে।
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO kyc_requests (user_id, full_name, document_type, document_number, document_url, status)
                 VALUES ($1, $2, $3, $4, $5, 'pending')`,
                [userId, full_name, document_type || null, document_number, document_url || null]
            );
            await client.query("UPDATE users SET kyc_status = 'pending' WHERE id = $1", [userId]);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            if (e.code === '23505') { // unique_violation — অন্য রিকোয়েস্ট আগে ঢুকে গেছে
                req.flash('error', req.t('kyc_request_already_pending'));
                return res.redirect('/extra/kyc');
            }
            throw e;
        } finally {
            client.release();
        }

        req.flash('success', req.t('kyc_submitted'));
        res.redirect('/extra/kyc');
    } catch (err) {
        console.error('kyc submit error:', err.message);
        req.flash('error', req.t('common_submit_failed'));
        res.redirect('/extra/kyc');
    }
});

module.exports = router;
