const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

const supportedGames = {
  'aviator':'Aviator','slots':'Slots','roulette':'Roulette',
  'andar-bahar':'Andar Bahar','teen-patti':'Teen Patti','blackjack':'Blackjack',
  'poker':'Poker','baccarat':'Baccarat','ludo':'Online Ludo',
  'color-prediction':'Color Prediction','lucky-spin':'Lucky Spin',
  'mine':'Mine Game','coin-flip':'Coin Flip','dragon-tiger':'Dragon Tiger',
  'number-guess':'Number Guess','hilo':'Hi-Lo','dice':'Dice Roll',
  'card-war':'Card War','crash':'Crash Game','wheel':'Wheel of Fortune',
  'fortune-gems':'Fortune Gems','golden-empire':'Golden Empire',
  'sweet-bonanza':'Sweet Bonanza','sugar-rush':'Sugar Rush',
  'win-go':'Win Go','k3-lottery':'K3 Lottery','5d-lottery':'5D Lottery',
  'plinko':'Plinko','jetx':'JetX','spaceman':'Spaceman','keno':'Keno',
  'bingo':'Bingo','sic-bo':'Sic Bo','fish-prawn-crab':'Fish Prawn Crab',
  'fruit-slot':'Fruit Slot','diamond-slot':'Diamond Slot',
  '7up-7down':'7 Up 7 Down','triple-card':'Triple Card',
  'jhandi-munda':'Jhandi Munda','cricket-war':'Cricket War',
  'football-war':'Football War','minesweeper-pro':'Minesweeper Pro',
  'tower-game':'Tower Game','limbo':'Limbo','wheel-pro':'Wheel Pro',
  'panda-slot':'Panda Slot','tiger-slot':'Tiger Slot','dragon-slot':'Dragon Slot',
  'phoenix-slot':'Phoenix Slot','lion-slot':'Lion Slot','coin-master':'Coin Master',
  'gold-rush':'Gold Rush','treasure-hunt':'Treasure Hunt','pirate-gold':'Pirate Gold',
  'ninja-game':'Ninja Game','samurai-slot':'Samurai Slot','mahjong-ways':'Mahjong Ways',
  'thai-paradise':'Thai Paradise','monkey-king':'Monkey King','wild-west':'Wild West',
  'space-wars':'Space Wars','ocean-king':'Ocean King','fire-dice':'Fire Dice',
  'ice-slot':'Ice Slot','storm-slot':'Storm Slot','royal-flush':'Royal Flush',
  'lucky-7':'Lucky 7','magic-ball':'Magic Ball','neon-slots':'Neon Slots',
  'cash-burst':'Cash Burst'
};

router.get('/status', isAuth, (req, res) => {
  const gameState = req.session.gameState;
  if (!gameState) return res.json({ active: false });
  const elapsedTime = (Date.now() - gameState.startTime) / 1000;
  const currentMultiplier = 1.0 + elapsedTime * 0.1;
  if (currentMultiplier >= gameState.crashPoint) {
    delete req.session.gameState;
    return res.json({ active: false, crashed: true, crashPoint: gameState.crashPoint });
  }
  return res.json({ active: true, multiplier: currentMultiplier });
});

router.get('/:gameSlug', isAuth, async (req, res) => {
  const { gameSlug } = req.params;
  const gameDisplayName = supportedGames[gameSlug];
  if (!gameDisplayName) { req.flash('error', 'গেমটি পাওয়া যায়নি'); return res.redirect('/'); }
  try {
    const userResult = await pool.query('SELECT coins FROM users WHERE id = $1', [req.session.user.id]);
    const coins = userResult.rows[0].coins;
    res.render('games/play', { gameSlug, gameDisplayName, coins, user: req.session.user });
  } catch (err) {
    req.flash('error', 'গেমটি লড করতে সমস্যা হয়েছে');
    res.redirect('/');
  }
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
    const rand = Math.random();

    const slotGames = ['slots','fortune-gems','golden-empire','sweet-bonanza','sugar-rush','fruit-slot','diamond-slot','panda-slot','tiger-slot','dragon-slot','phoenix-slot','lion-slot','samurai-slot','mahjong-ways','thai-paradise','monkey-king','wild-west','ocean-king','fire-dice','ice-slot','storm-slot','royal-flush','lucky-7','magic-ball','neon-slots','cash-burst','gold-rush','treasure-hunt','pirate-gold'];

    if (gameSlug === 'aviator' || gameSlug === 'crash' || gameSlug === 'jetx' || gameSlug === 'spaceman') {
      const crashPoint = (1 + Math.random() * 9).toFixed(2);
      req.session.gameState = { game: gameSlug, betAmount, crashPoint: parseFloat(crashPoint), startTime: Date.now() };
      await client.query('UPDATE users SET coins=coins-$1 WHERE id=$2', [betAmount, userId]);
      await client.query('INSERT INTO coin_transactions (user_id,amount,type,description) VALUES ($1,$2,$3,$4)', [userId, -betAmount, 'game_bet', supportedGames[gameSlug] + ' বজি']);
      await client.query('COMMIT');
      req.session.user.coins -= betAmount;
      return res.json({ success: true, newBalance: req.session.user.coins });

    } else if (slotGames.includes(gameSlug)) {
      const symbols = ["🍒","🍋","🍊","🍇","🔔","💎","7️⃣","⭐","🌟","👑"];
      const r = [symbols[Math.floor(Math.random()*symbols.length)],symbols[Math.floor(Math.random()*symbols.length)],symbols[Math.floor(Math.random()*symbols.length)]];
      if (r[0]===r[1]&&r[1]===r[2]) winAmount = betAmount*10;
      else if (r[0]===r[1]||r[1]===r[2]||r[0]===r[2]) winAmount = betAmount*2;
      gameResult = { results: r };

    } else if (gameSlug === 'roulette') {
      const number = Math.floor(Math.random()*37);
      const redNumbers = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
      const isRed = redNumbers.includes(number);
      if ((selection==='Red'&&isRed)||(selection==='Black'&&number!==0&&!isRed)||(selection==='Even'&&number!==0&&number%2===0)||(selection==='Odd'&&number!==0&&number%2!==0)) winAmount = betAmount*2;
      gameResult = { number, color: number===0?'Green':(isRed?'Red':'Black') };

    } else if (gameSlug === 'color-prediction') {
      const colors = ['red','red','violet','green','green','red','green'];
      const winColor = colors[Math.floor(Math.random()*colors.length)];
      const multipliers = {red:2,green:2,violet:3};
      if (selection===winColor) winAmount = betAmount*multipliers[winColor];
      gameResult = { winColor };

    } else if (gameSlug === 'coin-flip') {
      const result = rand<0.5?'head':'tail';
      if (selection===result) winAmount = betAmount*2;
      gameResult = { result };

    } else if (gameSlug === 'dragon-tiger') {
      const winSide = rand<0.46?'Dragon':rand<0.92?'Tiger':'Tie';
      const multipliers = {Dragon:2,Tiger:2,Tie:8};
      if (selection===winSide) winAmount = betAmount*multipliers[winSide];
      gameResult = { winSide };

    } else if (gameSlug === 'number-guess') {
      const winNum = Math.floor(Math.random()*10)+1;
      if (String(selection)===String(winNum)) winAmount = betAmount*5;
      gameResult = { winNum };

    } else if (gameSlug === 'hilo') {
      const result = rand<0.48?'high':rand<0.96?'low':'equal';
      if (selection===result) winAmount = betAmount*2;
      gameResult = { result };

    } else if (gameSlug === 'dice' || gameSlug === 'fire-dice') {
      const d1=Math.floor(Math.random()*6)+1,d2=Math.floor(Math.random()*6)+1,total=d1+d2;
      const actualResult = total===7?'seven':total<=6?'low':'high';
      const multipliers = {low:2,high:2,seven:5};
      if (selection===actualResult) winAmount = betAmount*multipliers[actualResult];
      gameResult = { d1, d2, total };

    } else if (gameSlug === 'lucky-spin' || gameSlug === 'wheel' || gameSlug === 'wheel-pro') {
      const prizes = [2,0,3,0,5,0,1.5,0];
      winAmount = Math.floor(betAmount*prizes[Math.floor(Math.random()*prizes.length)]);
      gameResult = {};

    } else if (gameSlug === 'mine' || gameSlug === 'minesweeper-pro') {
      winAmount = betAmount;
      gameResult = {};

    } else if (gameSlug === 'andar-bahar') {
      const winSide = rand<0.5?'Andar':'Bahar';
      if (selection===winSide) winAmount = Math.floor(betAmount*1.9);
      gameResult = { winSide };

    } else if (['teen-patti','blackjack','poker','baccarat','ludo','card-war','triple-card'].includes(gameSlug)) {
      const pc=Math.floor(Math.random()*13)+2,dc=Math.floor(Math.random()*13)+2;
      if (pc>dc) winAmount = betAmount*2;
      gameResult = { playerCard:pc, dealerCard:dc };

    } else {
      if (rand < 0.45) winAmount = betAmount*2;
      gameResult = {};
    }

    const netChange = winAmount - betAmount;
    await client.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [netChange, userId]);
    await client.query('INSERT INTO coin_transactions (user_id,amount,type,description) VALUES ($1,$2,$3,$4)', [userId, netChange, 'game_play', supportedGames[gameSlug] + ' গেম']);
    await client.query('COMMIT');
    req.session.user.coins += netChange;
    res.json({ success: true, newBalance: req.session.user.coins, winAmount, gameResult });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'সর্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

router.post('/cashout', isAuth, async (req, res) => {
  const { gameSlug, multiplier } = req.body;
  const userId = req.session.user.id;
  const gameState = req.session.gameState;
  if (!gameState) return res.status(400).json({ success: false, message: 'কোনো গেম নেই' });
  const clientMultiplier = parseFloat(multiplier);
  if (clientMultiplier >= gameState.crashPoint) {
    delete req.session.gameState;
    return res.status(400).json({ success: false, message: 'বিমান চলে গেছে!' });
  }
  const winAmount = Math.floor(gameState.betAmount * clientMultiplier);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [winAmount, userId]);
    await client.query('INSERT INTO coin_transactions (user_id,amount,type,description) VALUES ($1,$2,$3,$4)', [userId, winAmount, 'game_win', 'Cash Out x'+clientMultiplier]);
    await client.query('COMMIT');
    req.session.user.coins += winAmount;
    delete req.session.gameState;
    res.json({ success: true, newBalance: req.session.user.coins, winAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

module.exports = router;
