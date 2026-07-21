// services/redisRateLimitStore.js
// ---------------------------------------------------------------------------
// express-rate-limit-এর জন্য কাস্টম Store — Redis দিয়ে সব সার্ভার ইনস্ট্যান্স জুড়ে শেয়ার্ড
// রেট-লিমিট কাউন্ট রাখে (একাধিক Render instance থাকলেও সঠিকভাবে কাজ করে)।
// Redis ডাউন/অনুপলব্ধ থাকলে প্রতিটা key স্বয়ংক্রিয়ভাবে in-memory Map-এ fallback করে —
// অর্থাৎ রেট-লিমিটিং চালু থাকে (per-instance হিসেবে), কিন্তু কখনো রিকোয়েস্ট ব্যর্থ/ব্লক করে না।
// ---------------------------------------------------------------------------

const cache = require('./cache');

class RedisRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix || 'rl:';
    this.windowMs = 60 * 1000; // express-rate-limit init()-এ আসল ভ্যালু বসিয়ে দেবে
    this.memory = new Map(); // key -> { count, resetAt } — Redis অনুপলব্ধ হলে fallback
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  _memoryIncr(key) {
    const now = Date.now();
    const rec = this.memory.get(key);
    if (!rec || rec.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + this.windowMs };
      this.memory.set(key, fresh);
      return { totalHits: 1, resetTime: new Date(fresh.resetAt) };
    }
    rec.count += 1;
    return { totalHits: rec.count, resetTime: new Date(rec.resetAt) };
  }

  async increment(key) {
    const fullKey = this.prefix + key;
    const windowSeconds = Math.ceil(this.windowMs / 1000);
    const result = await cache.incrWithExpiry(fullKey, windowSeconds);
    if (result === null) {
      // Redis অনুপলব্ধ — নিরবে in-memory fallback-এ চলে যাচ্ছে, রিকোয়েস্ট আটকাচ্ছে না
      return this._memoryIncr(key);
    }
    return { totalHits: result.count, resetTime: new Date(Date.now() + result.ttlMs) };
  }

  async decrement(key) {
    // সফল রিকোয়েস্টে কাউন্ট কমানোর দরকার নেই এই অ্যাপের কোনো লিমিটারে (skipSuccessfulRequests ব্যবহার হয় না),
    // তাই এখানে no-op রাখা হলো — ভবিষ্যতে দরকার হলে cache.client.decr যোগ করা যাবে
  }

  async resetKey(key) {
    this.memory.delete(key);
    await cache.resetKey(this.prefix + key);
  }
}

module.exports = RedisRateLimitStore;
