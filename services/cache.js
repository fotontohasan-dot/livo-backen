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
// ক্যাশ + রেট-লিমিট আলাদা (allkeys-lru) Redis-এ যায়: CACHE_REDIS_URL, না থাকলে REDIS_URL-এ ফলব্যাক।
// সেশন ও কিউ (noeviction) আলাদাভাবে শুধু REDIS_URL ব্যবহার করে — app.js, queues/connection.js।
const REDIS_URL = process.env.CACHE_REDIS_URL || process.env.REDIS_URL || '';
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = parseInt(process.env.REDIS_DB || '0', 10);
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'bet420:';
const REDIS_CONNECT_TIMEOUT_MS = parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '3000', 10);
// Redis ডাউন হলে কখনো হাল ছাড়া হয় না: exponential backoff (BASE থেকে শুরু, দ্বিগুণ হয়ে CAP পর্যন্ত) + jitter,
// অনির্দিষ্টকাল রিট্রাই। Redis ফিরলে অ্যাপ রিস্টার্ট ছাড়াই ক্যাশ নিজে থেকে ফিরে আসে।
const REDIS_RETRY_BASE_MS = parseInt(process.env.REDIS_RETRY_BASE_MS || '500', 10);
const REDIS_RETRY_CAP_MS = parseInt(process.env.REDIS_RETRY_CAP_MS || '30000', 10);
// Redis ডাউন থাকলে getOrSet সরাসরি DB-তে পড়ে (fail-open) — DB যাতে ভেসে না যায় সেজন্য এই প্রসেসের ভেতরে ছোট সীমা:
//   ১) একই key-এর একযোগে কল একটাই DB কোয়েরি ভাগ করে (single-flight)
//   ২) ছোট in-process ক্যাশ (সর্বোচ্চ LOCAL_TTL সেকেন্ড, LOCAL_MAX এন্ট্রি) — শুধু Redis ডাউন থাকাকালীন
//   ৩) একসাথে সর্বোচ্চ FALLTHROUGH_CONCURRENCY টা DB কোয়েরি; বাকিরা সারিতে অপেক্ষা করে (সারি ভরলে shed)
const FALLTHROUGH_CONCURRENCY = Math.max(1, parseInt(process.env.CACHE_FALLTHROUGH_CONCURRENCY || '4', 10));
const FALLTHROUGH_QUEUE_MAX = Math.max(1, parseInt(process.env.CACHE_FALLTHROUGH_QUEUE_MAX || '1000', 10));
const LOCAL_TTL_SECONDS = parseInt(process.env.CACHE_LOCAL_FALLBACK_TTL_SECONDS || '5', 10);
const LOCAL_MAX = parseInt(process.env.CACHE_LOCAL_FALLBACK_MAX || '500', 10);

const state = {
  client: null,
  connected: false,
  lastError: null,
  lastErrorAt: null,
  disabledReason: null,
  disconnectedAt: null,
  reconnects: 0,
  fallthroughShed: 0,
  hits: 0,
  misses: 0,
  sets: 0
};

// admin/cache.ejs-এ দেখানো ক্যাটাগরি ব্রেকডাউনের জন্য — আসল কোডে ব্যবহৃত key prefix-গুলোর তালিকা।
const CACHE_CATEGORIES = [
  { label: 'সাইট সেটিংস', pattern: 'settings:*' },
  { label: 'Feature Flags', pattern: 'feature_flags:*' },
  { label: 'ম্যাচ/অডস', pattern: 'matches:*' },
  { label: 'হোমপেজ', pattern: 'homepage:*' },
  { label: 'লিডারবোর্ড', pattern: 'leaderboard:*' },
  { label: 'প্রোফাইল অ্যাক্টিভিটি', pattern: 'profile:*' },
  { label: 'ওয়ালেট স্ট্যাটস', pattern: 'wallet:*' },
  { label: 'নোটিফিকেশন', pattern: 'notif:*' },
  { label: 'RBAC রোল', pattern: 'role:*' },
  { label: 'IP রুলস', pattern: 'ip_rule:*' },
  { label: 'পাবলিক API', pattern: 'api:*' },
  { label: 'পাসওয়ার্ড রিসেট টোকেন', pattern: 'reset_token:*' },
  { label: 'রেট-লিমিট কাউন্টার', pattern: 'rl:*' }
];

function log(...args) {
  console.log('[redis-cache]', ...args);
}

function logError(context, err) {
  state.lastError = err && err.message ? err.message : String(err);
  state.lastErrorAt = new Date();
  console.error('[redis-cache] ' + context + ':', state.lastError);
}

/** attempt (১ থেকে শুরু) → মিলিসেকেন্ড: BASE * 2^(attempt-1), CAP-এ সীমাবদ্ধ, ±২০% jitter (সব ইনস্ট্যান্স একসাথে ঝাঁপিয়ে পড়া এড়াতে)। */
function computeBackoffMs(attempt, base = REDIS_RETRY_BASE_MS, cap = REDIS_RETRY_CAP_MS, rand = Math.random) {
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = exp * 0.2 * (rand() * 2 - 1);
  return Math.max(base, Math.min(cap, Math.round(exp + jitter)));
}

// ---- Redis ডাউন থাকাকালীন DB-সুরক্ষা (single-flight + ছোট লোকাল ক্যাশ + কনকারেন্সি সীমা) ----
const localFallback = new Map(); // key -> { value, expires }
const inflight = new Map();      // key -> Promise
let fallthroughActive = 0;
const fallthroughWaiters = [];

function acquireFallthroughSlot() {
  if (fallthroughActive < FALLTHROUGH_CONCURRENCY) {
    fallthroughActive++;
    return Promise.resolve();
  }
  if (fallthroughWaiters.length >= FALLTHROUGH_QUEUE_MAX) {
    state.fallthroughShed++;
    return Promise.reject(new Error('cache fallthrough overloaded (Redis down) — request shed'));
  }
  return new Promise((resolve) => fallthroughWaiters.push(resolve));
}

function releaseFallthroughSlot() {
  const next = fallthroughWaiters.shift();
  if (next) next(); // স্লট সরাসরি পরের অপেক্ষমাণকে হস্তান্তর (active সংখ্যা অপরিবর্তিত)
  else fallthroughActive--;
}

async function guardedFallthrough(key, ttlSeconds, fetchFn) {
  const hit = localFallback.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) localFallback.delete(key);

  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    await acquireFallthroughSlot();
    try {
      const value = await fetchFn();
      const ttl = Math.min(LOCAL_TTL_SECONDS, ttlSeconds || LOCAL_TTL_SECONDS);
      if (ttl > 0 && value !== undefined && value !== null) {
        if (localFallback.size >= LOCAL_MAX) localFallback.delete(localFallback.keys().next().value);
        localFallback.set(key, { value, expires: Date.now() + ttl * 1000 });
      }
      return value;
    } finally {
      releaseFallthroughSlot();
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
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
    // times আসে ioredis থেকে (পরপর কতবার রিট্রাই হয়েছে)। কখনো null রিটার্ন করা হয় না — অনির্দিষ্টকাল রিট্রাই।
    const infiniteRetryStrategy = (times) => {
      const delay = computeBackoffMs(times);
      if (times === 1 || times % 10 === 0) {
        log(`reconnect attempt #${times} in ${delay}ms (cache falls through to DB meanwhile)`);
      }
      return delay;
    };

    const options = REDIS_URL
      ? undefined
      : {
          host: REDIS_HOST,
          port: REDIS_PORT,
          password: REDIS_PASSWORD,
          db: REDIS_DB,
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
          maxRetriesPerRequest: 1,
          retryStrategy: infiniteRetryStrategy,
          lazyConnect: false
        };

    state.client = REDIS_URL
      ? new Redis(REDIS_URL, { connectTimeout: REDIS_CONNECT_TIMEOUT_MS, maxRetriesPerRequest: 1, retryStrategy: infiniteRetryStrategy })
      : new Redis(options);

    state.client.on('connect', () => {
      log('connected');
    });
    state.client.on('ready', () => {
      if (state.disconnectedAt) {
        state.reconnects++;
        log(`reconnected after ${Math.round((Date.now() - state.disconnectedAt) / 1000)}s downtime — cache active again`);
        state.disconnectedAt = null;
      }
      state.connected = true;
      state.disabledReason = null;
      localFallback.clear(); // Redis ফিরে এসেছে — আউটেজের সময়কার in-process কপি ফেলে দেওয়া হয়
    });
    // ব্যর্থ প্রতিটা রিট্রাইয়ে error ইভেন্ট আসে; শুধু প্রথমটা লগ হয় (ডাউনটাইম শুরু) — পরেরগুলো লগ স্প্যাম করবে না
    state.client.on('error', (err) => {
      state.connected = false;
      if (!state.disconnectedAt) {
        state.disconnectedAt = Date.now();
        logError('connection error (will retry forever with backoff)', err);
      } else {
        state.lastError = err && err.message ? err.message : String(err);
        state.lastErrorAt = new Date();
      }
    });
    state.client.on('close', () => {
      if (state.connected && !state.disconnectedAt) {
        state.disconnectedAt = Date.now();
        log('connection closed — retrying with backoff');
      }
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

// middleware/redisRateLimitStore.js এই ফাংশন দিয়ে raw ioredis ক্লায়েন্ট নেয় atomic
// multi/incr/pexpire অপারেশনের জন্য — Redis অনুপলব্ধ হলে null রিটার্ন করে, caller নিজেই
// in-memory ফলব্যাকে চলে যায়।
function getRawClient() {
  return isAvailable() ? state.client : null;
}

function prefixed(key) {
  return REDIS_PREFIX + key;
}

/** ক্যাশ থেকে মান পড়ে (JSON parse সহ)। Redis না থাকলে/এরর হলে null রিটার্ন করে — কখনো throw করে না। */
async function get(key) {
  if (!isAvailable()) return null;
  try {
    const raw = await state.client.get(prefixed(key));
    if (raw === null || raw === undefined) {
      state.misses++;
      return null;
    }
    state.hits++;
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
    state.sets++;
    return true;
  } catch (err) {
    logError('set(' + key + ')', err);
    return false;
  }
}

/** নির্দিষ্ট key(s) মুছে ফেলে — আপডেটের পর ক্যাশ invalidate করতে ব্যবহার হয়। */
async function del(...keys) {
  for (const k of keys) localFallback.delete(k); // আউটেজের সময়কার in-process কপিও বাতিল
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
  if (localFallback.size) {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const k of [...localFallback.keys()]) if (re.test(k)) localFallback.delete(k);
  }
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
  // Redis কনফিগার করা আছে কিন্তু এখন ডাউন: fail-open (DB-তে পড়ো), কিন্তু in-process সীমার ভেতর দিয়ে — DB flood এড়াতে।
  // Redis বন্ধ/অকনফিগার্ড (state.client নেই) হলে আগের মতোই সরাসরি fetchFn — কোনো ক্যাশিং/থ্রটলিং নয়।
  if (state.client && !isAvailable()) return guardedFallthrough(key, ttlSeconds, fetchFn);
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
    host: REDIS_URL ? (process.env.CACHE_REDIS_URL ? '(CACHE_REDIS_URL)' : '(REDIS_URL)') : `${REDIS_HOST}:${REDIS_PORT}`,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    disabledReason: state.disabledReason,
    reconnects: state.reconnects,
    downSince: state.disconnectedAt ? new Date(state.disconnectedAt) : null,
    fallthroughActive,
    fallthroughQueued: fallthroughWaiters.length,
    fallthroughShed: state.fallthroughShed
  };
}

/** এই অ্যাপের সব Redis key যে prefix ব্যবহার করে (REDIS_PREFIX) — কোনো caller-কে নিজে
 * prefix জোড়া লাগাতে হলে (যেমন raw client দিয়ে সরাসরি কাজ করার সময়) এটা দিয়ে সামঞ্জস্যপূর্ণভাবে
 * করা উচিত, নাহলে সেই key admin cache stats/clear-এর মতো prefix-নির্ভর টুলে অদৃশ্য থেকে যায়। */
function prefixKey(key) {
  return prefixed(key);
}

async function countKeys(pattern) {
  if (!isAvailable()) return 0;
  try {
    let cursor = '0';
    let count = 0;
    const fullPattern = prefixed(pattern);
    do {
      const [nextCursor, keys] = await state.client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 200);
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  } catch (err) {
    logError('countKeys(' + pattern + ')', err);
    return 0;
  }
}

/** admin/cache.ejs-এর জন্য বিস্তারিত ক্যাশ স্ট্যাটাস — মোট key সংখ্যা, ক্যাটাগরি-ভিত্তিক ব্রেকডাউন,
 * hit/miss/write কাউন্টার (এই প্রসেসের আয়ুষ্কাল ধরে) ও আনুমানিক মেমরি ব্যবহার। */
async function getDetailedStats() {
  const base = getStatus();
  if (!isAvailable()) {
    return { ...base, totalKeys: 0, categories: [], hits: state.hits, misses: state.misses, sets: state.sets, hitRatePercent: null, memoryUsed: null };
  }
  try {
    const categories = [];
    let totalKeys = 0;
    for (const cat of CACHE_CATEGORIES) {
      const count = await countKeys(cat.pattern);
      categories.push({ label: cat.label, pattern: cat.pattern, count });
      totalKeys += count;
    }
    let memoryUsed = null;
    try {
      const info = await state.client.info('memory');
      const match = /used_memory_human:(\S+)/.exec(info);
      if (match) memoryUsed = match[1];
    } catch { /* non-fatal, memory info is best-effort */ }
    const totalRequests = state.hits + state.misses;
    const hitRatePercent = totalRequests > 0 ? Math.round((state.hits / totalRequests) * 100) : null;
    return { ...base, totalKeys, categories, hits: state.hits, misses: state.misses, sets: state.sets, hitRatePercent, memoryUsed };
  } catch (err) {
    logError('getDetailedStats', err);
    return { ...base, totalKeys: 0, categories: [], hits: state.hits, misses: state.misses, sets: state.sets, hitRatePercent: null, memoryUsed: null };
  }
}

/** এই অ্যাপের নিজের সব Redis key মুছে ফেলে (শুধু REDIS_PREFIX-এর আওতায় থাকা key — একই Redis
 * ইনস্ট্যান্স শেয়ার করা অন্য সিস্টেমের (যেমন BullMQ queue) ডেটা কখনো ছোঁয় না)। */
async function flushAll() {
  return delByPattern('*');
}

async function incrWithExpiry(key, ttlSeconds) {
  if (!isAvailable()) return null;
  try {
    const fullKey = prefixed(key);
    const count = await state.client.incr(fullKey);
    if (count === 1) await state.client.expire(fullKey, ttlSeconds);
    const ttl = await state.client.ttl(fullKey);
    return { count, ttl: ttl > 0 ? ttl : ttlSeconds };
  } catch (err) {
    logError('incrWithExpiry', err);
    return null;
  }
}


/**
 * Rate-limit কাউন্টার ১ কমায় (০-এর নিচে নামে না)। Redis অনুপলব্ধ/এরর হলে null — কখনো throw করে না।
 * services/redisRateLimitStore.js-এর decrement() ব্যবহার করে: সফল লগইন যেন ব্যর্থ-চেষ্টার বাজেট খরচ না করে।
 */
async function decrFloor(key) {
  if (!isAvailable()) return null;
  try {
    const fullKey = prefixed(key);
    const n = await state.client.decr(fullKey);
    if (n < 0) { await state.client.set(fullKey, 0, 'KEEPTTL'); return 0; }
    return n;
  } catch (err) {
    logError('decrFloor', err);
    return null;
  }
}

/** নির্দিষ্ট rate-limit key রিসেট করে (services/redisRateLimitStore.js ব্যবহার করে)। Redis অনুপলব্ধ হলে/এরর হলে silently ignore করে — কখনো throw করে না। */
async function resetKey(key) {
  if (!isAvailable()) return false;
  try {
    await state.client.del(prefixed(key));
    return true;
  } catch (err) {
    logError('resetKey(' + key + ')', err);
    return false;
  }
}

/** গ্রেসফুল শাটডাউন/টেস্টের জন্য: ক্লায়েন্ট বন্ধ করে (রিট্রাই থামে)। */
async function close() {
  const c = state.client;
  state.client = null;
  state.connected = false;
  if (!c) return;
  try { await c.quit(); } catch (_) { c.disconnect(); }
}

module.exports = { close, computeBackoffMs, get, set, del, delByPattern, getOrSet, isAvailable, getStatus, incrWithExpiry, decrFloor, getRawClient, resetKey, getDetailedStats, flushAll, prefixKey };
