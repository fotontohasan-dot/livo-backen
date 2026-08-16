const express = require('express');
const router = express.Router();

// Sports Hub Main Page
router.get('/', (req, res) => {
  res.render('sports/index', { 
    currentPage: 'sports',
    title: 'Sports Hub'
  });
});

// Cricket Section
// দ্রষ্টব্য: এখানে views/matches.ejs রেন্ডার করা হয়, আর ওই ভিউ `sport` ও `user`
// লোকাল দুটো বাধ্যতামূলকভাবে ব্যবহার করে (CURRENT_SPORT, IS_LOGGED_IN)। আগে সেগুলো
// পাস করা হতো না, তাই /sports/cricket প্রতিবার 500 এরর দিত — মেনুতে থাকা একটা
// সম্পূর্ণ ডেড লিংক। routes/matches.js-এর /cricket হ্যান্ডলারের মতোই লোকাল দেওয়া হলো।
router.get('/cricket', (req, res) => {
  res.render('matches', {
    currentPage: 'cricket',
    sport: 'cricket',
    title: 'Cricket Live',
    user: req.session ? req.session.user : null
  });
});

// Football Section
router.get('/football', (req, res) => {
  res.render('sports/index', { 
    currentPage: 'football',
    title: 'Football'
  });
});

// Tennis Section
router.get('/tennis', (req, res) => {
  res.render('sports/index', { 
    currentPage: 'tennis',
    title: 'Tennis'
  });
});

module.exports = router;
