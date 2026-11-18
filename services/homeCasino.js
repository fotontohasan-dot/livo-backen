'use strict';
// হোমপেজের ক্যাসিনো-প্রথম লেআউটের ডেটা-পড়া (শুধু SELECT — ওয়ালেট/সেটেলমেন্ট/ডিপোজিট অক্ষত)।
//
// কোয়েরির সংখ্যা ধ্রুবক (N+1 নয়): facets ১টা, ক্যাটাগরি-সারি ১টা (window function),
// জনপ্রিয় ১টা, নতুন ১টা, ব্যানার ১টা — সবগুলো ৬০ সেকেন্ড ক্যাশে। গ্রিড ১টা কোয়েরি।
// ফিল্টার (ক্যাটাগরি/প্রোভাইডার/অক্ষর/সার্চ) সম্পূর্ণ সার্ভার-সাইডে।
// services/homeCasino.js
// ---------------------------------------------------------------------------
// ক্যাসিনো-প্রথম হোমপেজের ডেটা-পড়া স্তর। এখানে শুধু SELECT আছে — ওয়ালেট/সেটেলমেন্ট/
// ডিপোজিটের সাথে কোনো সম্পর্ক নেই। গেমের একমাত্র উৎস `games` টেবিল (ক্যাটাগরি ও
// প্রোভাইডার দুটোই ওই টেবিলের টেক্সট কলাম)।
//
// কোয়েরির হিসাব (N+1 নেই):
//   ১. facets  — একটাই GROUP BY কোয়েরি; ক্যাটাগরি/প্রোভাইডার/অক্ষরের গণনা JS-এ ভাগ হয় (৬০ সেকেন্ড ক্যাশ)
//   ২. rails   — একটাই UNION ALL কোয়েরি; জনপ্রিয়, নতুন ও প্রতি ক্যাটাগরির প্রথম N গেম (৬০ সেকেন্ড ক্যাশ)
//   ৩. page    — ফিল্টার-নির্ভর গ্রিড পেজ (LIMIT+1 দিয়ে hasMore, COUNT(*) নয়), ক্যাশ ছাড়া
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const cache = require('./cache');
const autoSuspend = require('./autoSuspend');

const GRID_PAGE_SIZE = 48;
const ROW_SIZE = 12;
const MATCH_SIDEBAR_MAX = 8; // ডেস্কটপ ডান সাইডবার
const MATCH_MOBILE_MAX = 5;  // মোবাইল ছোট সারি
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const CACHE_TTL = 60;

// শুধু যে গেম সত্যিই লঞ্চ করা যায় (provider + provider_game_id আছে)।
const BASE_WHERE = `is_active = true AND admin_disabled = false
                    AND provider IS NOT NULL AND provider_game_id IS NOT NULL`;
const CARD_COLS = 'id, slug, name, category, provider, provider_game_id, thumbnail_url';

// ক্যাটাগরি যেমন প্রোভাইডার থেকে আসে (free text) — পরিচিতগুলোর জন্য লোকেল-কী, বাকিগুলো কাঁচা নামেই।
const CATEGORY_ORDER = ['slots', 'live', 'crash', 'table', 'fishing', 'lottery', 'poker', 'sports'];
function categoryKey(category) {
  const c = String(category || '').toLowerCase();
  if (/slot/.test(c)) return 'slots';
  if (/live/.test(c)) return 'live';
  if (/crash/.test(c)) return 'crash';
  if (/table|card|baccarat|roulette|blackjack/.test(c)) return 'table';
  if (/fish/.test(c)) return 'fishing';
  if (/lotter|keno|bingo/.test(c)) return 'lottery';
  if (/poker/.test(c)) return 'poker';
  if (/sport/.test(c)) return 'sports';
  return null;
}
function categoryRank(category) {
  const k = categoryKey(category);
  const i = k ? CATEGORY_ORDER.indexOf(k) : -1;
  return i === -1 ? CATEGORY_ORDER.length : i;
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

/** ইনপুট স্যানিটাইজ: অজানা/অবৈধ মান নিঃশব্দে বাদ (খালি = ফিল্টার নেই)। */
function parseFilters(query) {
  const q = String((query && query.q) || '').trim().slice(0, 60);
  const category = String((query && query.category) || '').trim().slice(0, 60);
  const provider = String((query && query.provider) || '').trim().slice(0, 60);
  const rawLetter = String((query && query.letter) || '').trim().toUpperCase();
  const letter = /^[A-Z]$/.test(rawLetter) ? rawLetter : '';
  const page = Math.min(Math.max(parseInt(query && query.page, 10) || 1, 1), 10000);
  return { q, category, provider, letter, page };
}

function hasActiveFilter(f) {
  return !!(f.q || f.category || f.provider || f.letter);
}

/** একটাই কোয়েরিতে ক্যাটাগরি/প্রোভাইডার/অক্ষরের গণনা (ক্যাশড)। খালি ক্যাটাগরি স্বভাবতই আসে না। */
async function getFacets() {
  return cache.getOrSet('home:casino:facets', CACHE_TTL, async () => {
    const r = await pool.query(
      `SELECT category, provider, UPPER(LEFT(LTRIM(name), 1)) AS letter, COUNT(*)::int AS n
         FROM games WHERE ${BASE_WHERE}
        GROUP BY category, provider, UPPER(LEFT(LTRIM(name), 1))`
const PAGE_SIZE = 48;
const RAIL_SIZE = 12;
const MAX_PAGE = 500;
const CACHE_TTL = 60;
const ACTIVE = 'is_active = true AND admin_disabled = false';

// ক্যাটাগরি স্লাগ → locale key। অচেনা ক্যাটাগরি কাঁচা নামেই দেখায় (ডেটাবেসে যা আছে তা-ই)।
const CATEGORY_LABEL_KEYS = {
  slots: 'home_cat_slots',
  slot: 'home_cat_slots',
  live: 'home_cat_live_casino',
  'live casino': 'home_cat_live_casino',
  'live-casino': 'home_cat_live_casino',
  crash: 'home_cat_crash',
  table: 'home_cat_table',
  card: 'home_cat_table',
  cards: 'home_cat_table',
  fishing: 'home_cat_fishing',
  fish: 'home_cat_fishing',
  lottery: 'home_cat_lottery',
  poker: 'home_cat_poker',
  sports: 'home_cat_sports_games',
  arcade: 'home_cat_arcade',
};

function categoryLabelKey(category) {
  return CATEGORY_LABEL_KEYS[String(category || '').toLowerCase().trim()] || null;
}

/** URL কোয়েরি → নিরাপদ ফিল্টার। অক্ষর শুধু ইংরেজি A-Z (বাংলা বা অন্য কিছু বাতিল)। */
function parseHomeQuery(query) {
  const q = query || {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const letterRaw = str(q.letter, 1).toUpperCase();
  const page = Math.min(Math.max(parseInt(q.page, 10) || 1, 1), MAX_PAGE);
  return {
    category: str(q.cat, 60),
    provider: str(q.provider, 60),
    q: str(q.q, 60),
    letter: /^[A-Z]$/.test(letterRaw) ? letterRaw : '',
    page,
  };
}

function hasActiveFilter(f) {
  return !!(f.category || f.provider || f.q || f.letter);
}

async function getFacets() {
  return cache.getOrSet('home:casino:facets', CACHE_TTL, async () => {
    const r = await pool.query(
      `SELECT category, provider, UPPER(LEFT(name, 1)) AS letter, COUNT(*)::int AS n
         FROM games
        WHERE ${ACTIVE}
        GROUP BY category, provider, UPPER(LEFT(name, 1))`
    );
    const cats = new Map();
    const provs = new Map();
    const letters = new Set();
    for (const row of r.rows) {
      if (row.category) cats.set(row.category, (cats.get(row.category) || 0) + row.n);
      if (row.provider) provs.set(row.provider, (provs.get(row.provider) || 0) + row.n);
      if (row.letter && /^[A-Z]$/.test(row.letter)) letters.add(row.letter);
    }
    const categories = [...cats.entries()]
      .filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, count, key: categoryKey(name) }))
      .sort((a, b) => categoryRank(a.name) - categoryRank(b.name) || a.name.localeCompare(b.name));
    const providers = [...provs.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { categories, providers, letters: LETTERS.filter((l) => letters.has(l)) };
  });
}

/** জনপ্রিয় (sort_order), নতুন (created_at) ও প্রতি ক্যাটাগরির প্রথম ROW_SIZE — ৩টা কোয়েরি, ক্যাশড। */
async function getRows() {
  return cache.getOrSet('home:casino:rows', CACHE_TTL, async () => {
    const [popular, fresh, perCat] = await Promise.all([
      pool.query(`SELECT ${CARD_COLS} FROM games WHERE ${BASE_WHERE}
                   ORDER BY sort_order ASC, name ASC, id ASC LIMIT ${ROW_SIZE}`),
      pool.query(`SELECT ${CARD_COLS} FROM games WHERE ${BASE_WHERE}
                   ORDER BY created_at DESC, id DESC LIMIT ${ROW_SIZE}`),
      pool.query(
        `SELECT * FROM (
           SELECT ${CARD_COLS},
                  ROW_NUMBER() OVER (PARTITION BY category ORDER BY sort_order ASC, name ASC, id ASC) AS rn
             FROM games WHERE ${BASE_WHERE} AND category IS NOT NULL
         ) t WHERE rn <= ${ROW_SIZE} ORDER BY category, rn`
      )
    ]);
    const byCat = new Map();
    for (const g of perCat.rows) {
      if (!byCat.has(g.category)) byCat.set(g.category, []);
      byCat.get(g.category).push(g);
    }
    return { popular: popular.rows, fresh: fresh.rows, byCat: [...byCat.entries()] };
  });
}

/** সক্রিয় প্রোমো ব্যানার (বিদ্যমান promotions টেবিল, অ্যাডমিন থেকে নিয়ন্ত্রিত)। শুধু নিরাপদ URL। */
function safeUrl(u) {
  const s = String(u || '').trim();
  if (/^\/(?!\/)/.test(s) || /^https:\/\//i.test(s)) return s;
  return '';
}
async function getBanners() {
  return cache.getOrSet('home:casino:banners', CACHE_TTL, async () => {
    const r = await pool.query(
      `SELECT id, title, image_url, link_url FROM promotions
        WHERE active = true ORDER BY position ASC, created_at DESC LIMIT 8`
    );
    return r.rows
      .map((b) => ({ id: b.id, title: b.title || '', image: safeUrl(b.image_url), link: safeUrl(b.link_url) }))
      .filter((b) => b.image);
  });
}

/** "সব গেম" গ্রিড — A-Z ক্রম, আইডেম্পোটেন্ট পেজিনেশন (ORDER BY name, id; একই URL = একই ফল)। */
async function getGrid(f) {
  const where = [BASE_WHERE];
  const params = [];
  if (f.category) { params.push(f.category); where.push(`category = $${params.length}`); }
  if (f.provider) { params.push(f.provider); where.push(`provider = $${params.length}`); }
  if (f.letter) { params.push(f.letter); where.push(`UPPER(LEFT(LTRIM(name), 1)) = $${params.length}`); }
  if (f.q) { params.push(`%${escapeLike(f.q)}%`); where.push(`name ILIKE $${params.length} ESCAPE '\\'`); }
  const offset = (f.page - 1) * GRID_PAGE_SIZE;
  const r = await pool.query(
    `SELECT ${CARD_COLS} FROM games WHERE ${where.join(' AND ')}
      ORDER BY name ASC, id ASC LIMIT ${GRID_PAGE_SIZE + 1} OFFSET ${offset}`,
    params
  );
  return { games: r.rows.slice(0, GRID_PAGE_SIZE), hasMore: r.rows.length > GRID_PAGE_SIZE, page: f.page };
}

/** সাসপেন্ড থাকা প্রোভাইডারের গেমে suspended=true (ফেইল-ওপেন: ত্রুটিতে সবই চালু, লবির মতোই)। */
async function markSuspended(lists) {
  const down = await autoSuspend.suspendedCasinoProviders().catch(() => new Set());
  const mark = (arr) => arr.map((g) => ({ ...g, suspended: down.has(g.provider) }));
  return lists.map(mark);
}

async function getHomeCasino(query) {
  const filters = parseFilters(query);
  const filtered = hasActiveFilter(filters);
  const [facets, banners, grid, rows] = await Promise.all([
    getFacets(),
    getBanners(),
    getGrid(filters),
    filtered ? Promise.resolve(null) : getRows()
  ]);
  let popular = []; let fresh = []; let rowsByCat = [];
  let gridGames;
  if (rows) {
    const [p, n, g, ...cats] = await markSuspended([rows.popular, rows.fresh, grid.games, ...rows.byCat.map(([, list]) => list)]);
    popular = p; fresh = n; gridGames = g;
    rowsByCat = rows.byCat.map(([name], i) => ({ name, key: categoryKey(name), games: cats[i] }));
    rowsByCat.sort((a, b) => categoryRank(a.name) - categoryRank(b.name) || a.name.localeCompare(b.name));
  } else {
    [gridGames] = await markSuspended([grid.games]);
  }
  // "লাইভ ক্যাসিনো" ন্যাভ-লিংক: DB-তে থাকা live-জাতীয় ক্যাটাগরিতে (না থাকলে ক্যাসিনো সেকশনে)
  const liveCat = facets.categories.find((c) => c.key === 'live');
  return {
    filters, filtered, banners,
    categories: facets.categories, providers: facets.providers, letters: facets.letters,
    popular, fresh, rowsByCat,
    grid: { games: gridGames, hasMore: grid.hasMore, page: grid.page },
    liveCategory: liveCat ? liveCat.name : null,
    matchCaps: { sidebar: MATCH_SIDEBAR_MAX, mobile: MATCH_MOBILE_MAX }
  };
}

/** DB ত্রুটিতে হোম যেন না ভাঙে: খালি অবস্থা (গ্রিডে "কোনো গেম নেই"), ম্যাচ সেকশন আগের মতোই কাজ করে। */
function emptyHomeCasino(query) {
  const filters = parseFilters(query);
  return {
    filters, filtered: hasActiveFilter(filters), banners: [], categories: [], providers: [], letters: [],
    popular: [], fresh: [], rowsByCat: [], grid: { games: [], hasMore: false, page: 1 },
    liveCategory: null, matchCaps: { sidebar: MATCH_SIDEBAR_MAX, mobile: MATCH_MOBILE_MAX }
  };
}

module.exports = {
  getHomeCasino, emptyHomeCasino, parseFilters, categoryKey,
  GRID_PAGE_SIZE, ROW_SIZE, MATCH_SIDEBAR_MAX, MATCH_MOBILE_MAX, LETTERS
      if (/^[A-Z]$/.test(row.letter || '')) letters.add(row.letter);
    }
    return {
      // গণনা > 0 ছাড়া কিছু তালিকায় ঢোকেই না — অর্থাৎ খালি ক্যাটাগরি স্বয়ংক্রিয়ভাবে লুকানো
      categories: [...cats.entries()].filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count })),
      providers: [...provs.entries()].filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count })),
      letters: [...letters].sort(),
    };
  });
}

async function getRails() {
  return cache.getOrSet('home:casino:rails', CACHE_TTL, async () => {
    const cols = `id, slug, name, category, provider, provider_game_id, thumbnail_url, badge`;
    const r = await pool.query(
      `(SELECT 'popular' AS rail, ${cols} FROM games
         WHERE ${ACTIVE} ORDER BY sort_order ASC, name ASC LIMIT ${RAIL_SIZE})
       UNION ALL
       (SELECT 'new' AS rail, ${cols} FROM games
         WHERE ${ACTIVE} ORDER BY created_at DESC, id DESC LIMIT ${RAIL_SIZE})
       UNION ALL
       SELECT 'cat' AS rail, ${cols} FROM (
         SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY category ORDER BY sort_order ASC, name ASC) AS rn
           FROM games WHERE ${ACTIVE} AND category IS NOT NULL
       ) t WHERE rn <= ${RAIL_SIZE}`
    );
    const out = { popular: [], new: [], byCategory: {} };
    for (const row of r.rows) {
      const { rail, ...game } = row;
      if (rail === 'popular') out.popular.push(game);
      else if (rail === 'new') out.new.push(game);
      else (out.byCategory[game.category] = out.byCategory[game.category] || []).push(game);
    }
    return out;
  });
}

async function getGamePage(f) {
  const where = [ACTIVE];
  const params = [];
  if (f.category) { params.push(f.category); where.push(`category = $${params.length}`); }
  if (f.provider) { params.push(f.provider); where.push(`provider = $${params.length}`); }
  if (f.letter) { params.push(f.letter); where.push(`UPPER(LEFT(name, 1)) = $${params.length}`); }
  if (f.q) {
    // LIKE মেটাক্যারেক্টার এস্কেপ — ইউজারের '%' বা '_' যেন ওয়াইল্ডকার্ড না হয়
    params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`name ILIKE $${params.length}`);
  }
  const offset = (f.page - 1) * PAGE_SIZE;
  const r = await pool.query(
    `SELECT id, slug, name, category, provider, provider_game_id, thumbnail_url, badge
       FROM games
      WHERE ${where.join(' AND ')}
      ORDER BY name ASC, id ASC
      LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`,
    params
  );
  return { games: r.rows.slice(0, PAGE_SIZE), hasMore: r.rows.length > PAGE_SIZE };
}

/** সাসপেন্ড থাকা প্রোভাইডারের Set (ফেইল-ওপেন, /games লবির মতোই) */
async function getSuspendedProviders() {
  return autoSuspend.suspendedCasinoProviders().catch(() => new Set());
}

/** হোমের সব ক্যাসিনো ডেটা। ব্যর্থ হলে খালি কিন্তু বৈধ অবস্থা — হোম কখনো 500 দেয় না। */
async function getHomeCasino(query) {
  const filters = parseHomeQuery(query);
  const filtered = hasActiveFilter(filters);
  const empty = {
    filters, filtered, facets: { categories: [], providers: [], letters: [] },
    rails: { popular: [], new: [], byCategory: {} }, page: { games: [], hasMore: false },
    casinoDown: false,
  };
  try {
    const [facets, rails, page] = await Promise.all([
      getFacets(),
      filtered ? Promise.resolve(empty.rails) : getRails(),
      getGamePage(filters),
    ]);
    const down = await getSuspendedProviders();
    const mark = (arr) => arr.map((g) => ({ ...g, suspended: down.has(g.provider) }));
    const byCategory = {};
    for (const [k, v] of Object.entries(rails.byCategory)) byCategory[k] = mark(v);
    return {
      filters, filtered, facets,
      rails: { popular: mark(rails.popular), new: mark(rails.new), byCategory },
      page: { games: mark(page.games), hasMore: page.hasMore },
      casinoDown: down.size > 0,
    };
  } catch (err) {
    console.error('Homepage casino data error:', err.message);
    return empty;
  }
}

/** প্রোমো স্লাইডারের ব্যানার — বিদ্যমান `promotions` টেবিল থেকে (admin ম্যানেজ করে)। */
function safeLink(url) {
  const u = String(url || '').trim();
  if (/^\/(?!\/)/.test(u) || /^https:\/\//i.test(u)) return u;
  return '';
}

async function getBanners() {
  try {
    return await cache.getOrSet('home:casino:banners', CACHE_TTL, async () => {
      const r = await pool.query(
        `SELECT id, title, image_url, link_url FROM promotions
          WHERE active = true AND image_url IS NOT NULL AND image_url <> ''
          ORDER BY position ASC, id DESC LIMIT 8`
      );
      return r.rows.map((b) => ({ id: b.id, title: b.title || '', image_url: b.image_url, link_url: safeLink(b.link_url) }));
    });
  } catch (err) {
    console.error('Homepage banners error:', err.message);
    return [];
  }
}

module.exports = {
  PAGE_SIZE, RAIL_SIZE, parseHomeQuery, hasActiveFilter, categoryLabelKey,
  getFacets, getRails, getGamePage, getHomeCasino, getBanners, safeLink,
};
