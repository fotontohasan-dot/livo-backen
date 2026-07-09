// routes/admin.js - Add these routes to your existing admin router

const express = require('express');
const router = express.Router();

// Example middleware to protect admin routes
function isAdmin(req, res, next) {
    // Add your admin auth check here
    if (req.session && req.session.isAdmin) {
        return next();
    }
    return res.redirect('/admin/login');
}

// Dashboard
router.get('/dashboard', isAdmin, (req, res) => {
    res.render('admin/dashboard', { title: 'Dashboard' });
});

// User Management
router.get('/users', isAdmin, (req, res) => {
    res.render('admin/users', { title: 'User Management' });
});

// Bets Management (your existing one)
router.get('/bets', isAdmin, (req, res) => {
    res.render('admin/bets', { title: 'Bets Management' });
});

// Deposits
router.get('/deposits', isAdmin, (req, res) => {
    res.render('admin/deposits', { title: 'Deposits Management' });
});

// Withdrawals
router.get('/withdrawals', isAdmin, (req, res) => {
    res.render('admin/withdrawals', { title: 'Withdrawals Management' });
});

// Support Tickets
router.get('/support', isAdmin, (req, res) => {
    res.render('admin/support', { title: 'Support Tickets' });
});

// Transactions
router.get('/transactions', isAdmin, (req, res) => {
    res.render('admin/transactions', { title: 'Transactions Log' });
});

// Reports
router.get('/reports', isAdmin, (req, res) => {
    res.render('admin/reports', { title: 'Reports & Analytics' });
});

// Settings
router.get('/settings', isAdmin, (req, res) => {
    res.render('admin/settings', { title: 'Settings' });
});

module.exports = router;