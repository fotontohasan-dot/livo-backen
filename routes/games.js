const express = require('express');
const crypto = require('crypto');
const secureRandom = require('../utils/secureRandom');
const router = express.Router();
const { requireFeature } = require('../middleware/featureGate');

// পুরো রাউটারে ফিচার গেট — নির্দিষ্ট রুট নয়, রাউটার-লেভেলে বসানো হয়েছে
// যাতে ভবিষ্যতে যোগ হওয়া সাব-রুটও আপনাআপনি সুরক্ষিত থাকে, আর সরাসরি
// URL দিয়ে কোনো পথ বাদ পড়ে না যায়।
router.use(requireFeature('games'));

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
const gameRegistry = require('../services/gameRegistry');

// ক্যাটালগ ও হ্যান্ডলার এখন services/gameRegistry.js-এ — এক জায়গা থেকেই ঠিক হয়
// কোন গেম আসলে খেলা যায়। নতুন গেম যোগ করার নিয়ম: docs/ADDING_A_GAME.md
const supportedGames = gameRegistry.CATALOGUE;



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

router.get('/play', isAuth, async (req, res) => {
  const gameSlug = req.query.game || 'slots';
  if (!gameRegistry.isKnown(gameSlug)) {
    req.flash('error', req.t('games_not_found'));
    return res.redirect('/');
  }
  if (!gameRegistry.isPlayable(gameSlug)) {
    req.flash('error', req.t('games_not_available'));
    return res.redirect('/');
  }
  // LIVO-05: বাজির ইনপুটের ডিফল্ট/সীমা হার্ডকোড করা ছিল (value="1" min="1"),
  // অথচ সার্ভারের min_bet ১০ — ডিফল্ট মেনে বাজি ধরলেই ৪০০ ফিরত। এখন সীমাগুলো
  // সেটিংস থেকেই ভিউতে যায়, তাই ফ্রন্টএন্ড আর সার্ভারের সঙ্গে বেমানান হতে পারে না।
  res.render('games/play', {
    gameSlug: gameSlug,
    gameDisplayName: supportedGames[gameSlug],
    coins: req.session.user.coins,
    demoBalance: req.session.user.demo_balance,
    minBet: Number(await getSetting('min_bet')),
    maxBet: Number(await getSetting('max_bet'))
  });
});

router.get('/:slug', isAuth, async (req, res) => {
  const gameSlug = req.params.slug;
  if (!gameRegistry.isKnown(gameSlug)) {
    req.flash('error', req.t('games_not_found'));
    return res.redirect('/');
  }
  if (!gameRegistry.isPlayable(gameSlug)) {
    req.flash('error', req.t('games_not_available'));
    return res.redirect('/');
  }
  // LIVO-05: বাজির ইনপুটের ডিফল্ট/সীমা হার্ডকোড করা ছিল (value="1" min="1"),
  // অথচ সার্ভারের min_bet ১০ — ডিফল্ট মেনে বাজি ধরলেই ৪০০ ফিরত। এখন সীমাগুলো
  // সেটিংস থেকেই ভিউতে যায়, তাই ফ্রন্টএন্ড আর সার্ভারের সঙ্গে বেমানান হতে পারে না।
  res.render('games/play', {
    gameSlug: gameSlug,
    gameDisplayName: supportedGames[gameSlug],
    coins: req.session.user.coins,
    demoBalance: req.session.user.demo_balance,
    minBet: Number(await getSetting('min_bet')),
    maxBet: Number(await getSetting('max_bet'))
  });
});

// ==================== ক্র্যাশ পয়েন্ট (হাউস এজ সহ) ====================
// LIVO-01: আগে crash point ছিল `1 + secureRandom.randomFloat() * 9` — অর্থাৎ
// uniform [1, 10)। uniform বণ্টনে কোনো হাউস এজ থাকে না। m গুণিতকে ক্যাশআউট
// করলে P(win) = (10 − m)/9, তাই RTP = m(10 − m)/9 — যা m ≈ ১.১৫ থেকে ৮.৮
// পর্যন্ত পুরো রেঞ্জেই ১-এর বেশি, সর্বোচ্চ ৫x-এ প্রায় ২.৭৮ (প্লেয়ারের পক্ষে
// +১৭৮%)। লাইভ HTTP রাউন্ড দিয়ে মাপা হয়েছে: ১.৫x-এ RTP ১.৪৩, ৫x-এ ২.৭৩।
// অর্থাৎ যেকোনো বট শুধু ৫x-এ ক্যাশআউট করেই প্রতি রাউন্ডে গড়ে স্টেকের ১.৭৮
// গুণ তুলে নিতে পারত।
//
// এখন ইন্ডাস্ট্রি-স্ট্যান্ডার্ড ক্র্যাশ বণ্টন: crash = (1 − edge) / (1 − u)।
// এতে যেকোনো m > 1-এর জন্য P(crash ≥ m) = (1 − edge)/m, তাই
// RTP = m × (1 − edge)/m = (1 − edge) — ধ্রুবক, কোন গুণিতকে ক্যাশআউট করা হলো
// তার উপর নির্ভরশীল নয়। কোনো ক্যাশআউট-কৌশল আর প্লেয়ারের পক্ষে যায় না।
//
// শুধু বণ্টনটাই বদলেছে। রাউন্ড রেকর্ডিং, atomic claim, elapsed-time যাচাই,
// পেআউট হিসাব, ওয়ালেট ও লেজার — সবকিছু আগের মতোই আছে।
const CRASH_HOUSE_EDGE = 0.01;

// game_rounds.crash_point কলামটা NUMERIC(6,2) — সর্বোচ্চ 9999.99 ধরতে পারে।
// এই বণ্টনের লেজ তাত্ত্বিকভাবে অসীম, তাই ক্যাপ ছাড়া বিরল রাউন্ডে numeric
// overflow হয়ে INSERT-ই ব্যর্থ হতো। ক্যাপ RTP-তে কোনো প্রভাব ফেলে না
// (m ≤ 1000-এর জন্য P(crash ≥ m) অপরিবর্তিত) এবং সর্বোচ্চ দায় সীমিত রাখে।
const CRASH_MAX_MULTIPLIER = 1000;

function generateCrashPoint() {
  const u = secureRandom.randomFloat(); // [0, 1)
  const raw = (1 - CRASH_HOUSE_EDGE) / (1 - u);
  // ২ দশমিকে floor — নিচের দিকে কাটা হয়, তাই কখনো প্লেয়ারের পক্ষে যায় না।
  const truncated = Math.floor(raw * 100) / 100;
  // u < edge হলে raw < 1 — তাৎক্ষণিক ক্র্যাশ, অর্থাৎ crash point ১.০০।
  return Math.min(CRASH_MAX_MULTIPLIER, Math.max(1, truncated));
}

router.post('/play', isAuth, async (req, res) => {
  const { gameSlug, amount, selection, demo } = req.body;
  const userId = req.session.user.id;
  const betAmount = parseInt(amount);
  const isDemo = !!demo;

  if (isNaN(betAmount) || betAmount <= 0) return res.status(400).json({ success: false, message: req.t('common_enter_valid_amount') });

  // ক্যাটালগে নাম থাকা আর গেম খেলা যাওয়া এক নয় — লজিক না থাকলে এখানেই থামা,
  // ব্যালেন্স স্পর্শ করার আগে।
  if (!gameRegistry.isKnown(gameSlug)) {
    return res.status(404).json({ success: false, message: req.t('games_not_found') });
  }
  if (!gameRegistry.isPlayable(gameSlug)) {
    return res.status(400).json({ success: false, message: req.t('games_not_available') });
  }

  // LIVO-04: এই গেমে বাজি বাছাই বাধ্যতামূলক হলে মানটা সার্ভারেই যাচাই করা হয় —
  // ব্যালেন্স স্পর্শ করার আগে, তাই অবৈধ রিকোয়েস্টে কোনো ডেবিট বা লেজার সারি হয় না।
  // আগে অচেনা selection নীরবে গ্রহণ করা হতো: টাকা কাটা যেত অথচ `outcome === selection`
  // কখনো মিলত না, অর্থাৎ নিশ্চিত পরাজয়। ক্লায়েন্ট শুধু পক্ষটাই পাঠায় — পেআউট,
  // গুণিতক বা ফলাফল কিছুই নয়, সেগুলো সার্ভারই ঠিক করে।
  const allowedSelections = gameRegistry.getSelections(gameSlug);
  if (allowedSelections && !allowedSelections.includes(selection)) {
    return res.status(400).json({ success: false, message: req.t('games_invalid_selection') });
  }

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
      const crashPoint = generateCrashPoint().toFixed(2);
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

    // হ্যান্ডলার না থাকলে গেমটি খেলা যাবে না।
    //
    // আগে এখানে fallback ছিল: `chance(0.45) ? betAmount * 2 : 0` — ক্যাটালগের
    // ১১৮টি গেমের মধ্যে ১০৯টিরই নিজস্ব লজিক নেই, তাই সেগুলো সব একই জেনেরিক
    // নিয়মে সেটেল হতো। ইউজার আলাদা আলাদা গেম দেখত, সার্ভার একটাই খেলত।
    // আসল টাকার প্ল্যাটফর্মে এটা গ্রহণযোগ্য নয়, তাই fallback সরানো হলো।
    //
    // এই শাখায় পৌঁছানোর আগেই রুটের শুরুতে যাচাই হয়ে যায়; এটা শেষ প্রতিরক্ষা,
    // যাতে ভবিষ্যতে ক্যাটালগে গেম যোগ হলেও লজিক ছাড়া কখনো টাকা না কাটে।
    const handler = gameRegistry.getHandler(gameSlug);
    if (typeof handler !== 'function') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: req.t('games_not_available') });
    }
    const result = handler(betAmount, selection);
    winAmount = result.winAmount;
    gameResult = result.gameResult;

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

// রাউটারের পাশাপাশি ক্র্যাশ-পয়েন্ট জেনারেটরটা এক্সপোর্ট করা হচ্ছে যাতে
// tests/security/crashHouseEdge.test.js বড় নমুনায় (২ লাখ ড্র) বণ্টনের
// RTP ইনভেরিয়েন্ট সরাসরি যাচাই করতে পারে — HTTP দিয়ে অত রাউন্ড চালানো
// অবাস্তব, আর কম নমুনায় পরিমাপের নয়েজ ১%-এর এজ ধরতে পারে না।
// routes/payment.js-এর creditApprovedDeposit এক্সপোর্টের মতোই প্যাটার্ন;
// কোনো রুট বা API কনট্র্যাক্ট এতে বদলায় না।
module.exports.generateCrashPoint = generateCrashPoint;
