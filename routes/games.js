const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

// List of supported games
const supportedGames = {
  'aviator': 'Aviator',
  'teen-patti': 'Teen Patti',
  'andar-bahar': 'Andar Bahar',
  'blackjack': 'Blackjack',
  'poker': 'Poker',
  'baccarat': 'Baccarat',
  'roulette': 'Roulette',
  'slots': 'Slots',
  'ludo': 'Online Ludo'
};

// Render the game page
router.get('/:gameSlug', isAuth, async (req, res) => {
  const { gameSlug } = req.params;
  const gameDisplayName = supportedGames[gameSlug];

  if (!gameDisplayName) {
    req.flash('error', 'গেমটি পাওয়া যায়নি');
    return res.redirect('/');
  }

  try {
    const userResult = await pool.query('SELECT coins FROM users WHERE id = $1', [req.session.user.id]);
    const coins = userResult.rows[0].coins;

    res.render('games/play', {
      gameSlug,
      gameDisplayName,
      coins,
      user: req.session.user
    });
  } catch (err) {
    console.error('Error loading game:', err);
    req.flash('error', 'গেমটি লোড করতে সমস্যা হয়েছে');
    res.redirect('/');
  }
});

// Handle betting (Withdraw coins from wallet)
// For Aviator, we also generate the crash point here and store it in session
router.post('/bet', isAuth, async (req, res) => {
  const { gameSlug, amount } = req.body;
  const userId = req.session.user.id;
  const betAmount = parseInt(amount);

  if (isNaN(betAmount) || betAmount <= 0) {
    return res.status(400).json({ success: false, message: 'সঠিক পরিমাণ প্রদান করুন' });
  }

  try {
    const userResult = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    if (userResult.rows[0].coins < betAmount) {
      return res.status(400).json({ success: false, message: 'পর্যাপ্ত ব্যালেন্স নেই' });
    }

    // Deduct coins
    await pool.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [betAmount, userId]);
    await pool.query(
      'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
      [userId, -betAmount, 'game_bet', `${supportedGames[gameSlug] || gameSlug} গেমে বাজি ধরা হয়েছে`]
    );

    req.session.user.coins -= betAmount;

    // Game-specific logic
    if (gameSlug === 'aviator') {
        // Generate crash point server-side: 1.0 to 10.0 (logarithmic or weighted would be better for house edge)
        // Here we just use a simplified version
        const crashPoint = (1 + Math.random() * 9).toFixed(2);
        req.session.gameState = {
            game: 'aviator',
            betAmount: betAmount,
            crashPoint: parseFloat(crashPoint),
            startTime: Date.now()
        };
        console.log(`[Aviator] User ${userId} bet ${betAmount}, Crash at ${crashPoint}`);
    } else {
        // Placeholder for other games
        req.session.gameState = {
            game: gameSlug,
            betAmount: betAmount
        };
    }

    res.json({ success: true, newBalance: req.session.user.coins });
  } catch (err) {
    console.error('Bet error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  }
});

// Secure Cash Out (replaces /win for Aviator)
router.post('/cashout', isAuth, async (req, res) => {
  const { gameSlug, multiplier } = req.body;
  const userId = req.session.user.id;
  const clientMultiplier = parseFloat(multiplier);

  const gameState = req.session.gameState;

  if (!gameState || gameState.game !== gameSlug) {
    return res.status(400).json({ success: false, message: 'সক্রিয় কোনো গেম পাওয়া যায়নি' });
  }

  if (gameSlug === 'aviator') {
    // 1. Verify if client multiplier is valid (hasn't exceeded crash point)
    if (clientMultiplier >= gameState.crashPoint) {
        delete req.session.gameState;
        return res.status(400).json({ success: false, message: 'দুঃখিত, বিমানটি ইতিমধ্যে চলে গেছে!' });
    }

    // 2. Verify time elapsed matches multiplier (roughly)
    // Multiplier starts at 1.0 and increases by 0.1 every 1s (simplified)
    // Client logic: multiplier += 0.01 every 100ms
    const elapsedTime = (Date.now() - gameState.startTime) / 1000;
    const expectedMaxMultiplier = 1.0 + elapsedTime * 0.11; // allowing some buffer

    if (clientMultiplier > expectedMaxMultiplier) {
        delete req.session.gameState;
        return res.status(400).json({ success: false, message: 'অবৈধ অনুরোধ' });
    }

    const winAmount = Math.floor(gameState.betAmount * clientMultiplier);

    try {
        await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [winAmount, userId]);
        await pool.query(
          'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
          [userId, winAmount, 'game_win', `Aviator গেম থেকে জয়ী (x${clientMultiplier.toFixed(2)})`]
        );

        req.session.user.coins += winAmount;
        delete req.session.gameState;
        res.json({ success: true, newBalance: req.session.user.coins, winAmount });
    } catch (err) {
        console.error('Cashout error:', err);
        res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
    }
  } else {
    res.status(400).json({ success: false, message: 'এই গেমটির জন্য ক্যাশ আউট সমর্থিত নয়' });
  }
});

module.exports = router;
