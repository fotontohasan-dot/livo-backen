const express = require('express');
const router = express.Router();

// Sports Hub Main Page
router.get('/', (req, res) => {
  res.render('sports/index', {
    currentPage: 'sports',
    title: 'Sports Hub'
  });
});

// Cricket Page
router.get('/cricket', (req, res) => {
  res.render('matches', { 
    currentPage: 'cricket',
    title: 'Cricket Live'
  });
});

// Football Page (এখনো ডেভেলপমেন্টে)
router.get('/football', (req, res) => {
  res.render('sports/index', { 
    currentPage: 'football',
    title: 'Football'
  });
});

// Tennis Page
router.get('/tennis', (req, res) => {
  res.render('sports/index', { 
    currentPage: 'tennis',
    title: 'Tennis'
  });
});

module.exports = router;
