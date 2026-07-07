// services/settings.js
// অ্যাডমিন প্যানেল থেকে সেট করা সাইট সেটিংস (min_bet, max_bet, turnover_multiplier ইত্যাদি) পড়ার জন্য
// ৩০ সেকেন্ড ক্যাশ করা থাকে যাতে প্রতিটা বেটে DB কল না লাগে

const { pool } = require('../db');

let cache = {};
let lastFetch = 0;
const CACHE_MS = 30 * 1000;

const DEFAULTS = {
  min_bet: '10',
  max_bet: '50000',
  turnover_multiplier: '3',
  deposit_commission_percent: '0',
  withdraw_commission_percent: '0'
};

async function loadSettings() {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings');
    const map = {};
    for (const row of result.rows) map[row.key] = row.value;
    cache = { ...DEFAULTS, ...map };
    lastFetch = Date.now();
  } catch (e) {
    console.error('settings load error:', e.message);
    cache = { ...DEFAULTS };
  }
  return cache;
}

async function getSettings() {
  if (Date.now() - lastFetch > CACHE_MS) await loadSettings();
  return cache;
}

async function getSetting(key) {
  const s = await getSettings();
  return s[key] !== undefined ? s[key] : DEFAULTS[key];
}

module.exports = { getSettings, getSetting, loadSettings };
