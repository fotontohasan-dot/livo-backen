// routes/matches.js
const express = require('express');
const router = express.Router();
const sportsAPI = require('../services/sportsAPI');

// মূল matches page - সব live + upcoming
router.get('/', async (req, res) => {
  try {
    const sport = req.query.sport || 'all';

    const [cricketLive, cricketUpcoming, footballLive, worldCup] = await Promise.all([
      sportsAPI.getCricketCurrentMatches(),
      sportsAPI.getCricketUpcoming(),
      sportsAPI.getFootballLiveScores(),
      sportsAPI.getWorldCupFixtures(),
    ]);

    let liveMatches = [];
    let upcomingMatches = [];

    if (sport === 'cricket' || sport === 'all') {
      liveMatches = liveMatches.concat(cricketLive.filter(m => !m.matchEnded));
      upcomingMatches = upcomingMatches.concat(cricketUpcoming);
    }

    if (sport === 'football' || sport === 'all') {
      liveMatches = liveMatches.concat(footballLive);
      upcomingMatches = upcomingMatches.concat(worldCup);
    }

    res.render('matches', {
      title: 'Live Matches',
      currentPage: 'matches',
      liveMatches,
      upcomingMatches,
      sport,
      user: req.session.user,
    });
  } catch (err) {
    console.error('Matches route error:', err);
    req.flash('error', 'ম্যাচ ডেটা লোড করতে সমস্যা হয়েছে।');
    res.render('matches', {
      title: 'Live Matches',
      currentPage: 'matches',
      liveMatches: [],
      upcomingMatches: [],
      sport: 'all',
      user: req.session.user,
    });
  }
});

// FIFA World Cup 2026 specific page
router.get('/worldcup', async (req, res) => {
  try {
    const fixtures = await sportsAPI.getWorldCupFixtures();
    const live = await sportsAPI.getFootballLiveScores();
    const worldCupLive = live.filter(m =>
      (m.league || '').toLowerCase().includes('world cup')
    );

    res.render('matches', {
      title: 'FIFA World Cup 2026',
      currentPage: 'worldcup',
      liveMatches: worldCupLive,
      upcomingMatches: fixtures,
      sport: 'football',
      user: req.session.user,
    });
  } catch (err) {
    console.error('World Cup route error:', err);
    res.redirect('/matches');
  }
});

// Cricket specific
router.get('/cricket', async (req, res) => {
  try {
    const [live, upcoming] = await Promise.all([
      sportsAPI.getCricketCurrentMatches(),
      sportsAPI.getCricketUpcoming(),
    ]);
    res.render('matches', {
      title: 'Cricket Matches',
      currentPage: 'cricket',
      liveMatches: live,
      upcomingMatches: upcoming,
      sport: 'cricket',
      user: req.session.user,
    });
  } catch (err) {
    res.redirect('/matches');
  }
});

// Football specific
router.get('/football', async (req, res) => {
  try {
    const [live, worldCup] = await Promise.all([
      sportsAPI.getFootballLiveScores(),
      sportsAPI.getWorldCupFixtures(),
    ]);
    res.render('matches', {
      title: 'Football Matches',
      currentPage: 'football',
      liveMatches: live,
      upcomingMatches: worldCup,
      sport: 'football',
      user: req.session.user,
    });
  } catch (err) {
    res.redirect('/matches');
  }
});

// Match detail page
router.get('/cricket/:id', async (req, res) => {
  try {
    const match = await sportsAPI.getCricketMatchInfo(req.params.id);
    if (!match) {
      req.flash('error', 'ম্যাচ খুঁজে পাওয়া যায়নি।');
      return res.redirect('/matches/cricket');
    }
    res.render('match-detail', {
      title: match.name || 'Match Details',
      currentPage: 'matches',
      match,
      sport: 'cricket',
      user: req.session.user,
    });
  } catch (err) {
    console.error('Match detail error:', err);
    res.redirect('/matches/cricket');
  }
});

// JSON API endpoint - frontend live update এর জন্য
router.get('/api/live', async (req, res) => {
  try {
    const [cricket, football] = await Promise.all([
      sportsAPI.getCricketCurrentMatches(),
      sportsAPI.getFootballLiveScores(),
    ]);
    res.json({
      success: true,
      cricket,
      football,
      timestamp: Date.now(),
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
