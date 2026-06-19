const express = require('express');
const router = express.Router();
const { isAuth } = require('../middleware/auth');
const { pool } = require('../db');

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
    res.render('extra/placeholder', { title: 'প্রমোশন' });
});

module.exports = router;
