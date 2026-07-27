// middleware/redisRateLimitStore.js
// ==================== express-rate-limit-এর জন্য Redis-backed Store ====================
// এটা ছাড়া প্রতিটা rate limiter ডিফল্ট MemoryStore ব্যবহার করে — মানে একাধিক
// অ্যাপ ইনস্ট্যান্স (একাধিক কন্টেইনার/প্রসেস) চললে প্রতিটার নিজস্ব আলাদা কাউন্টার থাকে,
// ফলে সাইটওয়াইড লিমিট আসলে (ইনস্ট্যান্স সংখ্যা × max) হয়ে যায় — production-এ এটা
// রেট-লিমিটকে কার্যত অকার্যকর করে দেয়।
//
// এই স্টোর সব ইনস্ট্যান্স জুড়ে একটাই শেয়ার্ড Redis কাউন্টার ব্যবহার করে। Redis ডাউন/অনুপলব্ধ
// থাকলে (এই কোডবেসের বাকি সব জায়গার মতোই) কখনো ক্র্যাশ না করে প্রতি-ইনস্ট্যান্স ইন-মেমরি
// ফলব্যাকে চলে যায় — Redis কখনো single point of failure না।

const cache = require('../services/cache');

class RedisRateLimitStore {
  constructor(prefix = 'rl:') {
    this.prefix = prefix;
    this.windowMs = 60 * 1000;
    this.localMap = new Map(); // Redis অনুপলব্ধ হলে ফলব্যাক (fail-safe, fail-open না)
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  fullKey(key) {
    return this.prefix + key;
  }

  _localIncrement(key) {
    const now = Date.now();
    const entry = this.localMap.get(key);
    if (!entry || entry.resetTime <= now) {
      const resetTime = now + this.windowMs;
      this.localMap.set(key, { count: 1, resetTime });
      return { totalHits: 1, resetTime: new Date(resetTime) };
    }
    entry.count += 1;
    return { totalHits: entry.count, resetTime: new Date(entry.resetTime) };
  }

  _localDecrement(key) {
    const entry = this.localMap.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  _localReset(key) {
    this.localMap.delete(key);
  }

  async increment(key) {
    const client = cache.getRawClient();
    if (!client) return this._localIncrement(key);

    try {
      const redisKey = this.fullKey(key);
      const multi = client.multi();
      multi.incr(redisKey);
      multi.pttl(redisKey);
      const results = await multi.exec();
      if (!results) return this._localIncrement(key);

      const totalHits = results[0][1];
      let ttl = results[1][1];

      if (totalHits === 1 || ttl < 0) {
        await client.pexpire(redisKey, this.windowMs);
        ttl = this.windowMs;
      }

      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch (err) {
      console.error('[redisRateLimitStore] increment ব্যর্থ, লোকাল ফলব্যাকে যাচ্ছে:', err.message);
      return this._localIncrement(key);
    }
  }

  async decrement(key) {
    const client = cache.getRawClient();
    if (!client) return this._localDecrement(key);
    try {
      await client.decr(this.fullKey(key));
    } catch (err) { /* non-fatal */ }
  }

  async resetKey(key) {
    const client = cache.getRawClient();
    if (!client) return this._localReset(key);
    try {
      await client.del(this.fullKey(key));
    } catch (err) { /* non-fatal */ }
  }
}

/** প্রতিটা limiter-এর জন্য নিজস্ব prefix সহ আলাদা store — যাতে একটার কাউন্টার আরেকটার সাথে না মিশে যায়। */
function createRedisStore(name) {
  return new RedisRateLimitStore(`rl:${name}:`);
}

module.exports = { createRedisStore };
