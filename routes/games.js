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

// Check game status (for Aviator crash) - MUST BE BEFORE /:gameSlug
router.get('/status', isAuth, (req, res) => {
  const gameState = req.session.gameState;
  if (!gameState) return res.json({ active: false });

  if (gameState.game === 'aviator') {
    const elapsedTime = (Date.now() - gameState.startTime) / 1000;
    const currentMultiplier = 1.0 + elapsedTime * 0.1;

    if (currentMultiplier >= gameState.crashPoint) {
      delete req.session.gameState;
      return res.json({ active: false, crashed: true, crashPoint: gameState.crashPoint });
    }
    return res.json({ active: true, multiplier: currentMultiplier });
  }

  res.json({ active: true });
});

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

// Secure game logic
router.post('/play', isAuth, async (req, res) => {
  const { gameSlug, amount, selection } = req.body;
  const userId = req.session.user.id;
  const betAmount = parseInt(amount);

  if (isNaN(betAmount) || betAmount <= 0) {
    return res.status(400).json({ success: false, message: 'সঠিক পরিমাণ প্রদান করুন' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query('SELECT coins FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (userResult.rows[0].coins < betAmount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'পর্যাপ্ত ব্যালেন্স নেই' });
    }

    let winAmount = 0;
    let gameResult = {};

    if (gameSlug === 'slots') {
        const symbols = ["🍒", "🍋", "🍊", "🍇", "🔔", "💎", "7️⃣"];
        const results = [
            symbols[Math.floor(Math.random() * symbols.length)],
            symbols[Math.floor(Math.random() * symbols.length)],
            symbols[Math.floor(Math.random() * symbols.length)]
        ];

        let multiplier = 0;
        if (results[0] === results[1] && results[1] === results[2]) {
            multiplier = 10;
        } else if (results[0] === results[1] || results[1] === results[2] || results[0] === results[2]) {
            multiplier = 2;
        }

        winAmount = betAmount * multiplier;
        gameResult = { results, multiplier };

    } else if (gameSlug === 'roulette') {
        const number = Math.floor(Math.random() * 37); // 0-36
        const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
        const isRed = redNumbers.includes(number);
        const isEven = number !== 0 && number % 2 === 0;
        const isOdd = number !== 0 && number % 2 !== 0;

        let won = false;
        if (selection === 'Red' && isRed) won = true;
        if (selection === 'Black' && number !== 0 && !isRed) won = true;
        if (selection === 'Even' && isEven) won = true;
        if (selection === 'Odd' && isOdd) won = true;

        if (won) winAmount = betAmount * 2;
        gameResult = {
            number,
            color: number === 0 ? 'Green' : (isRed ? 'Red' : 'Black'),
            even: isEven,
            odd: isOdd,
            result: number === 0 ? '0' : (isRed ? 'Red' : 'Black')
        };

    } else if (gameSlug === 'andar-bahar') {
        const winSide = Math.random() < 0.5 ? 'Andar' : 'Bahar';
        if (selection === winSide) {
            winAmount = betAmount * 1.9; // Standard payout roughly
        }
        gameResult = { winSide };
    } else if (gameSlug === 'teen-patti' || gameSlug === 'blackjack' || gameSlug === 'poker' || gameSlug === 'baccarat') {
        // Simple "Higher card" logic for demo completeness
        const playerCard = Math.floor(Math.random() * 13) + 2;
        const dealerCard = Math.floor(Math.random() * 13) + 2;
        if (playerCard > dealerCard) {
            winAmount = betAmount * 2;
        }
        gameResult = { playerCard, dealerCard };
    } else if (gameSlug === 'ludo') {
        const playerRoll = Math.floor(Math.random() * 6) + 1;
        const dealerRoll = Math.floor(Math.random() * 6) + 1;
        if (playerRoll > dealerRoll) {
            winAmount = betAmount * 2;
        }
        gameResult = { playerRoll, dealerRoll };
    } else if (gameSlug === 'aviator') {
        const crashPoint = (1 + Math.random() * 9).toFixed(2);
        req.session.gameState = {
            game: 'aviator',
            betAmount: betAmount,
            crashPoint: parseFloat(crashPoint),
            startTime: Date.now()
        };

        await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [betAmount, userId]);
        await client.query(
            'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
            [userId, -betAmount, 'game_bet', `Aviator গেমে বাজি ধরা হয়েছে`]
        );
        await client.query('COMMIT');
        req.session.user.coins -= betAmount;
        return res.json({ success: true, newBalance: req.session.user.coins });
    } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'এই গেমটি এখনও সক্রিয় নয়' });
    }

    // Update wallet for instant result games
    const netChange = winAmount - betAmount;
    await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [netChange, userId]);
    await client.query(
        'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
        [userId, netChange, 'game_play', `${supportedGames[gameSlug]} গেম খেলা হয়েছে`]
    );

    await client.query('COMMIT');
    req.session.user.coins += netChange;
    res.json({ success: true, newBalance: req.session.user.coins, winAmount, gameResult });

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Play error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    if (client) client.release();
  }
});

// Secure Cash Out (for Aviator)
router.post('/cashout', isAuth, async (req, res) => {
  const { gameSlug, multiplier } = req.body;
  const userId = req.session.user.id;
  const clientMultiplier = parseFloat(multiplier);

  const gameState = req.session.gameState;

  if (!gameState || gameState.game !== 'aviator' || gameSlug !== 'aviator') {
    return res.status(400).json({ success: false, message: 'সক্রিয় কোনো গেম পাওয়া যায়নি' });
  }

  // Verify if client multiplier is valid
  if (clientMultiplier >= gameState.crashPoint) {
    delete req.session.gameState;
    return res.status(400).json({ success: false, message: 'দুঃখিত, বিমানটি ইতিমধ্যে চলে গেছে!' });
  }

  // Time-based sanity check
  const elapsedTime = (Date.now() - gameState.startTime) / 1000;
  const expectedMaxMultiplier = 1.0 + elapsedTime * 0.12;
  if (clientMultiplier > expectedMaxMultiplier) {
    delete req.session.gameState;
    return res.status(400).json({ success: false, message: 'অবৈধ অনুরোধ' });
  }

  const winAmount = Math.floor(gameState.betAmount * clientMultiplier);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [winAmount, userId]);
    await client.query(
      'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
      [userId, winAmount, 'game_win', `Aviator গেম থেকে জয়ী (x${clientMultiplier.toFixed(2)})`]
    );

    await client.query('COMMIT');
    req.session.user.coins += winAmount;
    delete req.session.gameState;
    res.json({ success: true, newBalance: req.session.user.coins, winAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cashout error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

module.exports = router;
