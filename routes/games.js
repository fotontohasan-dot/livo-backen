// routes/games.js
// ---------------------------------------------------------------------------
// PHASE 1 — ইন-হাউস গেম সম্পূর্ণ অপসারণ
//
// আগে এই ফাইলে ১১৮টি গেমের ক্যাটালগ, সার্ভার-সাইড RNG (crash point জেনারেটর,
// হ্যান্ডলার ভিত্তিক সেটেলমেন্ট), ব্যালেন্স ডেবিট/ক্রেডিট ও লেজার-রাইট — সব
// একসাথে ছিল। প্ল্যাটফর্ম এখন থার্ড-পার্টি প্রোভাইডারের গেম চালাবে, তাই
// RNG-র দায়িত্ব প্রোভাইডারের কাছে চলে গেছে এবং ব্যালেন্স মিউটেশনের একমাত্র
// পথ হবে Seamless Wallet API (PHASE 2 — routes/providerWallet.js)।
//
// এই রাউটারে ইচ্ছাকৃতভাবে যা টিকে আছে:
//   • requireFeature('games') — রাউটার-লেভেল ফিচার গেট (আগের মতোই)
//   • GET /api/recent-wins    — coin_transactions থেকে পড়ে, প্রোভাইডার
//                               গেমের জয়েও একইভাবে কাজ করবে
//
// PHASE 3 — লবি ও লঞ্চ যোগ হলো। দুটোই সম্পূর্ণ ডাটাবেস-চালিত:
//   • ক্যাটাগরি ট্যাব games.category-র DISTINCT থেকে, হার্ডকোড নয়
//   • প্রোভাইডার ফিল্টার games.provider থেকে
//   • লঞ্চ URL অ্যাডাপ্টারের getLaunchUrl() থেকে
// অর্থাৎ নতুন প্রোভাইডারের গেম sync হলেই এই ফাইলের একটা লাইনও না বদলে
// লবিতে দেখা যায় ও খেলা যায়।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { requireFeature } = require('../middleware/featureGate');

// পুরো রাউটারে ফিচার গেট — নির্দিষ্ট রুট নয়, রাউটার-লেভেলে বসানো হয়েছে
// যাতে ভবিষ্যতে যোগ হওয়া সাব-রুটও আপনাআপনি সুরক্ষিত থাকে, আর সরাসরি
// URL দিয়ে কোনো পথ বাদ পড়ে না যায়।
router.use(requireFeature('games'));

const crypto = require('crypto');
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const casinoProviders = require('../services/casinoProviders');
const { checkIp } = require('../services/vpnDetection');
const { getIpRule, getClientIp } = require('../services/ipRules');

// ==================== সাম্প্রতিক বড় জয় (পাবলিক, রিড-অনলি) ====================
// ডেটা সোর্স: coin_transactions — গেম খেলার নিট ফল এখানেই লেখা হয়
// (type='game_play')। ধনাত্মক amount মানে ইউজার জিতেছে। প্রোভাইডার ওয়ালেট
// API-ও win ক্রেডিট একই টেবিলে একই type দিয়ে লেখে, তাই এই এন্ডপয়েন্ট
// অপরিবর্তিত থেকেই নতুন কাঠামোতে কাজ করে।
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

// ==================== লবি ====================
// একটাই কোয়েরি সব দেয়: গেম, ক্যাটাগরি ও প্রোভাইডারের তালিকা সবই games
// টেবিল থেকে। কোনো কনস্ট্যান্ট তালিকা নেই — টেবিল খালি হলে লবিও খালি।
const LOBBY_PAGE_SIZE = 60;

function lobbyFilters(query) {
  const where = ['is_active = true', 'admin_disabled = false'];
  const params = [];
  if (query.category && query.category !== 'all') {
    params.push(query.category);
    where.push(`category = $${params.length}`);
  }
  if (query.provider && query.provider !== 'all') {
    params.push(query.provider);
    where.push(`provider = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${String(query.q).slice(0, 60)}%`);
    where.push(`name ILIKE $${params.length}`);
  }
  return { where: where.join(' AND '), params };
}

async function fetchLobbyPage(query) {
  const { where, params } = lobbyFilters(query);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = (page - 1) * LOBBY_PAGE_SIZE;
  const r = await pool.query(
    `SELECT id, slug, name, category, sub_category, provider, provider_game_id,
            thumbnail_url, rtp, has_demo
       FROM games
      WHERE ${where}
      ORDER BY sort_order ASC, name ASC
      LIMIT ${LOBBY_PAGE_SIZE + 1} OFFSET ${offset}`,
    params
  );
  const hasMore = r.rows.length > LOBBY_PAGE_SIZE;
  return { page, hasMore, games: r.rows.slice(0, LOBBY_PAGE_SIZE) };
}

router.get('/', async (req, res) => {
  try {
    const [{ games, page, hasMore }, cats, provs] = await Promise.all([
      fetchLobbyPage(req.query),
      pool.query(`SELECT DISTINCT category FROM games
                   WHERE is_active = true AND admin_disabled = false AND category IS NOT NULL
                   ORDER BY category`),
      pool.query(`SELECT DISTINCT provider FROM games
                   WHERE is_active = true AND admin_disabled = false AND provider IS NOT NULL
                   ORDER BY provider`)
    ]);
    res.render('games/lobby', {
      user: req.session.user || null,
      games, page, hasMore,
      categories: cats.rows.map(r => r.category),
      providers: provs.rows.map(r => r.provider),
      selected: {
        category: req.query.category || 'all',
        provider: req.query.provider || 'all',
        q: req.query.q || ''
      }
    });
  } catch (err) {
    console.error('games lobby error:', err.message);
    res.status(500).render('error', { message: req.t('common_server_error_short') });
  }
});

// infinite scroll / lazy-load এই এন্ডপয়েন্ট থেকে পরের পেজ আনে
router.get('/api/list', async (req, res) => {
  try {
    const data = await fetchLobbyPage(req.query);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('games list error:', err.message);
    res.json({ success: true, games: [], page: 1, hasMore: false });
  }
});

// ==================== লঞ্চ ====================
// GET /games/launch/:provider/:gameId
//
// ধাপগুলো ইচ্ছাকৃতভাবে এই ক্রমে: সস্তা ও নিশ্চিত চেক আগে (auth → গেম আছে
// কি না), খরচঅলা বাহ্যিক চেক পরে (VPN lookup), আর সবার শেষে সেশন তৈরি —
// যাতে ব্যর্থ লঞ্চে কোনো অনাথ game_sessions সারি না জমে।
const SESSION_TTL_MINUTES = 120;

router.get('/launch/:provider/:gameId', isAuth, async (req, res) => {
  const { provider, gameId } = req.params;
  const mode = req.query.mode === 'demo' ? 'demo' : 'real';
  try {
    const g = await pool.query(
      `SELECT * FROM games
        WHERE provider = $1 AND provider_game_id = $2
          AND is_active = true AND admin_disabled = false`,
      [provider, gameId]
    );
    if (!g.rows.length) {
      req.flash('error', req.t('games_not_available'));
      return res.redirect('/games');
    }
    const game = g.rows[0];
    if (mode === 'demo' && !game.has_demo) {
      req.flash('error', req.t('games_not_available'));
      return res.redirect('/games');
    }

    const adapter = casinoProviders.get(provider);
    if (!adapter) {
      // গেম DB-তে আছে কিন্তু প্রোভাইডারের credential সরিয়ে নেওয়া হয়েছে।
      req.flash('error', req.t('games_not_available'));
      return res.redirect('/games');
    }

    // দেশ/VPN নিয়ন্ত্রণ — বিদ্যমান সার্ভিসগুলোই ব্যবহার করা হচ্ছে, নতুন
    // কোনো সমান্তরাল ব্যবস্থা তৈরি করা হয়নি।
    const ip = getClientIp(req);
    if ((await getIpRule(ip)) === 'block') {
      req.flash('error', req.t('error_action_not_completed'));
      return res.redirect('/games');
    }
    const vpn = await checkIp(ip).catch(() => null);
    if (vpn && (vpn.isTor || vpn.isProxy)) {
      req.flash('error', req.t('error_action_not_completed'));
      return res.redirect('/games');
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO game_sessions (session_token, user_id, provider, game_id, mode, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW() + ($7 || ' minutes')::interval)`,
      [sessionToken, req.session.user.id, provider, gameId, mode, ip, String(SESSION_TTL_MINUTES)]
    );

    const launch = await adapter.getLaunchUrl(req.session.user, game, {
      sessionToken, mode, ip,
      lang: req.session.lang || 'en'
    });

    res.render('games/play', {
      user: req.session.user,
      game,
      launchUrl: launch.url,
      launchMethod: launch.method || 'GET',
      mode
    });
  } catch (err) {
    console.error('game launch error:', err.message);
    req.flash('error', req.t('common_server_error_short'));
    res.redirect('/games');
  }
});

module.exports = router;
