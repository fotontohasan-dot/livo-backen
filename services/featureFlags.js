// services/featureFlags.js
const { pool } = require('../db');
const cache = require('./cache');

const CACHE_KEY = 'feature_flags:all';
const CACHE_TTL = 30;
const VALID_CATEGORIES = ['feature', 'maintenance', 'beta', 'security', 'api'];

async function loadAllFlags() {
  return cache.getOrSet(CACHE_KEY, CACHE_TTL, async () => {
    const r = await pool.query('SELECT * FROM feature_flags ORDER BY category, label');
    return r.rows;
  });
}

async function isEnabled(key, defaultValue = false) {
  try {
    const flags = await loadAllFlags();
    const flag = (flags || []).find(f => f.key === key);
    return flag ? !!flag.enabled : defaultValue;
  } catch (e) {
    console.error('featureFlags.isEnabled error (fail-safe default):', e.message);
    return defaultValue;
  }
}

async function getByCategory(category) {
  const flags = await loadAllFlags();
  return (flags || []).filter(f => f.category === category);
}

async function invalidateCache() {
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
  if (!VALID_CATEGORIES.includes(category)) throw new Error('অবৈধ ক্যাটাগরি');
  if (!/^[a-z0-9_]{3,60}$/.test(key || '')) throw new Error('key শুধু lowercase, সংখ্যা, আন্ডারস্কোর (৩-৬০ ক্যারেক্টার)');
  const r = await pool.query(
    `INSERT INTO feature_flags (key, label, category, enabled, description, updated_by_id, updated_by_username)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [key, label, category, !!enabled, description || null, adminId || null, adminUsername || null]
  );
  await invalidateCache();
  return r.rows[0];
}

async function deleteFlag(id) {
  await pool.query('DELETE FROM feature_flags WHERE id = $1', [id]);
  await invalidateCache();
}

module.exports = { loadAllFlags, isEnabled, getByCategory, setFlag, createFlag, deleteFlag, invalidateCache, VALID_CATEGORIES };
