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
