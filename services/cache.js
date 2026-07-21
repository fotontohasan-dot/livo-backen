// services/cache.js
// Redis ক্যাশ লেয়ার — সাইট সেটিংস, হোমপেজ ডেটা, প্রোফাইল, লিডারবোর্ড ইত্যাদির জন্য।
// Redis অনুপলব্ধ থাকলে (ডাউন / কনফিগার্ড না থাকলে) পুরো সিস্টেম কোনো এরর ছাড়াই
// সরাসরি DB ব্যবহার করে চলতে থাকে — Redis কখনো single point of failure না।

let Redis;
try {
  Redis = require('ioredis');
} catch (e) {
  Redis = null; // প্যাকেজ ইনস্টল করা না থাকলেও অ্যাপ ক্র্যাশ করবে না, শুধু ক্যাশিং বন্ধ থাকবে
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
  disabledReason: null
};

function log(...args) {
  console.log('[redis-cache]', ...args);
}

function logError(context, err) {
  state.lastError = err && err.message ? err.message : String(err);
  state.lastErrorAt = new Date();
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
          retryStrategy: (times) => Math.min(times * 500, 5000),
          lazyConnect: false
        };

    state.client = REDIS_URL
      ? new Redis(REDIS_URL, { connectTimeout: REDIS_CONNECT_TIMEOUT_MS, maxRetriesPerRequest: 1, retryStrategy: (times) => Math.min(times * 500, 5000) })
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

/** ক্যাশ থেকে মান পড়ে (JSON parse সহ)। Redis না থাকলে/এরর হলে null রিটার্ন করে — কখনো throw করে না। */
async function get(key) {
  if (!isAvailable()) return null;
  try {
    const raw = await state.client.get(prefixed(key));
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch (err) {
    logError('get(' + key + ')', err);
    return null;
  }
}

/** ক্যাশে মান লেখে (JSON stringify সহ), TTL সেকেন্ডে। ব্যর্থ হলে silently ignore করে। */
async function set(key, value, ttlSeconds) {
  if (!isAvailable()) return false;
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds) await state.client.set(prefixed(key), raw, 'EX', ttlSeconds);
    else await state.client.set(prefixed(key), raw);
    return true;
  } catch (err) {
    logError('set(' + key + ')', err);
    return false;
  }
}

/** নির্দিষ্ট key(s) মুছে ফেলে — আপডেটের পর ক্যাশ invalidate করতে ব্যবহার হয়। */
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

/** prefix-ভিত্তিক bulk invalidate (যেমন 'profile:*') — SCAN ব্যবহার করে, KEYS ব্যবহার করে না (production-safe, ব্লক করে না)। */
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

/**
 * ক্যাশ-অ্যাসাইড হেল্পার: ক্যাশে থাকলে সরাসরি রিটার্ন করে, না থাকলে fetchFn() চালিয়ে
 * ফলাফল ক্যাশে বসিয়ে রিটার্ন করে। Redis সম্পূর্ণ ডাউন থাকলেও fetchFn() সবসময় চলে —
 * অর্থাৎ ফিচারটি কখনো ভাঙে না, শুধু ক্যাশের সুবিধা পাওয়া যায় না।
 */
async function getOrSet(key, ttlSeconds, fetchFn) {
  const cached = await get(key);
  if (cached !== null) return cached;
  const fresh = await fetchFn();
  set(key, fresh, ttlSeconds).catch(() => {}); // ফলাফল ফেরত দেওয়ার গতি ক্যাশ-রাইটের জন্য আটকানো হয় না
  return fresh;
}

function getStatus() {
  return {
    enabled: REDIS_ENABLED && !!Redis,
    connected: isAvailable(),
    host: REDIS_URL ? '(REDIS_URL)' : `${REDIS_HOST}:${REDIS_PORT}`,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    disabledReason: state.disabledReason
  };
}

/**
 * Rate limiting-এর জন্য atomic counter — key না থাকলে ১ থেকে শুরু করে windowSeconds পর expire হয়ে যায়,
 * থাকলে শুধু বাড়ায় (TTL অপরিবর্তিত থাকে)। একাধিক সার্ভার ইনস্ট্যান্স জুড়ে শেয়ার্ড রেট-লিমিট কাউন্টের জন্য দরকার।
 * Redis অনুপলব্ধ থাকলে null রিটার্ন করে — caller-কে তখন in-memory fallback ব্যবহার করতে হবে।
 */
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

/** নির্দিষ্ট rate-limit key রিসেট করার জন্য (যেমন সফল লগইনের পর failed-attempt কাউন্টার মুছে ফেলা)। */
async function resetKey(key) {
  return del(key);
}

module.exports = { get, set, del, delByPattern, getOrSet, isAvailable, getStatus, incrWithExpiry, resetKey };
