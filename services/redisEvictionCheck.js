// services/redisEvictionCheck.js
// ---------------------------------------------------------------------------
// বুটে একবার Redis-এর maxmemory-policy যাচাই করে সতর্কতা লগ করে।
//
// কেন: সেশন (`livo:sess:`) ও BullMQ কিউ (`bull:`) REDIS_URL-এ থাকে। সেখানে eviction চালু
// (allkeys-lru ইত্যাদি) থাকলে মেমরি ভরলে Redis সেশন/কিউ কী নীরবে মুছে দিতে পারে — ব্যবহারকারী
// হঠাৎ লগআউট হয়, জব হারায়। তাই এই ইনস্ট্যান্সে `noeviction` প্রত্যাশিত। ক্যাশ/রেট-লিমিট আলাদা
// (allkeys-lru) ইনস্ট্যান্সে CACHE_REDIS_URL দিয়ে যায় (services/cache.js)।
//
// নিয়ম:
//   • শুধু সতর্কতা — বুট কখনো আটকায় না, কখনো throw করে না।
//   • policy ≠ noeviction → শুধু policy-র নাম লগে (কোনো URL/সিক্রেট/হোস্ট নয়)।
//   • CONFIG নিষিদ্ধ বা ব্যর্থ (যেমন Upstash) → নীরবে এড়ানো।
//   • REDIS_URL ও CACHE_REDIS_URL একই মান হলে আলাদা সতর্কতা (একই ইনস্ট্যান্সে সেশন/কিউ ও
//     ক্যাশ মিশে যায়, তাই noeviction আর allkeys-lru দুটো একসাথে সত্যি হতে পারে না)।
// ---------------------------------------------------------------------------

const CHECK_TIMEOUT_MS = 3000;

function defaultCreateClient(url) {
  const Redis = require('ioredis');
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: CHECK_TIMEOUT_MS,
    retryStrategy: () => null // এক-শটের চেক: রিট্রাই নেই
  });
  client.on('error', () => {}); // ব্যর্থতা নীরবে এড়ানো হয় — error ইভেন্ট যেন unhandled না হয়
  return client;
}

// ioredis `CONFIG GET` → ['maxmemory-policy', 'noeviction']; অন্য ক্লায়েন্ট object দিতে পারে
function extractPolicy(reply) {
  if (Array.isArray(reply)) {
    const i = reply.indexOf('maxmemory-policy');
    return i >= 0 && typeof reply[i + 1] === 'string' ? reply[i + 1] : null;
  }
  if (reply && typeof reply === 'object' && typeof reply['maxmemory-policy'] === 'string') {
    return reply['maxmemory-policy'];
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]          ডিফল্ট process.env
 * @param {Function} [opts.createClient] (url) => ioredis-সদৃশ ক্লায়েন্ট (টেস্টে ইনজেক্ট)
 * @param {object} [opts.logger]       ডিফল্ট console (warn ব্যবহৃত)
 * @returns {Promise<{checked: boolean, policy: string|null, warned: string[]}>}
 */
async function checkRedisEvictionPolicy({ env = process.env, createClient = defaultCreateClient, logger = console } = {}) {
  const result = { checked: false, policy: null, warned: [] };
  try {
    if (String(env.REDIS_ENABLED || 'true').toLowerCase() === 'false') return result;
    const sessionUrl = env.REDIS_URL || '';
    if (!sessionUrl) return result;

    // ১) একই URL — সেশন/কিউ ও ক্যাশ একই ইনস্ট্যান্সে (URL নিজে কখনো লগ হয় না)
    if (env.CACHE_REDIS_URL && env.CACHE_REDIS_URL === sessionUrl) {
      logger.warn('⚠️ Redis: REDIS_URL ও CACHE_REDIS_URL একই ইনস্ট্যান্সে — সেশন/কিউ (noeviction প্রয়োজন) ও ক্যাশ/রেট-লিমিট (allkeys-lru) আলাদা Redis-এ রাখুন');
      result.warned.push('same-url');
    }

    // ২) maxmemory-policy (সেশন/কিউ ক্লায়েন্ট = REDIS_URL)
    let client = null;
    try {
      client = createClient(sessionUrl);
      if (typeof client.connect === 'function' && client.status !== 'ready') await withTimeout(client.connect(), CHECK_TIMEOUT_MS);
      const policy = extractPolicy(await withTimeout(client.config('GET', 'maxmemory-policy'), CHECK_TIMEOUT_MS));
      if (!policy) return result; // অচেনা উত্তর — নীরবে এড়ানো
      result.checked = true;
      result.policy = policy;
      if (policy !== 'noeviction') {
        logger.warn(`⚠️ Redis (সেশন/কিউ): maxmemory-policy="${policy}" — সেশন ও কিউ কী মুছে যেতে পারে; এই ইনস্ট্যান্সে noeviction প্রয়োজন`);
        result.warned.push('policy');
      }
    } catch (_) {
      // CONFIG নিষিদ্ধ (NOPERM/unknown command — Upstash ইত্যাদি), টাইমআউট বা সংযোগ ব্যর্থ — নীরবে এড়ানো
    } finally {
      if (client) {
        try { if (typeof client.disconnect === 'function') client.disconnect(); } catch (_) { /* best-effort */ }
      }
    }
  } catch (_) {
    // কোনো অবস্থাতেই বুট আটকানো যাবে না
  }
  return result;
}

module.exports = { checkRedisEvictionPolicy, extractPolicy };
