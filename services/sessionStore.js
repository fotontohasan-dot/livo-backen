// services/sessionStore.js
// Redis সেশন-স্টোর ফ্যাক্টরি (app.js থেকে বের করা, যাতে আসল Redis-এ আলাদাভাবে টেস্ট করা যায়)।
//
// কেন অ্যাডাপ্টার: connect-redis ১০ node-redis v4/v5 স্টাইলের ক্লায়েন্ট আশা করে
// (set(key, val, { expiration: { type:'EX', value } }), del([keys]), mGet, scanIterator)।
// ioredis সেই অবজেক্ট-আর্গুমেন্ট সরাসরি Redis কমান্ডে পাঠায় → "ERR syntax error"।
// অ্যাডাপ্টার শুধু কল অনুবাদ করে; স্টোর করা ফরম্যাট (JSON, key prefix, EX TTL) অপরিবর্তিত।
const { RedisStore } = require('connect-redis');
const Redis = require('ioredis');

// rolling:true হলে express-session প্রতি রিকোয়েস্টে store.touch() ডাকে → connect-redis প্রতিবার EXPIRE পাঠায়।
// SESSION_TOUCH_THROTTLE_S (ডিফল্ট ০ = বন্ধ) দিলে একই সেশনের EXPIRE সর্বোচ্চ এত সেকেন্ডে একবার যায়।
// সেশনের মেয়াদ ৩০ দিন, তাই ১ ঘণ্টা (৩৬০০) দেরি নিরাপদ; Redis কমান্ড প্রতি রিকোয়েস্টে ১টা কমে।
const TOUCH_THROTTLE_MS = Math.max(0, parseInt(process.env.SESSION_TOUCH_THROTTLE_S || '0', 10)) * 1000;
const touchedAt = new Map(); // key -> শেষ EXPIRE-এর সময়
const TOUCH_MAP_MAX = 20000;

function shouldSkipTouch(key) {
  if (TOUCH_THROTTLE_MS <= 0) return false;
  const now = Date.now();
  const last = touchedAt.get(key);
  if (last && now - last < TOUCH_THROTTLE_MS) return true;
  if (touchedAt.size >= TOUCH_MAP_MAX) {
    for (const [k, t] of touchedAt) if (now - t >= TOUCH_THROTTLE_MS) touchedAt.delete(k);
    if (touchedAt.size >= TOUCH_MAP_MAX) touchedAt.clear();
  }
  touchedAt.set(key, now);
  return false;
}

function adaptIoredis(c) {
  return {
    get: (key) => c.get(key),
    set: (key, val, opts) => {
      const exp = opts && opts.expiration;
      if (exp && exp.type && exp.value != null) return c.set(key, val, exp.type, exp.value);
      return c.set(key, val);
    },
    expire: (key, seconds) => (shouldSkipTouch(key) ? Promise.resolve(1) : c.expire(key, seconds)),
    del: (keys) => (Array.isArray(keys) ? (keys.length ? c.del(...keys) : 0) : c.del(keys)),
    mGet: (keys) => c.mget(...keys),
    // connect-redis: client.scanIterator({ MATCH, COUNT }) → keys-এর ব্যাচ yield করে
    scanIterator: ({ MATCH, COUNT } = {}) => (async function* () {
      let cursor = '0';
      do {
        const [next, keys] = await c.scan(cursor, 'MATCH', MATCH || '*', 'COUNT', COUNT || 100);
        cursor = next;
        if (keys.length) yield keys;
      } while (cursor !== '0');
    })()
  };
}

function createRedisSessionStore(url, { prefix = 'livo:sess:', ttl } = {}) {
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false });
  client.on('error', (err) => console.warn('[session-redis] error:', err.message));
  const opts = { client: adaptIoredis(client), prefix };
  if (ttl) opts.ttl = ttl;
  return { store: new RedisStore(opts), client };
}

// সক্রিয় স্টোরের রেজিস্ট্রি: সেশন বাতিলের কোড (deviceTracking) আগে শুধু Postgres user_sessions থেকে
// মুছত; Redis স্টোর সক্রিয় থাকলে বাতিল-করা সেশন বৈধ থেকে যেত। এখন সক্রিয় স্টোর থেকেও মোছা হয়।
let activeStore = null;
function setActiveSessionStore(store) { activeStore = store || null; }
function getActiveSessionStore() { return activeStore; }
function destroySessionById(sid) {
  return new Promise((resolve) => {
    if (!activeStore || typeof activeStore.destroy !== 'function' || !sid) return resolve(false);
    try { activeStore.destroy(sid, (err) => resolve(!err)); } catch (e) { resolve(false); }
  });
}

module.exports = { shouldSkipTouch, createRedisSessionStore, adaptIoredis, setActiveSessionStore, getActiveSessionStore, destroySessionById };
