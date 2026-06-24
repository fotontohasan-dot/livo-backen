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
router.get('/cricket', (req, res) => {
  res.render('matches', { 
    currentPage: 'cricket',
    title: 'Cricket Live'
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
