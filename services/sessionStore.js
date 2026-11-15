// services/sessionStore.js
// Redis সেশন-স্টোর ফ্যাক্টরি (app.js থেকে বের করা, যাতে আসল Redis-এ আলাদাভাবে টেস্ট করা যায়)।
//
// কেন অ্যাডাপ্টার: connect-redis ১০ node-redis v4/v5 স্টাইলের ক্লায়েন্ট আশা করে
// (set(key, val, { expiration: { type:'EX', value } }), del([keys]), mGet, scanIterator)।
// ioredis সেই অবজেক্ট-আর্গুমেন্ট সরাসরি Redis কমান্ডে পাঠায় → "ERR syntax error"।
// অ্যাডাপ্টার শুধু কল অনুবাদ করে; স্টোর করা ফরম্যাট (JSON, key prefix, EX TTL) অপরিবর্তিত।
const { RedisStore } = require('connect-redis');
const Redis = require('ioredis');

function adaptIoredis(c) {
  return {
    get: (key) => c.get(key),
    set: (key, val, opts) => {
      const exp = opts && opts.expiration;
      if (exp && exp.type && exp.value != null) return c.set(key, val, exp.type, exp.value);
      return c.set(key, val);
    },
    expire: (key, seconds) => c.expire(key, seconds),
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

module.exports = { createRedisSessionStore, adaptIoredis };
