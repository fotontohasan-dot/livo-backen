// services/settings.js
// অ্যাডমিন প্যানেল থেকে সেট করা সাইট সেটিংস (min_bet, max_bet, turnover_multiplier ইত্যাদি) পড়ার জন্য।
// Redis-এ ৩০ সেকেন্ড ক্যাশ করা থাকে (একাধিক সার্ভার ইনস্ট্যান্স জুড়ে শেয়ার্ড),
// আর প্রসেস-লেভেলেও একটা হালকা মেমরি কপি রাখা হয় যাতে Redis ডাউন থাকলেও প্রতিটা বেটে সরাসরি DB কল না লাগে।

const { pool } = require('../db');
const cache = require('./cache');

let memCache = {};
let memLastFetch = 0;
const MEM_CACHE_MS = 10 * 1000;
const REDIS_KEY = 'settings:all';
const REDIS_TTL = 30;

const DEFAULTS = {
  min_bet: '10',
  max_bet: '50000',
  turnover_multiplier: '3',
  deposit_commission_percent: '0',
  withdraw_commission_percent: '0'
};

async function fetchFromDb() {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const map = {};
    for (const row of result.rows) map[row.key] = row.value;
    return { ...DEFAULTS, ...map };
  } catch (e) {
    console.error('settings load error:', e.message);
    return { ...DEFAULTS };
  }
}

async function loadSettings() {
  const fresh = await cache.getOrSet(REDIS_KEY, REDIS_TTL, fetchFromDb);
  memCache = fresh;
  memLastFetch = Date.now();
  return memCache;
}

async function getSettings() {
  if (Date.now() - memLastFetch > MEM_CACHE_MS) await loadSettings();
  return memCache;
}

async function getSetting(key) {
  const s = await getSettings();
  return s[key] !== undefined ? s[key] : DEFAULTS[key];
}

/** অ্যাডমিন সেটিংস সেভ করার পর কল করতে হবে — Redis + মেমরি ক্যাশ দুটোই সাথে সাথে invalidate হয়। */
async function invalidateSettingsCache() {
  await cache.del(REDIS_KEY);
  memLastFetch = 0;
}

module.exports = { getSettings, getSetting, loadSettings, invalidateSettingsCache };
