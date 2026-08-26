const express = require('express');
const crypto = require('crypto');
const secureRandom = require('../utils/secureRandom');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { addTurnover } = require('../services/turnover');
const { distributeCommission } = require('../services/referral');
const { addBet, addWin } = require('../services/cashback');
const LIVE_DEALER_GAMES = ['live-blackjack', 'live-roulette', 'lightning-roulette', 'dream-catcher', 'super-sic-bo', 'bac-bo', 'andar-bahar'];
function cashbackCategory(gameSlug) {
  return LIVE_DEALER_GAMES.includes(gameSlug) ? 'live' : 'casino';
}
const { addVipTurnover } = require('../services/vip');
const { updateMissionProgress } = require('../services/missions');
const { addPoints } = require('../services/loyalty');
const { recordGameResult } = require('../services/streak');
const { getSetting } = require('../services/settings');
const { checkBadges } = require('../services/badges');
const { broadcastDemoStats } = require('../services/socket');

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
    const r = [secureRandom.pick(symbols), secureRandom.pick(symbols), secureRandom.pick(symbols)];
    let multiplier = 0;
    if (r[0] === r[1] && r[1] === r[2]) multiplier = 10;
    else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) multiplier = 2;
    return { winAmount: betAmount * multiplier, gameResult: { results: r } };
  },
  roulette: (betAmount, selection) => {
    const number = secureRandom.randomInt(37);
    const isRed = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(number);
    let winAmount = 0;
    if ((selection === 'Red' && isRed) || (selection === 'Black' && number !== 0 && !isRed)) winAmount = betAmount * 2;
    return { winAmount, gameResult: { number, color: number === 0 ? 'Green' : (isRed ? 'Red' : 'Black') } };
  },
  'andar-bahar': (betAmount, selection) => {
    const isAndar = secureRandom.chance(0.5);
    const winAmount = (isAndar && selection === 'Andar') || (!isAndar && selection === 'Bahar') ? betAmount * 1.9 : 0;
    return { winAmount, gameResult: { side: isAndar ? 'Andar' : 'Bahar' } };
  },
  'teen-patti': (betAmount) => {
    const winAmount = secureRandom.chance(0.40) ? betAmount * 1.95 : 0;
    return { winAmount, gameResult: {} };
  },
  blackjack: (betAmount) => {
    const winAmount = secureRandom.chance(0.42) ? betAmount * 2 : 0;
    return { winAmount, gameResult: {} };
  },
  poker: (betAmount) => {
    const winAmount = secureRandom.chance(0.35) ? betAmount * 2.5 : 0;
    return { winAmount, gameResult: {} };
  },
  baccarat: (betAmount, selection) => {
    const resultOptions = ['Player', 'Banker', 'Tie'];
    const outcome = secureRandom.pick(resultOptions);
    let winAmount = 0;
    if (outcome === selection) {
      if (outcome === 'Tie') winAmount = betAmount * 8;
      else winAmount = betAmount * 1.95;
    }
    return { winAmount, gameResult: { outcome } };
  }
};

// ==================== সাম্প্রতিক বড় জয় (পাবলিক, রিড-অনলি) ====================
// হোমপেজের "Recent Big Wins" সেকশন আগে একটা হার্ডকোড করা অ্যারে থেকে বানানো
// ইউজারনেম ও বানানো টাকার অঙ্ক দেখাত (******119 → ৳ 11,892,652)। সেটা বাস্তব
// প্রোডাকশন ডেটা নয়, তাই সরিয়ে এই এন্ডপয়েন্ট যোগ করা হলো।
//
// ডেটা সোর্স: coin_transactions — গেম খেলার নিট ফল এখানেই লেখা হয়
// (type='game_play')। ধনাত্মক amount মানে ইউজার জিতেছে। নতুন কোনো আর্থিক
// টেবিল বা লেজার তৈরি করা হয়নি; যা আগে থেকেই লেখা হচ্ছিল সেটাই পড়া হচ্ছে।
//
// গোপনীয়তা: ইউজারনেম কখনো পুরোটা যায় না — শুধু শেষ ৩ অক্ষর, আগে তারকা চিহ্ন।
// user_id, ইমেইল, ফোন বা ব্যালেন্স কিছুই বের হয় না। ফলে সেকশনটা পাবলিক থাকতে পারে।
router.get('/api/recent-wins', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.username, ct.amount, ct.description, ct.created_at
       FROM coin_transactions ct
       JOIN users u ON u.id = ct.user_id
       WHERE ct.type = 'game_play' AND ct.amount > 0
       ORDER BY ct.created_at DESC
       LIMIT 10`
    );

    const wins = result.rows.map((row) => {
      const name = String(row.username || '');
      const tail = name.length > 3 ? name.slice(-3) : name;
      return {
        user: `******${tail}`,
        game: row.description || 'Game',
        amount: Number(row.amount)
      };
    });

    res.json({ success: true, wins });
  } catch (err) {
    console.error('recent-wins error:', err.message);
    // ব্যর্থ হলেও হোমপেজ যেন না ভাঙে — খালি তালিকা, ২০০ নয় বরং সৎ খালি ফল
    res.json({ success: true, wins: [] });
  }
});

router.get('/play', isAuth, (req, res) => {
  const gameSlug = req.query.game || 'slots';
  if (!supportedGames[gameSlug]) {
    req.flash('error', req.t('games_not_found'));
    return res.redirect('/');
  }
  res.render('games/play', {
    gameSlug: gameSlug,
    gameDisplayName: supportedGames[gameSlug],
    coins: req.session.user.coins,
    demoBalance: req.session.user.demo_balance
  });
});

router.get('/:slug', isAuth, (req, res) => {
  const gameSlug = req.params.slug;
  if (!supportedGames[gameSlug]) {
    req.flash('error', req.t('games_not_found'));
    return res.redirect('/');
  }
  res.render('games/play', {
    gameSlug: gameSlug,
    gameDisplayName: supportedGames[gameSlug],
    coins: req.session.user.coins,
    demoBalance: req.session.user.demo_balance
  });
});

router.post('/play', isAuth, async (req, res) => {
  const { gameSlug, amount, selection, demo } = req.body;
  const userId = req.session.user.id;
  const betAmount = parseInt(amount);
  const isDemo = !!demo;

  if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ success: false, message: req.t('common_enter_valid_amount') });

  const minBet = Number(await getSetting('min_bet'));
  const maxBet = Number(await getSetting('max_bet'));
  if (betAmount < minBet) return res.status(400).json({ success: false, message: req.t('bet_min_amount').replace('{value}', minBet) });
  if (betAmount > maxBet) return res.status(400).json({ success: false, message: req.t('bet_max_amount').replace('{value}', maxBet) });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const balanceCol = isDemo ? 'demo_balance' : 'coins';
    const userResult = await client.query(`SELECT ${balanceCol} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (userResult.rows[0][balanceCol] < betAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: isDemo ? req.t('balance_insufficient_demo') : req.t('balance_insufficient') });
    }

    let winAmount = 0;
    let gameResult = {};

    if (['aviator', 'crash-game'].includes(gameSlug)) {
      const crashPoint = (1 + secureRandom.randomFloat() * 9).toFixed(2);
      const roundToken = crypto.randomUUID();
      // রাউন্ড এখন DB-তে (game_rounds) রেকর্ড হয় — crash_point/bet_amount/started_at
      // সার্ভার-সাইড অথরিটি, session শুধু কোন রাউন্ড claim করতে হবে তার token রাখে।
      // মাস্টার অডিট BUG-001 fix: শুধু session-নির্ভরতায় (ক) elapsed-time যাচাই ছাড়া
      // যেকোনো multiplier দাবি করা যেত, (খ) সমান্তরাল রিকোয়েস্ট একই session snapshot
      // পড়ে ডাবল-ক্যাশআউট করতে পারত — atomic DB claim (UPDATE ... WHERE settled_at
      // IS NULL) দুটোই বন্ধ করে।
      await client.query(
        `INSERT INTO game_rounds (round_token, user_id, game_slug, bet_amount, crash_point, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [roundToken, userId, gameSlug, betAmount, crashPoint, isDemo]
      );
      req.session.gameState = { game: gameSlug, roundToken, isDemo };
      await client.query(`UPDATE users SET ${balanceCol} = ${balanceCol} - $1 WHERE id = $2`, [betAmount, userId]);
      // লেজার-ইনসার্ট আগে COMMIT-এর পরে আলাদা, অ-await করা pool.query(...).catch(...) হিসেবে
      // হতো — ব্যালেন্স কর্তন স্থায়ীভাবে commit হয়ে যাওয়ার পরও ওই ইনসার্ট ব্যর্থ হলে (কানেকশন
      // সমস্যা ইত্যাদি) শুধু লগ হতো, ব্যালেন্স-লেজার গরমিল স্থায়ীভাবে থেকে যেত। এখন একই
      // ট্রানজেকশনে, COMMIT-এর আগে — অন্য সব ব্যালেন্স-মিউটেশন পাথের মতোই।
      if (isDemo) {
        await client.query('INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'casino', 'bet', betAmount, `${supportedGames[gameSlug] || gameSlug} (ডেমো)`]);
      } else {
        // BUG-002: casino_bet ব্যালেন্স থেকে debit — লেজারে নেগেটিভ হওয়া উচিত, অন্য সব
        // ব্যালেন্স-প্রভাবিত এন্ট্রির মতো (দেখুন tests/integration/financialLedgerIntegrity.test.js-এর
        // ইনভেরিয়েন্ট: balance == starting + SUM(coin_transactions))। আগে ধনাত্মক লেখা হতো
        // বলে এই ইনভেরিয়েন্ট ভাঙত। services/socket.js-এর wagered-total stat সাইন-বদলের
        // জন্য আলাদাভাবে সামঞ্জস্য করা হয়েছে (আচরণ অপরিবর্তিত)।
        await client.query('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
          [userId, -betAmount, 'casino_bet', `${supportedGames[gameSlug] || gameSlug} বাজি`]);
      }
      await client.query('COMMIT');

      if (isDemo) {
        req.session.user.demo_balance = Number(req.session.user.demo_balance || 0) - betAmount;
        broadcastDemoStats().catch(e => console.error('demo stats:', e.message));
        return res.json({ success: true, message: req.t('games_started_demo'), demo: true, newBalance: req.session.user.demo_balance });
      }

      addTurnover(userId, 'casino', betAmount).catch(e => console.error('turnover:', e.message));
      distributeCommission(userId, betAmount).catch(e => console.error('commission:', e.message));
      addBet(userId, betAmount, cashbackCategory(gameSlug)).catch(e => console.error('cashback:', e.message));
      addVipTurnover(userId, betAmount).catch(e => console.error('vip:', e.message));
      updateMissionProgress(userId, betAmount).catch(e => console.error('mission:', e.message));
      addPoints(userId, betAmount).catch(e => console.error('loyalty:', e.message));
      checkBadges(userId).catch(e => console.error('badges:', e.message));
      broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

      return res.json({ success: true, message: req.t('games_started') });
    }

    if (gameHandlers[gameSlug]) {
      const result = gameHandlers[gameSlug](betAmount, selection);
      winAmount = result.winAmount;
      gameResult = result.gameResult;
    } else {
      winAmount = secureRandom.chance(0.45) ? betAmount * 2 : 0;
    }

    const netChange = winAmount - betAmount;
    await client.query(`UPDATE users SET ${balanceCol} = ${balanceCol} + $1 WHERE id = $2`, [netChange, userId]);

    if (isDemo) {
      await client.query('INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
        [userId, 'casino', 'bet', betAmount, `${supportedGames[gameSlug] || gameSlug} (ডেমো)`]);
      if (winAmount > 0) {
        await client.query('INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
          [userId, 'casino', 'win', winAmount, `${supportedGames[gameSlug] || gameSlug} জয় (ডেমো)`]);
      }
      await client.query('COMMIT');
      req.session.user.demo_balance = Number(req.session.user.demo_balance || 0) + netChange;
      broadcastDemoStats().catch(e => console.error('demo stats:', e.message));
      return res.json({ success: true, demo: true, newBalance: req.session.user.demo_balance, winAmount, gameResult });
    }

    // লেজারের দুটো এন্ট্রি মিলে ঠিক ব্যালেন্স-পরিবর্তনটাই ব্যাখ্যা করে:
    //
    //     casino_bet (-betAmount) + game_play (+winAmount) = netChange
    //
    // আগে game_play-তে netChange লেখা হতো আর তার পাশে casino_bet(-betAmount) —
    // অর্থাৎ বাজির টাকা দুবার বিয়োগ হতো। এই কোডবেসের মূল ইনভেরিয়েন্ট
    // (balance == starting + SUM(coin_transactions.amount), দেখুন
    // tests/integration/financialLedgerIntegrity.test.js) প্রতিটা ইনস্ট্যান্ট
    // গেমে betAmount পরিমাণ ভাঙত — লেজার প্রকৃত ব্যালেন্সের চেয়ে কম দেখাত।
    //
    // এখন casino_bet = বাজি (ডেবিট), game_play = ফেরত পাওয়া টাকা (ক্রেডিট)।
    // হারলে winAmount শূন্য, তাই তখন এন্ট্রিও লেখা হয় না — শূন্য-অঙ্কের সারি
    // লেজারে অর্থহীন। Aviator পথ আগে থেকেই এই মডেলেই চলে (casino_bet বাজির
    // সময়, game_win ক্যাশআউটে)।
    await client.query('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                       [userId, -betAmount, 'casino_bet', `${supportedGames[gameSlug] || gameSlug} বাজি`]);
    if (winAmount > 0) {
      await client.query('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                         [userId, winAmount, 'game_play', `${supportedGames[gameSlug] || gameSlug} জয়`]);
    }
    await client.query('COMMIT');
    req.session.user.coins += netChange;
    broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

    addTurnover(userId, 'casino', betAmount).catch(e => console.error('turnover:', e.message));
    distributeCommission(userId, betAmount).catch(e => console.error('commission:', e.message));
    addBet(userId, betAmount, cashbackCategory(gameSlug)).catch(e => console.error('cashback:', e.message));
    addVipTurnover(userId, betAmount).catch(e => console.error('vip:', e.message));
    updateMissionProgress(userId, betAmount).catch(e => console.error('mission:', e.message));
    addPoints(userId, betAmount).catch(e => console.error('loyalty:', e.message));
    recordGameResult(userId, winAmount > 0, betAmount).catch(e => console.error('streak:', e.message));
    checkBadges(userId).catch(e => console.error('badges:', e.message));
    if (winAmount > 0) addWin(userId, winAmount, cashbackCategory(gameSlug)).catch(e => console.error('cashback:', e.message));

    res.json({ success: true, newBalance: req.session.user.coins, winAmount, gameResult });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: req.t('common_server_error_short') });
  } finally {
    client.release();
  }
});

// ক্লায়েন্ট-সাইড multiplier-growth curve-এর সাথে মেলানো (views/games/aviator.ejs:
// multiplier = 1 + elapsed^1.5 * 0.18, elapsed সেকেন্ডে)। সার্ভার independently এই
// একই সূত্র দিয়ে হিসাব করে, নেটওয়ার্ক/টাইমার জিটার সামলাতে সামান্য tolerance সহ।
const MULTIPLIER_TIMING_TOLERANCE = 0.05;
function maxReachableMultiplier(elapsedSeconds) {
  return 1 + Math.pow(Math.max(0, elapsedSeconds), 1.5) * 0.18;
}

router.post('/cashout', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { gameSlug, multiplier } = req.body;

  const state = req.session.gameState;

  if (!state || state.game !== gameSlug || !state.roundToken) {
    return res.status(400).json({ success: false, message: req.t('games_no_active_round') });
  }

  const cashMultiplier = parseFloat(multiplier);
  if (isNaN(cashMultiplier) || cashMultiplier < 1) {
    return res.status(400).json({ success: false, message: req.t('games_invalid_multiplier') });
  }

  // atomic claim: শুধু settled_at IS NULL অবস্থায় থাকা রাউন্ড claim করা যাবে। Postgres-এর
  // row-level lock সমান্তরাল claim সিরিয়ালাইজ করে — একই round_token-এ একসাথে একাধিক
  // cashout রিকোয়েস্ট এলে ঠিক একটাই UPDATE সফল হয়, বাকিগুলো ০ সারি পায় (ডাবল-ক্যাশআউট
  // বন্ধ, replay prevention)। elapsed_seconds একই কোয়েরিতে DB-এর NOW() দিয়ে গণনা করা
  // হয় — অ্যাপ-সার্ভার ক্লক স্কিউ-এর ওপর নির্ভর করে না।
  const claim = await pool.query(
    `UPDATE game_rounds SET settled_at = NOW()
     WHERE round_token = $1 AND user_id = $2 AND settled_at IS NULL
     RETURNING bet_amount, crash_point, is_demo, EXTRACT(EPOCH FROM (NOW() - started_at)) AS elapsed_seconds`,
    [state.roundToken, userId]
  );
  req.session.gameState = null;

  if (claim.rowCount === 0) {
    return res.status(400).json({ success: false, message: req.t('games_round_already_settled') });
  }

  const round = claim.rows[0];
  const betAmount = Number(round.bet_amount);
  const crashPoint = Number(round.crash_point);
  const elapsedSeconds = Number(round.elapsed_seconds);
  // ডেমো কি না তার একমাত্র উৎস game_rounds সারি — যে সারি থেকে bet_amount ও
  // crash_point আসছে, ঠিক সেটাই। আগে এই সিদ্ধান্ত req.session.gameState.isDemo
  // থেকে নেওয়া হতো, অথচ কোয়েরিটা is_demo ফেরত এনেও ব্যবহার করত না — অর্থাৎ
  // কোন ব্যালেন্সে পেআউট যাবে তা ঠিক হতো সেশন-কপি দেখে, রাউন্ড রেকর্ড দেখে নয়।
  // একই রাউন্ডের স্টেক আর পেআউট সবসময় এক কলামেই থাকা চাই।
  const isDemo = !!round.is_demo;
  const balanceCol = isDemo ? 'demo_balance' : 'coins';

  // BUG-001: এই যাচাই ছাড়া বাজি বসানোর সাথে সাথেই যেকোনো multiplier দাবি করে ক্যাশআউট
  // করা যেত — crashPoint uniform(1,10) হওয়ায় প্রায় সবসময় জিতে যাওয়া সম্ভব ছিল
  // (পুনরুৎপাদন করা হয়েছে: ৪০ রাউন্ডে ৩৬ জয়, ১.৫x ইনস্ট্যান্ট ক্যাশআউটে)। এখন claimed
  // multiplier বাস্তবে অতিবাহিত সময়ে ওঠা সম্ভব এমন সর্বোচ্চ মাল্টিপ্লায়ারের বেশি হতে
  // পারবে না। রাউন্ড ইতিমধ্যে claim হয়ে গেছে (settled_at সেট), তাই legit ইউজার আবার
  // চেষ্টা করতে চাইলে নতুন গেম শুরু করতে হবে — এটা ইচ্ছাকৃত: premature claim মানেই
  // ক্লায়েন্ট UI বাইপাস করে সরাসরি API কল, legit অ্যানিমেশন কখনো displayed multiplier-এর
  // চেয়ে বেশি claim পাঠায় না।
  if (cashMultiplier > maxReachableMultiplier(elapsedSeconds) + MULTIPLIER_TIMING_TOLERANCE) {
    return res.status(400).json({ success: false, message: req.t('games_multiplier_not_reached') });
  }

  if (cashMultiplier > crashPoint) {
    // ডেমো রাউন্ডের ফল আসল win_streak-এ লেখা হবে না। আগে এই কলটা isDemo চেক-এর
    // আগে ছিল, তাই ডেমোতে ক্র্যাশ করলেই আসল স্ট্রিক ০ হয়ে যেত এবং স্ট্রিক বোনাস
    // (services/streak.js — আসল কয়েন) হারাত।
    if (!isDemo) {
      recordGameResult(userId, false).catch(e => console.error('streak:', e.message));
    }
    return res.json({
      success: true,
      crashed: true,
      winAmount: 0,
      demo: isDemo,
      newBalance: isDemo ? req.session.user.demo_balance : req.session.user.coins,
      message: req.t('games_aviator_crashed_at').replace('{value}', crashPoint)
    });
  }

  const winAmount = Math.floor(betAmount * cashMultiplier);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE users SET ${balanceCol} = ${balanceCol} + $1 WHERE id = $2 RETURNING ${balanceCol}`,
      [winAmount, userId]
    );

    if (isDemo) {
      await client.query(
        'INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
        [userId, 'casino', 'win', winAmount, `${supportedGames[gameSlug] || gameSlug} ক্যাশআউট ${cashMultiplier}x (ডেমো)`]
      );
      await client.query('COMMIT');
      req.session.user.demo_balance = upd.rows[0].demo_balance;
      broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

      return res.json({
        success: true, crashed: false, winAmount, multiplier: cashMultiplier,
        demo: true, newBalance: req.session.user.demo_balance
      });
    }

    await client.query(
      'INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
      [userId, winAmount, 'game_win', `${supportedGames[gameSlug] || gameSlug} ক্যাশআউট ${cashMultiplier}x`]
    );
    await client.query('COMMIT');

    req.session.user.coins = upd.rows[0].coins;
    broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

    recordGameResult(userId, true, betAmount).catch(e => console.error('streak:', e.message));
    checkBadges(userId).catch(e => console.error('badges:', e.message));
    if (winAmount > 0) addWin(userId, winAmount, cashbackCategory(gameSlug)).catch(e => console.error('cashback:', e.message));

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
    res.status(500).json({ success: false, message: req.t('common_server_error_short') });
  } finally {
    client.release();
  }
});

module.exports = router;
