const express = require('express');
const { requireIntParam } = require('../middleware/validate');
const router = express.Router();

// Matches that must not accept new bets (feed statuses are lower-cased; admin-created rows may be capitalised).
const BETTING_CLOSED_MATCH_STATUSES = new Set(['finished', 'completed', 'cancelled', 'canceled', 'abandoned']);

const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureGate');
// পুরো রাউটারে `sports` গেট — ম্যাচ ব্রাউজিং স্পোর্টস সেকশনেরই অংশ।
// বেটিং আলাদাভাবে `sports_betting` দিয়ে গেটেড (নিচে POST /:id/bet), যাতে
// "ম্যাচ দেখা যাবে কিন্তু বাজি ধরা যাবে না" অবস্থাটাও সম্ভব হয়।
router.use(requireFeature('sports'));
const { addTurnover } = require('../services/turnover');
const { updateDailyTurnover } = require('../services/dailyReward');
const { distributeCommission } = require('../services/referral');
const { addBet } = require('../services/cashback');
const { addVipTurnover } = require('../services/vip');
const { updateMissionProgress } = require('../services/missions');
const { addPoints } = require('../services/loyalty');
const { checkBadges } = require('../services/badges');
const { getSetting } = require('../services/settings');
const { resolveOdd, resolveLayOdd, isRunnerSuspended } = require('../services/oddsResolver');
const { normalizeBetType, calcRisk, calcLiability, calcPotentialPayout } = require('../services/layBet');
const { broadcastDemoStats } = require('../services/socket');
const { emitMyBetsChanged } = require('../services/notify');
const cache = require('../services/cache');
const { ensureDefaultMarkets } = require('../services/autoMarkets');
const { buildMarketView, filterMarketView, runnersFor } = require('../services/marketLayout');
const { liveForClient } = require('../services/liveData');

function formatMatch(row) {
  return {
    id: row.id,
    sport: row.sport,
    league: row.league || null,
    name: row.title || null,
    teams: [row.team_a || 'Team A', row.team_b || 'Team B'],
    homeTeam: row.team_a || 'Team A',
    awayTeam: row.team_b || 'Team B',
    homeScore: row.score_a != null ? row.score_a : null,
    awayScore: row.score_b != null ? row.score_b : null,
    overs: row.overs || null,
    status: row.status || 'upcoming',
    date: row.start_time || null,
    logoA: row.logo_a || null,
    logoB: row.logo_b || null
  };
}

router.get('/', (req, res) => {
  res.render('matches', {
    currentPage: 'matches',
    sport: 'all',
    title: req.t('matches_upcoming_title'),
    user: req.session ? req.session.user : null
  });
});

router.get('/worldcup', (req, res) => {
  res.render('matches', {
    currentPage: 'worldcup',
    sport: 'cricket',
    title: 'World Cup',
    user: req.session ? req.session.user : null
  });
});

router.get('/cricket', (req, res) => {
  res.render('matches', {
    currentPage: 'cricket',
    sport: 'cricket',
    title: 'Cricket',
    user: req.session ? req.session.user : null
  });
});

router.get('/tennis', (req, res) => {
  res.render('matches', {
    currentPage: 'tennis',
    sport: 'tennis',
    title: 'Tennis',
    user: req.session ? req.session.user : null
  });
});

router.get('/football', (req, res) => {
  res.render('matches', {
    currentPage: 'football',
    sport: 'football',
    title: 'Football',
    user: req.session ? req.session.user : null
  });
});

router.get('/api/live', async (req, res) => {
  try {
    const CACHE_KEY = 'matches:live';
    const cached = await cache.get(CACHE_KEY);
    if (cached) return res.json(cached);

    // দ্রষ্টব্য: এখানে আগে `result, home_odds, draw_odds, away_odds` কলামগুলোও SELECT করা
    // হতো, কিন্তু matches টেবিলে ওই কলামগুলো কখনো তৈরিই হয়নি। ফলে কোয়েরিটা প্রতিবার
    // "column \"result\" does not exist" এরর দিত, নিচের catch ব্লক সেটা গিলে ফেলে
    // `{ success: true, cricket: [], football: [] }` ফেরত দিত — অর্থাৎ ম্যাচ পেজে
    // কখনোই কোনো ম্যাচ দেখাত না, অথচ HTTP 200 আসায় সমস্যাটা ধরা পড়ত না।
    // formatMatch() ওই চারটা কলামের একটাও ব্যবহার করে না, তাই SELECT থেকে বাদ দেওয়াই
    // সবচেয়ে ছোট নিরাপদ ফিক্স — কোনো আউটপুট ফিল্ড হারায় না।
    const result = await pool.query(
      // প্রতি স্পোর্টের জন্য আলাদা সীমা।
      //
      // আগে একটাই `LIMIT 100` ছিল গোটা তালিকায়। ফলে এক স্পোর্টে ১০০-র বেশি
      // ম্যাচ থাকলে অন্য স্পোর্টটা রেসপন্স থেকে সম্পূর্ণ বাদ পড়ে যেত —
      // ফুটবলের ভরা দিনে ক্রিকেট ট্যাব খালি দেখাত। row_number() দিয়ে
      // প্রতিটা স্পোর্ট নিজের কোটা পায়, তাই একটা অন্যটাকে চাপা দিতে পারে না।
      `SELECT id, title, team_a, team_b, sport, league, status, start_time,
              score_a, score_b, overs, logo_a, logo_b
       FROM (
         SELECT *, row_number() OVER (
           PARTITION BY sport
           ORDER BY
             CASE WHEN status = 'live' THEN 0 ELSE 1 END,
             start_time ASC NULLS LAST,
             id DESC
         ) AS rn
         FROM matches
       ) ranked
       WHERE rn <= 100
       ORDER BY
         CASE WHEN status = 'live' THEN 0 ELSE 1 END,
         start_time ASC NULLS LAST,
         id DESC`
    );

    const cricket = [];
    const football = [];
    const tennis = [];
    const other = [];

    for (const row of result.rows) {
      const m = formatMatch(row);
      if (m.sport === 'football') football.push(m);
      else if (m.sport === 'tennis') tennis.push(m);
      else if (m.sport === 'cricket') cricket.push(m);
      else other.push(m);
    }

    const payload = { success: true, cricket, football, tennis, other };
    cache.set(CACHE_KEY, payload, 10).catch(() => {}); // 10s TTL — live data stays fresh
    res.json(payload);
  } catch (err) {
    console.error('matches/api/live error:', err.message);
    res.json({ success: true, cricket: [], football: [], tennis: [], other: [] });
  }
});

// "My Bets" প্যানেলের ডেটা: লগইন করা ইউজারের নিজের সাম্প্রতিক বাজি (স্টেক, অডস, সম্ভাব্য রিটার্ন, স্ট্যাটাস)।
// শুধু নিজের বাজিই ফেরে (user_id সেশন থেকে); ম্যাচ বা মার্কেট মুছে গেলেও LEFT JOIN-এ সারি হারায় না।
router.get('/api/my-bets', isAuth, async (req, res) => {
  try {
    // Cursor pagination: ?limit=1..100 (default 50) & ?before=<bet id>. user_id always comes from the session.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const before = parseInt(req.query.before, 10);
    const params = [req.session.user.id, limit + 1];
    let cursorSql = '';
    if (Number.isSafeInteger(before) && before > 0) { params.push(before); cursorSql = `AND b.id < $${params.length}`; }
    const r = await pool.query(
      `SELECT b.id, b.match_id, b.runner, b.odd, b.stake, b.status, b.created_at,
              b.bet_type, b.liability, b.potential_payout,
              COALESCE(b.is_demo, false) AS is_demo, mk.name AS market_name,
              mk.type AS market_type, mk.odds AS market_odds, mk.depth AS market_depth,
              mk.runner_status AS market_runner_status, m.team_a, m.team_b,
              COALESCE(NULLIF(m.title, ''), m.team_a || ' vs ' || m.team_b) AS match_name
         FROM bets b
         LEFT JOIN matches m ON m.id = b.match_id
         LEFT JOIN markets mk ON mk.id = b.market_id
        WHERE b.user_id = $1 ${cursorSql}
        ORDER BY b.id DESC
        LIMIT $2`,
      params
    );
    const bets = r.rows.map(b => {
      // runner কলামে কাঁচা key ('0', '1x', ...) থাকে; ইউজারকে দেখাতে মার্কেট-লেআউটের লেবেল (ফিড-নামসহ) লাগে।
      let selection = b.runner || '';
      try {
        const hit = runnersFor(
          { type: b.market_type, odds: b.market_odds, depth: b.market_depth, runner_status: b.market_runner_status },
          b.team_a, b.team_b
        ).find(x => String(x.key) === String(b.runner));
        if (hit && hit.label) selection = hit.label;
      } catch (_) { /* মার্কেট মুছে গেলে কাঁচা key-ই দেখাও */ }
      const betType = normalizeBetType(b.bet_type);
      const stake = Number(b.stake);
      const odd = Number(b.odd);
      const stored = b.potential_payout != null ? Number(b.potential_payout) : NaN;
      return {
        id: b.id,
        matchId: b.match_id,
        matchName: b.match_name || '',
        market: b.market_name || '',
        selection,
        betType,
        odd,
        stake,
        liability: betType === 'lay' ? Number(b.liability) || 0 : 0,
        // বসানোর সময় সার্ভার যে potential_payout হিসাব করেছিল সেটাই; পুরনো সারিতে (০/NULL) Back-এর সূত্র।
        potentialReturn: Number.isFinite(stored) && stored > 0 ? stored : Math.round(stake * odd * 100) / 100,
        status: b.status || 'pending',
        demo: !!b.is_demo,
        createdAt: b.created_at
      };
    });
    res.json({ success: true, bets });
  } catch (err) {
    console.error('matches/api/my-bets error:', err.message);
    res.status(500).json({ success: false, bets: [] });
  }
});

// ত্রুটিপূর্ণ id (abc, 1e309, ইত্যাদি) আগে সরাসরি PostgreSQL-এ পৌঁছে 22P02/22003 এরর
// ঘটাত, তারপর catch ব্লক ধরে রিডাইরেক্ট করত। ইউজার নিরাপদ উত্তরই পেত, কিন্তু প্রতিটা
// এমন রিকোয়েস্টে অপ্রয়োজনীয় DB রাউন্ড-ট্রিপ হতো। এখন রুটে ঢোকার আগেই যাচাই হয়;
// গন্তব্য আগের catch ব্লকের মতোই।
router.get('/:id', requireIntParam('id', '/matches'), async (req, res) => {
  try {
    const matchRes = await pool.query(`SELECT * FROM matches WHERE id = $1`, [req.params.id]);
    const row = matchRes.rows[0];
    if (!row) return res.redirect('/matches');

    const match = {
      id: row.id,
      title: row.title,
      teams: [row.team_a || 'Team A', row.team_b || 'Team B'],
      sport: row.sport,
      status: row.status || 'Upcoming',
      score_a: row.score_a,
      score_b: row.score_b,
      overs: row.overs,
      league: row.league,
      live: liveForClient(row.sport, row.live_data),
      logo_a: row.logo_a || null,
      logo_b: row.logo_b || null
    };

    let markets = [];
    try {
      // হাতে/পুরনো সিঙ্কে তৈরি ম্যাচে মার্কেট না থাকলে এখানেই তৈরি হয়ে যাবে
      await ensureDefaultMarkets(row.id, row.status);
      const marketRes = await pool.query(
        `SELECT * FROM markets WHERE match_id = $1 AND status IN ('open','suspended') ORDER BY id ASC`,
        [req.params.id]
      );
      markets = marketRes.rows;
    } catch (mErr) {
      console.error('markets fetch error:', mErr.message);
    }

    const marketView = buildMarketView(markets, match);
    let minBet = 10, maxBet = 100000;
    try {
      minBet = Number(await getSetting('min_bet')) || minBet;
      maxBet = Number(await getSetting('max_bet')) || maxBet;
    } catch (_) { /* ডিফল্ট ব্যবহার */ }

    res.render('match-detail', {
      match,
      markets,
      marketView,
      minBet,
      maxBet,
      user: req.session ? req.session.user : null
    });
  } catch (err) {
    console.error('match-detail error:', err.message);
    res.redirect('/matches');
  }
});

// Market JSON for a tab: GET /matches/:id/markets?tab=all|popular|match|goals|btts|set|games|…
// Cached ~2s in Redis (falls back to DB when Redis is down) so tab switches and
// reconnect re-syncs never hammer Postgres during live matches.
router.get('/:id/markets', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'Invalid match id' });
  const tab = String(req.query.tab || 'all').slice(0, 20);
  try {
    const view = await cache.getOrSet(`match:marketview:${id}`, 2, async () => {
      const mr = await pool.query('SELECT id, sport, team_a, team_b, status FROM matches WHERE id = $1', [id]);
      if (!mr.rows[0]) return null;
      const mk = await pool.query(
        `SELECT * FROM markets WHERE match_id = $1 AND status IN ('open','suspended') ORDER BY id ASC`, [id]);
      return buildMarketView(mk.rows, { sport: mr.rows[0].sport, teams: [mr.rows[0].team_a || 'Team A', mr.rows[0].team_b || 'Team B'] });
    });
    if (!view) return res.status(404).json({ success: false, message: 'Match not found' });
    res.json({ success: true, tab, tabs: view.tabs, markets: filterMarketView(view, tab) });
  } catch (err) {
    console.error('market tab error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/:id/bet', isAuth, requireFeature('sports_betting'), async (req, res) => {
  const userId = req.session.user.id;
  const matchId = Number(req.params.id);
  if (!Number.isSafeInteger(matchId) || matchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid match id' });
  }
  const { market_id, runner, demo } = req.body;
  // One contract: `bet_type` is canonical, `side` is accepted as an alias. If both are sent they
  // must agree, and any unknown value is rejected — never silently downgraded to Back.
  const rawType = req.body.bet_type !== undefined ? req.body.bet_type : req.body.side;
  if (req.body.bet_type !== undefined && req.body.side !== undefined &&
      normalizeBetType(req.body.bet_type) !== normalizeBetType(req.body.side)) {
    return res.status(400).json({ success: false, message: 'bet_type and side disagree' });
  }
  const betType = normalizeBetType(rawType);
  if (!betType) {
    return res.status(400).json({ success: false, message: 'Invalid bet type' });
  }
  const marketIdNum = Number(market_id);
  if (!Number.isSafeInteger(marketIdNum) || marketIdNum <= 0) {
    return res.status(400).json({ success: false, message: req.t('matches_market_not_found') });
  }
  const stake = Number(req.body.stake);
  // Optional idempotency key: a retry with the same key can never place (or charge) twice.
  const rawRef = req.get('Idempotency-Key') || req.body.client_ref;
  const clientRef = rawRef ? String(rawRef).slice(0, 64) : null;
  if (clientRef && !/^[A-Za-z0-9_-]{8,64}$/.test(clientRef)) {
    return res.status(400).json({ success: false, message: 'Invalid idempotency key' });
  }
  const isDemo = !!demo;

  const minBet = Number(await getSetting('min_bet'));
  const maxBet = Number(await getSetting('max_bet'));
  if (!Number.isInteger(stake) || stake < minBet) {
    return res.status(400).json({ success: false, message: req.t('bet_min_amount').replace('{value}', minBet) });
  }
  if (stake > maxBet) {
    return res.status(400).json({ success: false, message: req.t('bet_max_amount').replace('{value}', maxBet) });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // মার্কেটটা সত্যিই এই ম্যাচেরই কি না — আগে যাচাই হতো না।
    //
    // ক্লায়েন্ট `matchId` ও `market_id` আলাদাভাবে পাঠায়, আর কোয়েরি শুধু
    // market_id ধরে মার্কেট তুলত। ফলে A ম্যাচের পাতা থেকে B ম্যাচের একটা
    // খোলা মার্কেটের আইডি পাঠিয়ে দিলে বাজিটা `bets.match_id = A` অথচ
    // `bets.market_id = B` নিয়ে বসে যেত। সেটেলমেন্ট চলে মার্কেট ধরে, আর
    // রিপোর্টিং চলে ম্যাচ ধরে — দুটো আর মেলে না, এবং একটা শেষ হয়ে যাওয়া
    // ম্যাচের ফলাফল জেনে অন্য ম্যাচের নামে বাজি ধরার সুযোগ তৈরি হয়।
    // Idempotent replay: same user + same key => return the original bet, charge nothing.
    if (clientRef) {
      const dup = await client.query(
        'SELECT id, bet_type, liability, potential_payout, is_demo FROM bets WHERE user_id = $1 AND client_ref = $2', [userId, clientRef]);
      if (dup.rows[0]) {
        await client.query('ROLLBACK');
        return res.json({ success: true, duplicate: true, betId: dup.rows[0].id, betType: dup.rows[0].bet_type,
          liability: dup.rows[0].liability, potentialPayout: dup.rows[0].potential_payout, message: req.t('matches_bet_placed') });
      }
    }

    // Lock order is always matches -> markets (same as the feed ingest), FOR SHARE so concurrent
    // bets don't block each other but a feed/admin suspend (FOR UPDATE) waits for in-flight bets.
    const mt = await client.query('SELECT status FROM matches WHERE id = $1 FOR SHARE', [matchId]);
    if (!mt.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: req.t('matches_market_not_found') });
    }
    if (BETTING_CLOSED_MATCH_STATUSES.has(String(mt.rows[0].status || '').toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'MATCH_CLOSED', message: req.t('matches_market_closed') });
    }
    const m = await client.query(
      `SELECT * FROM markets WHERE id = $1 AND match_id = $2 FOR SHARE`,
      [marketIdNum, matchId]
    );
    if (!m.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: req.t('matches_market_not_found') });
    }
    if (m.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: req.t('matches_market_closed') });
    }

    // অডস সার্ভার থেকেই নির্ধারিত। আগে req.body.odd সরাসরি bets.odd-এ যেত, আর
    // সেটেলমেন্ট পেআউট হিসাব করে stake * bets.odd দিয়ে — ফলে বড় odd পাঠিয়ে
    // যেকোনো পরিমাণ কয়েন তোলা যেত। ক্লায়েন্টের পাঠানো odd এখন উপেক্ষিত।
    if (isRunnerSuspended(m.rows[0], runner)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, code: 'RUNNER_SUSPENDED', message: 'This selection is suspended' });
    }
    // Back uses the stored back price; Lay uses the feed's lay price (no default).
    const oddNum = betType === 'lay' ? resolveLayOdd(m.rows[0], runner) : resolveOdd(m.rows[0], runner);
    if (oddNum === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: req.t('matches_invalid_odds') });
    }

    // Back risks the stake; Lay risks the liability = stake * (odd - 1).
    const liability = betType === 'lay' ? calcLiability(stake, oddNum) : 0;
    const risk = calcRisk(betType, stake, oddNum);
    const potentialPayout = calcPotentialPayout(betType, stake, oddNum);
    if (risk > maxBet) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: req.t('bet_max_amount').replace('{value}', maxBet) });
    }

    const balanceCol = isDemo ? 'demo_balance' : 'coins';
    const upd = await client.query(
      `UPDATE users SET ${balanceCol} = ${balanceCol} - $1 WHERE id = $2 AND ${balanceCol} >= $1 RETURNING ${balanceCol}`,
      [risk, userId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: isDemo ? req.t('balance_insufficient_demo') : req.t('payment_insufficient_coins') });
    }

    const ins = await client.query(
      `INSERT INTO bets (user_id, match_id, market_id, market_type, runner, odd, stake, status, is_demo,
                         bet_type, side, liability, potential_payout, client_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $9, $10, $11, $12) RETURNING id`,
      [userId, matchId, marketIdNum, m.rows[0].type, runner || null, oddNum, stake, isDemo,
       betType, liability, potentialPayout, clientRef]
    );
    const betId = ins.rows[0].id;

    if (isDemo) {
      await client.query(
        `INSERT INTO demo_transactions (user_id, category, type, amount, description)
         VALUES ($1, 'sports', $2, $3, $4)`,
        [userId, betType === 'lay' ? 'lay_bet' : 'bet', risk, `${betType === 'lay' ? 'লে' : 'বেট'}: ${m.rows[0].name} (ডেমো)`]
      );
      await client.query('COMMIT');

      req.session.user.demo_balance = upd.rows[0].demo_balance;
      emitMyBetsChanged(userId, 'placed');
      broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

      return res.json({ success: true, message: req.t('matches_demo_bet_placed'), demo: true, betType, liability, potentialPayout, newBalance: upd.rows[0].demo_balance });
    }

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description, ref_bet_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, -risk, betType === 'lay' ? 'lay_bet' : 'bet',
       `${betType === 'lay' ? 'লে (লায়াবিলিটি)' : 'বেট'}: ${m.rows[0].name}`, betId]
    );

    // টার্নওভার আগে COMMIT-এর পরে fire-and-forget করা হতো — ব্যর্থ হলে স্টেক কাটা
    // গেছে অথচ ওয়েজারিং প্রগ্রেস এগোয়নি, শুধু একটা console.error থাকত। এখন একই
    // ট্রানজেকশনে, COMMIT-এর আগে — বেট আর টার্নওভার হয় একসাথে টেকে, নয় একসাথে
    // রোলব্যাক হয় (coin_transactions ইনসার্টে যে সমস্যাটা আগেই ঠিক করা হয়েছিল)।
    await addTurnover(client, userId, 'sports', risk);
    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;
    emitMyBetsChanged(userId, 'placed');
    broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

    updateDailyTurnover(userId, risk).catch(e => console.error('dailyReward:', e.message));
    distributeCommission(userId, risk).catch(e => console.error('commission:', e.message));
    addBet(userId, risk, 'sports').catch(e => console.error('cashback:', e.message));
    addVipTurnover(userId, risk).catch(e => console.error('vip:', e.message));
    updateMissionProgress(userId, risk).catch(e => console.error('mission:', e.message));
    addPoints(userId, risk).catch(e => console.error('loyalty:', e.message));
    checkBadges(userId).catch(e => console.error('badges:', e.message));

    res.json({ success: true, message: req.t('matches_bet_placed'), betType, liability, potentialPayout, newBalance: upd.rows[0].coins });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505' && clientRef) {
      return res.status(409).json({ success: false, code: 'DUPLICATE_REQUEST', message: 'Duplicate request' });
    }
    console.error('bet error:', err.message);
    res.status(500).json({ success: false, message: req.t('common_server_error_short') });
  } finally {
    client.release();
  }
});

module.exports = router;
