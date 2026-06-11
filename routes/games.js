const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

const supportedGames = {
  "aviator": { name: "Aviator", type: "crash" },
  "slots": { name: "Slots", type: "slot" },
  "roulette": { name: "Roulette", type: "table" },
  "andar-bahar": { name: "Andar Bahar", type: "card" },
  "teen-patti": { name: "Teen Patti", type: "card" },
  "blackjack": { name: "Blackjack", type: "table" },
  "poker": { name: "Poker", type: "table" },
  "baccarat": { name: "Baccarat", type: "table" },
  "crash-game": { name: "Crash Game", type: "crash" },
  "starburst": { name: "Starburst", type: "slot" },
  "book-of-dead": { name: "Book of Dead", type: "slot" },
  "gonzos-quest": { name: "Gonzo's Quest", type: "slot" },
  "mega-moolah": { name: "Mega Moolah", type: "slot" },
  "gates-of-olympus": { name: "Gates of Olympus", type: "slot" },
  "sweet-bonanza": { name: "Sweet Bonanza", type: "slot" },
  "legacy-of-dead": { name: "Legacy of Dead", type: "slot" },
  "crazy-time": { name: "Crazy Time", type: "live" },
  "lightning-roulette": { name: "Lightning Roulette", type: "live" },
  "monopoly-live": { name: "Monopoly Live", type: "live" },
  "mega-ball": { name: "Mega Ball", type: "live" },
  "dream-catcher": { name: "Dream Catcher", type: "live" },
  "super-sic-bo": { name: "Super Sic Bo", type: "live" },
  "fan-tan": { name: "Fan Tan", type: "live" },
  "bac-bo": { name: "Bac Bo", type: "live" },
  "rummy": { name: "Rummy", type: "card" },
  "call-break": { name: "Call Break", type: "card" },
  "dragon-tiger": { name: "Dragon Tiger", type: "card" },
  "jetx": { name: "JetX", type: "crash" },
  "plinko": { name: "Plinko", type: "arcade" },
  "keno": { name: "Keno", type: "lottery" },
  "bingo": { name: "Bingo", type: "lottery" },
  "5d-lottery": { name: "5D Lottery", type: "lottery" },
  "win-go": { name: "Win Go", type: "lottery" },
  "coin-flip": { name: "Coin Flip", type: "arcade" },
  "dice": { name: "Dice", type: "arcade" },
  "fortune-gems": { name: "Fortune Gems", type: "slot" },
  "golden-empire": { name: "Golden Empire", type: "slot" },
  "sugar-rush": { name: "Sugar Rush", type: "slot" },
  "k3-lottery": { name: "K3 Lottery", type: "lottery" },
  "spaceman": { name: "Spaceman", type: "crash" },
  "sic-bo": { name: "Sic Bo", type: "table" },
  "fish-prawn-crab": { name: "Fish Prawn Crab", type: "lottery" },
  "fruit-slot": { name: "Fruit Slot", type: "slot" },
  "diamond-slot": { name: "Diamond Slot", type: "slot" },
  "7up-7down": { name: "7up 7down", type: "card" },
  "triple-card": { name: "Triple Card", type: "card" },
  "jhandi-munda": { name: "Jhandi Munda", type: "card" },
  "cricket-war": { name: "Cricket War", type: "card" },
  "football-war": { name: "Football War", type: "card" },
  "minesweeper-pro": { name: "Minesweeper Pro", type: "arcade" },
  "tower-game": { name: "Tower Game", type: "arcade" },
  "limbo": { name: "Limbo", type: "arcade" },
  "wheel-pro": { name: "Wheel Pro", type: "arcade" },
  "panda-slot": { name: "Panda Slot", type: "slot" },
  "tiger-slot": { name: "Tiger Slot", type: "slot" },
  "dragon-slot": { name: "Dragon Slot", type: "slot" },
  "phoenix-slot": { name: "Phoenix Slot", type: "slot" },
  "lion-slot": { name: "Lion Slot", type: "slot" },
  "coin-master": { name: "Coin Master", type: "slot" },
  "gold-rush": { name: "Gold Rush", type: "slot" },
  "treasure-hunt": { name: "Treasure Hunt", type: "slot" },
  "pirate-gold": { name: "Pirate Gold", type: "slot" },
  "ninja-game": { name: "Ninja Game", type: "slot" },
  "samurai-slot": { name: "Samurai Slot", type: "slot" },
  "mahjong-ways": { name: "Mahjong Ways", type: "slot" },
  "thai-paradise": { name: "Thai Paradise", type: "slot" },
  "monkey-king": { name: "Monkey King", type: "slot" },
  "wild-west": { name: "Wild West", type: "slot" },
  "space-wars": { name: "Space Wars", type: "slot" },
  "ocean-king": { name: "Ocean King", type: "slot" },
  "fire-dice": { name: "Fire Dice", type: "arcade" },
  "ice-slot": { name: "Ice Slot", type: "slot" },
  "storm-slot": { name: "Storm Slot", type: "slot" },
  "royal-flush": { name: "Royal Flush", type: "table" },
  "lucky-7": { name: "Lucky 7", type: "card" },
  "magic-ball": { name: "Magic Ball", type: "lottery" },
  "neon-slots": { name: "Neon Slots", type: "slot" },
  "cash-burst": { name: "Cash Burst", type: "slot" },
  "live-blackjack": { name: "Live Blackjack", type: "live" },
  "live-roulette": { name: "Live Roulette", type: "live" },
  "live-baccarat": { name: "Live Baccarat", type: "live" },
  "live-poker": { name: "Live Poker", type: "live" },
  "mines": { name: "Mines", type: "arcade" },
  "football-studio": { name: "Football Studio", type: "live" },
  "cash-or-crash": { name: "Cash or Crash", type: "live" },
  "extra-chill": { name: "Extra Chill", type: "slot" },
  "fire-in-the-hole": { name: "Fire in the Hole", type: "slot" },
  "wanted-dead-or-a-wild": { name: "Wanted Dead or Wild", type: "slot" },
  "mental": { name: "Mental", type: "slot" },
  "razor-shark": { name: "Razor Shark", type: "slot" },
  "jammin-jars": { name: "Jammin Jars", type: "slot" },
  "san-quentin": { name: "San Quentin", type: "slot" },
  "aviator-pro": { name: "Aviator Pro", type: "crash" },
  "jetx-pro": { name: "JetX Pro", type: "crash" },
  "spaceman-pro": { name: "Spaceman Pro", type: "crash" },
  "aviatrix": { name: "Aviatrix", type: "crash" },
  "balloon": { name: "Balloon", type: "crash" },
  "minesweeper": { name: "Minesweeper", type: "arcade" },
  "football-x": { name: "Football X", type: "crash" },
  "ludo": { name: "Online Ludo", type: "card" },
  "color-prediction": { name: "Color Prediction", type: "lottery" },
  "mine": { name: "Mine Game", type: "arcade" },
  "hilo": { name: "Hi-Lo", type: "card" },
  "card-war": { name: "Card War", type: "card" },
  "lucky-spin": { name: "Lucky Spin", type: "arcade" },
  "number-guess": { name: "Number Guess", type: "arcade" }
};

const gameHandlers = {
  slot: (betAmount) => {
    const symbols = ["🍒", "🍋", "🍊", "🍇", "🔔", "💎", "7️⃣", "⭐", "🌟", "👑"];
    const r = [symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)], symbols[Math.floor(Math.random() * symbols.length)]];
    let multiplier = 0;
    const winChance = Math.random();
    if (r[0] === r[1] && r[1] === r[2]) multiplier = 15;
    else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) multiplier = 2;
    else if (winChance < 0.1) multiplier = 1.5;
    return { winAmount: Math.floor(betAmount * multiplier), gameResult: { results: r } };
  },
  table: (betAmount, selection) => {
    const winChance = Math.random();
    let winAmount = 0;
    if (winChance < 0.48) winAmount = betAmount * 2;
    return { winAmount, gameResult: { winChance } };
  },
  card: (betAmount, selection) => {
    const winChance = Math.random();
    let winAmount = 0;
    if (winChance < 0.49) winAmount = Math.floor(betAmount * 1.95);
    return { winAmount, gameResult: { winChance } };
  },
  lottery: (betAmount) => {
    const winChance = Math.random();
    let winAmount = 0;
    if (winChance < 0.1) winAmount = betAmount * 9;
    else if (winChance < 0.3) winAmount = betAmount * 2;
    return { winAmount, gameResult: { winChance } };
  },
  arcade: (betAmount) => {
    const winChance = Math.random();
    let winAmount = 0;
    if (winChance < 0.45) winAmount = betAmount * 2;
    return { winAmount, gameResult: { winChance } };
  },
  live: (betAmount) => {
    const winChance = Math.random();
    let winAmount = 0;
    if (winChance < 0.40) winAmount = betAmount * 2.5;
    return { winAmount, gameResult: { winChance } };
  }
};

// Specialized overrides
const specialHandlers = {
  roulette: (betAmount, selection) => {
    const number = Math.floor(Math.random() * 37);
    const isRed = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(number);
    let winAmount = 0;
    if ((selection === 'Red' && isRed) || (selection === 'Black' && number !== 0 && !isRed)) winAmount = betAmount * 2;
    else if (selection === number.toString()) winAmount = betAmount * 35;
    return { winAmount, gameResult: { number, color: number === 0 ? 'Green' : (isRed ? 'Red' : 'Black') } };
  },
  'andar-bahar': (betAmount, selection) => {
    const isAndar = Math.random() < 0.5;
    const winAmount = (isAndar && selection === 'Andar') || (!isAndar && selection === 'Bahar') ? Math.floor(betAmount * 1.9) : 0;
    return { winAmount, gameResult: { side: isAndar ? 'Andar' : 'Bahar' } };
  },
  baccarat: (betAmount, selection) => {
    const resultOptions = ['Player', 'Banker', 'Tie'];
    const outcome = resultOptions[Math.floor(Math.random() * resultOptions.length)];
    let winAmount = 0;
    if (outcome === selection) {
      if (outcome === 'Tie') winAmount = betAmount * 8;
      else winAmount = Math.floor(betAmount * 1.95);
    }
    return { winAmount, gameResult: { outcome } };
  }
};

router.get('/play', isAuth, (req, res) => {
  const gameSlug = req.query.game || 'slots';
  const gameInfo = supportedGames[gameSlug];
  if (!gameInfo) {
    req.flash('error', 'গেমটি পাওয়া যায়নি');
    return res.redirect('/');
  }
  res.render('games/play', {
    gameSlug: gameSlug,
    gameDisplayName: gameInfo.name,
    coins: req.session.user.coins
  });
});

router.post('/play', isAuth, async (req, res) => {
  const { gameSlug, amount, selection } = req.body;
  const userId = req.session.user.id;
  const betAmount = parseInt(amount);

  const gameInfo = supportedGames[gameSlug];
  if (!gameInfo) return res.status(404).json({ success: false, message: 'গেমটি পাওয়া যায়নি' });

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

    if (gameInfo.type === 'crash') {
      const crashPoint = (1 + Math.random() * 9).toFixed(2);
      req.session.gameState = { game: gameSlug, betAmount, crashPoint: parseFloat(crashPoint), startTime: Date.now() };
      await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [betAmount, userId]);
      await client.query('COMMIT');
      req.session.user.coins -= betAmount;
      return res.json({ success: true, message: 'গেম শুরু হয়েছে', newBalance: req.session.user.coins });
    }

    if (specialHandlers[gameSlug]) {
      const result = specialHandlers[gameSlug](betAmount, selection);
      winAmount = result.winAmount;
      gameResult = result.gameResult;
    } else if (gameHandlers[gameInfo.type]) {
      const result = gameHandlers[gameInfo.type](betAmount, selection);
      winAmount = result.winAmount;
      gameResult = result.gameResult;
    } else {
      winAmount = Math.random() < 0.45 ? betAmount * 2 : 0;
    }

    const netChange = winAmount - betAmount;
    await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [netChange, userId]);
    await client.query('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)', 
                       [userId, netChange, 'game_play', `${gameInfo.name} গেম`]);
    await client.query('COMMIT');
    req.session.user.coins += netChange;
    res.json({ success: true, newBalance: req.session.user.coins, winAmount, gameResult });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Play error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

router.post('/cashout', isAuth, async (req, res) => {
    const { multiplier } = req.body;
    const userId = req.session.user.id;
    const gameState = req.session.gameState;

    if (!gameState || !gameState.crashPoint) {
        return res.status(400).json({ success: false, message: 'কোন সক্রিয় গেম নেই' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query('SELECT coins FROM users WHERE id = $1 FOR UPDATE', [userId]);

        let winAmount = 0;
        const requestedMultiplier = parseFloat(multiplier);

        if (requestedMultiplier <= gameState.crashPoint) {
            winAmount = Math.floor(gameState.betAmount * requestedMultiplier);
        } else {
            winAmount = 0; // Crashed
        }

        await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [winAmount, userId]);
        await client.query('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                           [userId, winAmount, 'game_win', `${gameState.game} ক্যাশআউট`]);
        await client.query('COMMIT');

        req.session.user.coins += winAmount;
        const finalMultiplier = gameState.crashPoint;
        req.session.gameState = null;

        res.json({ success: true, newBalance: req.session.user.coins, winAmount, crashPoint: finalMultiplier });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
    } finally {
        client.release();
    }
});

module.exports = router;
