const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { addTurnover } = require('../services/turnover');
const { distributeCommission } = require('../services/referral');
const { addBet, addWin } = require('../services/cashback');
const { addVipTurnover } = require('../services/vip');

const supportedGames = {
  "aviator": "Aviator",
  "slots": "Slots",
  "roulette": "Roulette",
  "andar-bahar": "Andar Bahar",
  "teen-patti": "Teen Patti",
  "blackjack": "Blackjack",
  "poker": "Poker",
  "baccarat": "Baccarat",
  "crash-game": "Crash Game",
  "starburst": "Starburst",
  "book-of-dead": "Book of Dead",
  "gonzos-quest": "Gonzo's Quest",
  "mega-moolah": "Mega Moolah",
  "gates-of-olympus": "Gates of Olympus",
  "sweet-bonanza": "Sweet Bonanza",
  "legacy-of-dead": "Legacy of Dead",
  "crazy-time": "Crazy Time",
  "lightning-roulette": "Lightning Roulette",
  "monopoly-live": "Monopoly Live",
  "mega-ball": "Mega Ball",
  "dream-catcher": "Dream Catcher",
  "super-sic-bo": "Super Sic Bo",
  "fan-tan": "Fan Tan",
  "bac-bo": "Bac Bo",
  "rummy": "Rummy",
  "call-break": "Call Break",
  "dragon-tiger": "Dragon Tiger",
  "jetx": "JetX",
  "plinko": "Plinko",
  "keno": "Keno",
  "bingo": "Bingo",
  "5d-lottery": "5D Lottery",
  "win-go": "Win Go",
  "coin-flip": "Coin Flip",
  "dice": "Dice",
  "fortune-gems": "Fortune Gems",
  "golden-empire": "Golden Empire",
  "sugar-rush": "Sugar Rush",
  "k3-lottery": "K3 Lottery",
  "spaceman": "Spaceman",
  "sic-bo": "Sic Bo",
  "fish-prawn-crab": "Fish Prawn Crab",
  "fruit-slot": "Fruit Slot",
  "diamond-slot": "Diamond Slot",
  "7up-7down": "7up 7down",
  "triple-card": "Triple Card",
  "jhandi-munda": "Jhandi Munda",
  "cricket-war": "Cricket War",
  "football-war": "Football War",
  "minesweeper-pro": "Minesweeper Pro",
  "tower-game": "Tower Game",
  "limbo": "Limbo",
  "wheel-pro": "Wheel Pro",
  "panda-slot": "Panda Slot",
  "tiger-slot": "Tiger Slot",
  "dragon-slot": "Dragon Slot",
  "phoenix-slot": "Phoenix Slot",
  "lion-slot": "Lion Slot",
  "coin-master": "Coin Master",
  "gold-rush": "Gold Rush",
  "treasure-hunt": "Treasure Hunt",
  "pirate-gold": "Pirate Gold",
  "ninja-game": "Ninja Game",
  "samurai-slot": "Samurai Slot",
  "mahjong-ways": "Mahjong Ways",
  "thai-paradise": "Thai Paradise",
  "monkey-king": "Monkey King",
  "wild-west": "Wild West",
  "space-wars": "Space Wars",
  "ocean-king": "Ocean King",
  "fire-dice": "Fire Dice",
  "ice-slot": "Ice Slot",
  "storm-slot": "Storm Slot",
  "royal-flush": "Royal Flush",
  "lucky-7": "Lucky 7",
  "magic-ball": "Magic Ball",
  "neon-slots": "Neon Slots",
  "cash-burst": "Cash Burst",
  "live-blackjack": "Live Blackjack",
  "live-roulette": "Live Roulette",
  "live-baccarat": "Live Baccarat",
  "live-poker": "Live Poker",
  "mines": "Mines",
  "football-studio": "Football Studio",
  "cash-or-crash": "Cash or Crash",
  "extra-chill": "Extra Chill",
  "fire-in-the-hole": "Fire in the Hole",
  "wanted-dead-or-a-wild": "Wanted Dead or Wild",
  "mental": "Mental",
  "razor-shark": "Razor Shark",
  "jammin-jars": "Jammin Jars",
  "san-quentin": "San Quentin",
  "aviator-pro": "Aviator Pro",
  "jetx-pro": "JetX Pro",
  "spaceman-pro": "Spaceman Pro",
  "aviatrix": "Aviatrix",
  "balloon": "Balloon",
  "minesweeper": "Minesweeper",
  "football-x": "Football X",
  "ludo": "Online Ludo",
  "color-prediction": "Color Prediction",
  "mine": "Mine Game",
  "hilo": "Hi-Lo",
  "card-war": "Card War",
  "lucky-spin": "Lucky Spin",
  "number-guess": "Number Guess",
  "age-of-the-gods": "Age of the Gods",
  "buffalo-blitz": "Buffalo Blitz",
  "immortal-romance": "Immortal Romance",
  "thunderstruck-2": "Thunderstruck II",
  "sugar-pop": "Sugar Pop",
  "slotfather": "The Slotfather",
  "valley-of-the-gods": "Valley of the Gods",
  "vikings-go-berzerk": "Vikings Go Berzerk",
  "gonzos-quest-megaways": "Gonzo's Quest Megaways",
  "piggy-riches-megaways": "Piggy Riches Megaways",
  "big-bad-wolf": "Big Bad Wolf",
  "sakura-fortune": "Sakura Fortune"
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

router.get('/play', isAuth, (req, res) => {
  const gameSlug = req.query.game || 'slots';
  if (!supportedGames[gameSlug]) {
    req.flash('error', 'গেমটি পাওয়া যায়নি');
    return res.redirect('/');
  }
  res.render('games/play', {
    gameSlug: gameSlug,
    gameDisplayName: supportedGames[gameSlug],
    coins: req.session.user.coins
  });
});

router.get('/:slug', isAuth, (req, res) => {
  const gameSlug = req.params.slug;
  if (!supportedGames[gameSlug]) {
    req.flash('error', 'গেমটি পাওয়া যায়নি');
    return res.redirect('/');
  }
  res.render('games/play', {
    gameSlug: gameSlug,
    gameDisplayName: supportedGames[gameSlug],
    coins: req.session.user.coins
  });
});

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
      return res.status(400).json({ success: false, message: 'পরপ্ত ব্যালেন্স নেই' });
    }

    let winAmount = 0;
    let gameResult = {};

    if (['aviator', 'crash-game'].includes(gameSlug)) {
      const crashPoint = (1 + Math.random() * 9).toFixed(2);
      req.session.gameState = { game: gameSlug, betAmount, crashPoint: parseFloat(crashPoint), startTime: Date.now() };
      await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [betAmount, userId]);
      await client.query('COMMIT');

      addTurnover(userId, 'casino', betAmount).catch(e => console.error('turnover:', e.message));
      distributeCommission(userId, betAmount).catch(e => console.error('commission:', e.message));
      addBet(userId, betAmount).catch(e => console.error('cashback:', e.message));
      addVipTurnover(userId, betAmount).catch(e => console.error('vip:', e.message));

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

    addTurnover(userId, 'casino', betAmount).catch(e => console.error('turnover:', e.message));
    distributeCommission(userId, betAmount).catch(e => console.error('commission:', e.message));
    addBet(userId, betAmount).catch(e => console.error('cashback:', e.message));
    addVipTurnover(userId, betAmount).catch(e => console.error('vip:', e.message));
    if (winAmount > 0) addWin(userId, winAmount).catch(e => console.error('cashback:', e.message));

    res.json({ success: true, newBalance: req.session.user.coins, winAmount, gameResult });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

router.post('/cashout', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { gameSlug, multiplier } = req.body;

  const state = req.session.gameState;

  if (!state || state.game !== gameSlug) {
    return res.status(400).json({ success: false, message: 'কোনো চলমান গেম নেই' });
  }

  const cashMultiplier = parseFloat(multiplier);
  if (isNaN(cashMultiplier) || cashMultiplier < 1) {
    return res.status(400).json({ success: false, message: 'অকার্যকর মালপ্লায়ার' });
  }

  req.session.gameState = null;

  if (cashMultiplier > state.crashPoint) {
    return res.json({
      success: true,
      crashed: true,
      winAmount: 0,
      newBalance: req.session.user.coins,
      message: `উড়োজাহাজ ${state.crashPoint}x-এ ক্রশ করেছে!`
    });
  }

  const winAmount = Math.floor(state.betAmount * cashMultiplier);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      'UPDATE users SET coins = coins + $1 WHERE id = $2 RETURNING coins',
      [winAmount, userId]
    );
    await client.query(
      'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
      [userId, winAmount, 'game_win', `${supportedGames[gameSlug] || gameSlug} ক্যাশআউট ${cashMultiplier}x`]
    );
    await client.query('COMMIT');

    req.session.user.coins = upd.rows[0].coins;

    if (winAmount > 0) addWin(userId, winAmount).catch(e => console.error('cashback:', e.message));

    res.json({
      success: true,
      crashed: false,
      winAmount,
      multiplier: cashMultiplier,
      newBalance: req.session.user.coins
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('cashout error:', err.message);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

module.exports = router;
