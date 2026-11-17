'use strict';
// Render/হোস্টিং ড্যাশবোর্ডে ভ্যালু কোটসহ ("rediss://...") বা স্কিম ছাড়া বসালে ioredis সেটাকে
// unix-socket পাথ ধরে ENOENT দেয়। এখানে বুটের শুরুতেই REDIS_URL / CACHE_REDIS_URL ঠিক করা হয়:
//   - আশেপাশের স্পেস ও '"' / ''' / %22 ছাঁটা
//   - স্কিম না থাকলে (user:pass@host:port) *.upstash.io-র জন্য rediss://, বাকিদের জন্য redis:// বসানো
// কখনো পাসওয়ার্ড লগ করে না।
const KEYS = ['REDIS_URL', 'CACHE_REDIS_URL'];

function normalizeRedisUrl(raw) {
  if (typeof raw !== 'string') return raw;
  let v = raw.trim();
  v = v.replace(/^(?:["']|%22)+/i, '').replace(/(?:["']|%22)+$/i, '').trim();
  if (!v) return '';
  if (!/^rediss?:\/\//i.test(v)) {
    const p = v.replace(/^\/\//, '');
    const host = (p.split('@').pop() || '').split(':')[0].toLowerCase();
    v = (/\.upstash\.io$/.test(host) ? 'rediss://' : 'redis://') + p;
  }
  return v;
}

function normalizeRedisEnv(env = process.env) {
  const changed = [];
  for (const k of KEYS) {
    if (env[k] === undefined) continue;
    const fixed = normalizeRedisUrl(env[k]);
    if (fixed !== env[k]) { env[k] = fixed; changed.push(k); }
  }
  if (changed.length) console.warn(`[redis-env] ${changed.join(', ')} ফরম্যাট ঠিক করা হয়েছে — ড্যাশবোর্ডে কোট ছাড়া rediss://user:pass@host:port দিন`);
  return changed;
}

module.exports = { normalizeRedisUrl, normalizeRedisEnv };
