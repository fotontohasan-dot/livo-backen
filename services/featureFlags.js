// services/featureFlags.js
// ---------------------------------------------------------------------------
// কেন্দ্রীয় ফিচার ফ্ল্যাগ সার্ভিস।
//
// ক্যাশিং কৌশলটা services/settings.js-এর সাথে ইচ্ছাকৃতভাবে অভিন্ন:
//   • Redis-এ ৩০ সেকেন্ড (একাধিক সার্ভার ইনস্ট্যান্স জুড়ে শেয়ার্ড)
//   • প্রসেস-লেভেলে ১০ সেকেন্ডের একটা হালকা মেমরি কপি
//
// মেমরি কপিটা জরুরি: ফিচার গেট এখন প্রতিটা ইউজার-ফেসিং রিকোয়েস্টে চলে, আর
// Redis ডাউন থাকলে (services/cache.js নিঃশব্দে DB fallback করে) প্রতি
// রিকোয়েস্টে একটা করে DB কল হতো। অ্যাডমিন টগল করলে দুই স্তরই সাথে সাথেই
// invalidate হয়, তাই সার্ভার রিস্টার্ট লাগে না।
//
// fail-safe নীতি: ফ্ল্যাগ পড়তে না পারলে (DB ডাউন, টেবিল নেই) রেজিস্ট্রির
// defaultEnabled মান ব্যবহৃত হয় — অর্থাৎ ফ্ল্যাগ সিস্টেম ব্যর্থ হলে সাইট
// আগের মতোই চলে, হঠাৎ সব ফিচার বন্ধ হয়ে যায় না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const cache = require('./cache');
const registry = require('./featureRegistry');
const { PublicError } = require('../utils/safeError'); // ইচ্ছাকৃত, অ্যাডমিন-মুখী ভ্যালিডেশন বার্তা

const CACHE_KEY = 'feature_flags:all';
const CACHE_TTL = 30;
const MEM_CACHE_MS = 10 * 1000;

// রেজিস্ট্রির ক্যাটাগরি + পুরনো ক্যাটাগরিগুলো। DB-র CHECK কনস্ট্রেইন্টের সাথে
// মিলতে হবে (migrations.js দেখুন) — না মিললে createFlag() DB এররে ব্যর্থ হবে।
const VALID_CATEGORIES = Object.keys(registry.CATEGORIES);

let memCache = null;
let memLastFetch = 0;

async function fetchFromDb() {
  const r = await pool.query('SELECT * FROM feature_flags');
  return r.rows;
}

async function loadAllFlags() {
  if (memCache && Date.now() - memLastFetch < MEM_CACHE_MS) return memCache;
  const rows = await cache.getOrSet(CACHE_KEY, CACHE_TTL, fetchFromDb);
  memCache = rows || [];
  memLastFetch = Date.now();
  return memCache;
}

/**
 * একটা ফিচার চালু কিনা।
 *
 * defaultValue না দিলে রেজিস্ট্রির defaultEnabled ব্যবহৃত হয়। রেজিস্ট্রিতেও না
 * থাকলে false — অর্থাৎ অজানা key দিয়ে ভুল করে কিছু খুলে যাওয়ার সুযোগ নেই।
 */
async function isEnabled(key, defaultValue) {
  const fallback = defaultValue !== undefined ? defaultValue : registry.defaultFor(key);
  try {
    const flags = await loadAllFlags();
    const flag = (flags || []).find(f => f.key === key);
    return flag ? !!flag.enabled : fallback;
  } catch (e) {
    console.error('featureFlags.isEnabled error (fail-safe default):', e.message);
    return fallback;
  }
}

/**
 * একবারে সব রেজিস্ট্রি-ফিচারের অবস্থা { key: boolean } আকারে।
 * ভিউ-লেয়ারে নেভিগেশন লুকানোর জন্য (res.locals.features) ব্যবহৃত হয় —
 * প্রতিটা key-র জন্য আলাদা isEnabled() কল এড়াতে।
 */
async function getEnabledMap() {
  let rows = [];
  try {
    rows = (await loadAllFlags()) || [];
  } catch (e) {
    console.error('featureFlags.getEnabledMap error (fail-safe defaults):', e.message);
  }
  const byKey = new Map(rows.map(r => [r.key, r]));
  const map = {};
  for (const f of registry.FEATURES) {
    const row = byKey.get(f.key);
    map[f.key] = row ? !!row.enabled : f.defaultEnabled !== false;
  }
  return map;
}

async function getByCategory(category) {
  const flags = await loadAllFlags();
  return (flags || []).filter(f => f.category === category);
}

/**
 * Feature Management UI-এর জন্য — DB সারি + রেজিস্ট্রির মেটাডেটা (icon, order,
 * description) মিলিয়ে ক্যাটাগরি অনুযায়ী সাজানো তালিকা।
 *
 * DB-তে থাকা কিন্তু রেজিস্ট্রিতে নেই এমন ফ্ল্যাগও (পুরনো beta/api ফ্ল্যাগ,
 * অ্যাডমিনের হাতে তৈরি কাস্টম ফ্ল্যাগ) তালিকায় থাকে — নাহলে সেগুলো UI থেকে
 * হারিয়ে যেত অথচ DB-তে রয়ে যেত।
 */
async function getManagementView() {
  const rows = (await loadAllFlags()) || [];
  const merged = rows.map(row => {
    const meta = registry.get(row.key);
    return {
      ...row,
      icon: meta ? meta.icon : 'fa-flag',
      sortOrder: meta ? meta.order : 900,
      managed: !!meta,
      // i18n key — টেমপ্লেট t() দিয়ে অনুবাদ করে। অ্যাডমিনের হাতে তৈরি কাস্টম
      // ফ্ল্যাগের কোনো key নেই, তখন DB-র label/description-ই দেখানো হয়।
      labelKey: meta ? meta.labelKey : null,
      descriptionKey: meta ? meta.descriptionKey : null,
      categoryLabel: registry.categoryLabel(row.category),
      categoryLabelKey: registry.categoryLabelKey(row.category)
    };
  });
  merged.sort((a, b) => {
    const c = registry.categoryOrder(a.category) - registry.categoryOrder(b.category);
    if (c !== 0) return c;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.label).localeCompare(String(b.label));
  });

  const groups = [];
  for (const flag of merged) {
    let g = groups.find(x => x.category === flag.category);
    if (!g) {
      g = { category: flag.category, label: registry.categoryLabel(flag.category),
            labelKey: registry.categoryLabelKey(flag.category), flags: [] };
      groups.push(g);
    }
    g.flags.push(flag);
  }
  return { flags: merged, groups };
}

async function invalidateCache() {
  memCache = null;
  memLastFetch = 0;
  await cache.del(CACHE_KEY);
}

async function setFlag(key, enabled, adminId, adminUsername) {
  const r = await pool.query(
    `UPDATE feature_flags SET enabled = $1, updated_by_id = $2, updated_by_username = $3, updated_at = NOW()
     WHERE key = $4 RETURNING *`,
    [!!enabled, adminId || null, adminUsername || null, key]
  );
  await invalidateCache();
  return r.rows[0];
}

async function createFlag({ key, label, category, enabled, description, adminId, adminUsername }) {
  if (!VALID_CATEGORIES.includes(category)) throw new PublicError('অবৈধ ক্যাটাগরি');
  if (!/^[a-z0-9_]{3,60}$/.test(key || '')) throw new PublicError('key শুধু lowercase, সংখ্যা, আন্ডারস্কোর (৩-৬০ ক্যারেক্টার)');
  const r = await pool.query(
    `INSERT INTO feature_flags (key, label, category, enabled, description, updated_by_id, updated_by_username)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [key, label, category, !!enabled, description || null, adminId || null, adminUsername || null]
  );
  await invalidateCache();
  return r.rows[0];
}

/**
 * রেজিস্ট্রিতে সংজ্ঞায়িত ফ্ল্যাগ ডিলিট করা যায় না। ডিলিট করলে গেটগুলো
 * defaultEnabled-এ ফিরে যেত (অর্থাৎ বন্ধ করা ফিচার নীরবে খুলে যেত), আর
 * অ্যাডমিন UI থেকে সেটা আর নিয়ন্ত্রণও করতে পারতেন না।
 */
async function deleteFlag(id) {
  const r = await pool.query('SELECT key FROM feature_flags WHERE id = $1', [id]);
  const row = r.rows[0];
  if (row && registry.isKnownKey(row.key)) {
    throw new PublicError('সিস্টেম ফিচার ডিলিট করা যায় না — বন্ধ করতে টগল ব্যবহার করুন');
  }
  await pool.query('DELETE FROM feature_flags WHERE id = $1', [id]);
  await invalidateCache();
}

/** টেস্টের জন্য — প্রসেস মেমরি ক্যাশ জোর করে খালি করা। */
function _resetMemoryCache() {
  memCache = null;
  memLastFetch = 0;
}

module.exports = {
  loadAllFlags, isEnabled, getEnabledMap, getByCategory, getManagementView,
  setFlag, createFlag, deleteFlag, invalidateCache, VALID_CATEGORIES,
  _resetMemoryCache
};
