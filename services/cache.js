// services/cache.js
// Redis ক্যাশ লেয়ার — সাইট সেটিংস, হোমপেজ ডেটা, প্রোফাইল, লিডারবোর্ড ইত্যাদির জন্য।
// Redis অনুপলব্ধ থাকলে (ডাউন / কনফিগার্ড না থাকলে) পুরো সিস্টেম কোনো এরর ছাড়াই
// সরাসরি DB ব্যবহার করে চলতে থাকে — Redis কখনো single point of failure না।

let Redis;
try {
  Redis = require('ioredis');
} catch (e) {
  Redis = null;
}

const REDIS_ENABLED = String(process.env.REDIS_ENABLED || 'true').toLowerCase() !== 'false';
const REDIS_URL = process.env.REDIS_URL || '';
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = parseInt(process.env.REDIS_DB || '0', 10);
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'livo:';
const REDIS_CONNECT_TIMEOUT_MS = parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '3000', 10);

const state = {
  client: null,
  connected: false,
  lastError: null,
  lastErrorAt: null,
  disabledReason: null,
  lastLoggedErrorAt: 0
};

function log(...args) {
  console.log('[redis-cache]', ...args);
}

function logError(context, err) {
  state.lastError = err && err.message ? err.message : String(err);
  state.lastErrorAt = new Date();
  // প্রতি ৬০ সেকেন্ডে একবার লগ — ECONNREFUSED স্প্যাম বন্ধ
  const now = Date.now();
  if (now - state.lastLoggedErrorAt < 60000) return;
  state.lastLoggedErrorAt = now;
  console.error('[redis-cache] ' + context + ':', state.lastError);
}

function init() {
  if (!REDIS_ENABLED) {
    state.disabledReason = '.env-এ REDIS_ENABLED=false সেট করা আছে';
    log('disabled via .env (REDIS_ENABLED=false)');
    return;
  }
  if (!Redis) {
    state.disabledReason = 'ioredis প্যাকেজ ইনস্টল করা নেই';
    log('ioredis package not installed — caching disabled, falling back to DB only');
    return;
  }

  // প্রোডাকশনে REDIS_URL না থাকলে localhost-এ কানেক্ট করার চেষ্টা বন্ধ —
  // না হলে প্রতি কয়েক সেকেন্ডে ECONNREFUSED লগ স্প্যাম হয়
  const isProd = process.env.NODE_ENV === 'production';
  const hasExplicitHost = !!process.env.REDIS_HOST;
  if (!REDIS_URL && isProd && !hasExplicitHost) {
    state.disabledReason = 'REDIS_URL সেট করা নেই (production) — DB fallback';
    log('no REDIS_URL in production — caching disabled, falling back to DB only');
    return;
  }

  try {
    const options = REDIS_URL
      ? undefined
      : {
          host: REDIS_HOST,
          port: REDIS_PORT,
          password: REDIS_PASSWORD,
          db: REDIS_DB,
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => {
            if (times > 3) return null; // আর রিট্রাই না
            return Math.min(times * 500, 5000);
          },
          lazyConnect: false
        };

    state.client = REDIS_URL
      ? new Redis(REDIS_URL, {
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 5000))
        })
      : new Redis(options);

    state.client.on('connect', () => {
      state.connected = true;
      log('connected');
    });
    state.client.on('ready', () => { state.connected = true; });
    state.client.on('error', (err) => {
      state.connected = false;
      logError('connection error', err);
    });
    state.client.on('close', () => {
      state.connected = false;
    });
  } catch (err) {
    logError('init failed', err);
    state.client = null;
  }
}

init();

function isAvailable() {
  return !!(state.client && state.connected);
}

function prefixed(key) {
  return REDIS_PREFIX + key;
}

const stats = { hits: 0, misses: 0, sets: 0 };

async function get(key) {
  if (!isAvailable()) return null;
  try {
    const raw = await state.client.get(prefixed(key));
    if (raw === null || raw === undefined) { stats.misses++; return null; }
    stats.hits++;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch (err) {
    logError('get(' + key + ')', err);
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  if (!isAvailable()) return false;
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds) await state.client.set(prefixed(key), raw, 'EX', ttlSeconds);
    else await state.client.set(prefixed(key), raw);
    stats.sets++;
    return true;
  } catch (err) {
    logError('set(' + key + ')', err);
    return false;
  }
}

async function del(...keys) {
  if (!isAvailable() || !keys.length) return false;
  try {
    await state.client.del(...keys.map(prefixed));
    return true;
  } catch (err) {
    logError('del(' + keys.join(',') + ')', err);
    return false;
  }
}

async function flushAll() {
  return delByPattern('*');
}

async function getDetailedStats() {
  const base = {
    ...getStatus(),
    hits: stats.hits,
    misses: stats.misses,
    sets: stats.sets,
    hitRatePercent: (stats.hits + stats.misses) > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : null,
    totalKeys: 0,
    memoryUsed: null,
    categories: []
  };
  if (!isAvailable()) return base;

  try {
    const categoryPatterns = {
      'ম্যাচ/অডস (matches, markets)': 'match:*',
      'API ক্যাশ (matches/leaderboard/tournaments)': 'api:*',
      'লিডারবোর্ড': 'leaderboard:*',
      'প্রোফাইল অ্যাক্টিভিটি': 'profile:*',
      'হোমপেজ গেমস': 'homepage:*',
      'সাইট সেটিংস': 'settings:*',
      'IP নিয়ম': 'ip_rule:*',
      'পাসওয়ার্ড রিসেট টোকেন': 'reset_token:*',
      'রেট-লিমিট কাউন্টার': 'rl:*'
    };
    let totalKeys = 0;
    const categories = [];
    for (const [label, pattern] of Object.entries(categoryPatterns)) {
      let cursor = '0', count = 0;
      do {
        const [next, keys] = await state.client.scan(cursor, 'MATCH', prefixed(pattern), 'COUNT', 200);
        cursor = next;
        count += keys.length;
      } while (cursor !== '0');
      if (count > 0) categories.push({ label, pattern, count });
      totalKeys += count;
    }
    base.totalKeys = totalKeys;
    base.categories = categories;

    try {
      const info = await state.client.info('memory');
      const match = info.match(/used_memory_human:(\S+)/);
      if (match) base.memoryUsed = match[1].trim();
    } catch (e) {}
  } catch (err) {
    logError('getDetailedStats', err);
  }
  return base;
}

async function delByPattern(pattern) {
  if (!isAvailable()) return 0;
  try {
    let cursor = '0';
    let deleted = 0;
    const fullPattern = prefixed(pattern);
    do {
      const [nextCursor, keys] = await state.client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length) {
        await state.client.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
    return deleted;
  } catch (err) {
    logError('delByPattern(' + pattern + ')', err);
    return 0;
  }
}

async function getOrSet(key, ttlSeconds, fetchFn) {
  const cached = await get(key);
  if (cached !== null) return cached;
  const fresh = await fetchFn();
  set(key, fresh, ttlSeconds).catch(() => {});
  return fresh;
}

function getStatus() {
  return {
    enabled: REDIS_ENABLED && !!Redis && !state.disabledReason,
    connected: isAvailable(),
    host: REDIS_URL ? '(REDIS_URL)' : `${REDIS_HOST}:${REDIS_PORT}`,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    disabledReason: state.disabledReason
  };
}

async function incrWithExpiry(key, windowSeconds) {
  if (!isAvailable()) return null;
  try {
    const fullKey = prefixed(key);
    const count = await state.client.incr(fullKey);
    if (count === 1) await state.client.expire(fullKey, windowSeconds);
    const ttl = await state.client.ttl(fullKey);
    return { count, ttlMs: ttl > 0 ? ttl * 1000 : windowSeconds * 1000 };
  } catch (err) {
    logError('incrWithExpiry(' + key + ')', err);
    return null;
  }
}

async function resetKey(key) {
  return del(key);
}

module.exports = { get, set, del, delByPattern, getOrSet, isAvailable, getStatus, incrWithExpiry, resetKey, flushAll, getDetailedStats };
