const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

const supportedGames = {
  'aviator': 'Aviator', 'slots': 'Slots', 'roulette': 'Roulette',
  'andar-bahar': 'Andar Bahar', 'teen-patti': 'Teen Patti', 'blackjack': 'Blackjack',
  'poker': 'Poker', 'baccarat': 'Baccarat', 'crash': 'Crash Game'
};

const gameHandlers = {
  slots: (betAmount) => {
    const symbols = ["🍒", "🍋", "🍊", "🍇", "🔔", "💎", "7️⃣", "⭐", "🌟", "👑"];
    const r = [symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)]];
    let multiplier = 0;
    if (r[0] === r[1] && r[1] === r[2]) multiplier = 10;
    else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) multiplier = 2;
    return { winAmount: betAmount * multiplier, gameResult: { results: r } };
  },
  roulette: (betAmount, selection) => {
    const number = Math.floor(Math.random() * 37);
    const isRed = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(number);
    let winAmount = 0;
    if ((selection === 'Red' && isRed) || (selection === 'Black' && number !== 0 && !isRed)) winAmount = betAmount * 2;
    return { winAmount, gameResult: { number, color: number === 0 ? 'Green' : (isRed ? 'Red' : 'Black') } };
  },
  'andar-bahar': (betAmount, selection) => {
    const isAndar = Math.random() < 0.5;
    const winAmount = (isAndar && selection === 'Andar') || (!isAndar && selection === 'Bahar') ? betAmount * 1.9 : 0;
    return { winAmount, gameResult: { side: isAndar ? 'Andar' : 'Bahar' } };
  },
  'teen-patti': (betAmount) => {
    const winAmount = Math.random() < 0.40 ? betAmount * 1.95 : 0;
    return { winAmount, gameResult: {} };
  },
  blackjack: (betAmount) => {
    const winAmount = Math.random() < 0.42 ? betAmount * 2 : 0;
    return { winAmount, gameResult: {} };
  },
  poker: (betAmount) => {
    const winAmount = Math.random() < 0.35 ? betAmount * 2.5 : 0;
    return { winAmount, gameResult: {} };
  },
  baccarat: (betAmount, selection) => {
    const resultOptions = ['Player', 'Banker', 'Tie'];
    const outcome = resultOptions[Math.floor(Math.random() * resultOptions.length)];
    let winAmount = 0;
    if (outcome === selection) {
      if (outcome === 'Tie') winAmount = betAmount * 8;
      else winAmount = betAmount * 1.95;
    }
    return { winAmount, gameResult: { outcome } };
  }
};

router.post('/play', isAuth, async (req, res) => {
  const { gameSlug, amount, selection } = req.body;
  const userId = req.session.user.id;
  const betAmount = parseInt(amount);

  if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ success: false, message: 'সঠিক পরিমাণ দিন' });

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

    if (['aviator', 'crash'].includes(gameSlug)) {
      const crashPoint = (1 + Math.random() * 9).toFixed(2);
      req.session.gameState = { game: gameSlug, betAmount, crashPoint: parseFloat(crashPoint), startTime: Date.now() };
      await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [betAmount, userId]);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'গেম শুরু হয়েছে' });
    }

    if (gameHandlers[gameSlug]) {
      const result = gameHandlers[gameSlug](betAmount, selection);
      winAmount = result.winAmount;
      gameResult = result.gameResult;
    } else {
      winAmount = Math.random() < 0.45 ? betAmount * 2 : 0;
    }

    const netChange = winAmount - betAmount;
    await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [netChange, userId]);
    await client.query('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)', 
                       [userId, netChange, 'game_play', `${supportedGames[gameSlug] || gameSlug} গেম`]);
    await client.query('COMMIT');
    req.session.user.coins += netChange;
    res.json({ success: true, newBalance: req.session.user.coins, winAmount, gameResult });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

module.exports = router;
