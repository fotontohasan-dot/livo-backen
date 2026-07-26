// services/queue/connection.js
// BullMQ-এর জন্য ioredis connection।
// Redis না থাকলে বা ডাউন হলে Queue সাইলেন্টলি নিষ্ক্রিয় হয়ে যায় — অ্যাপ ক্র্যাশ করে না।

const IORedis = require('ioredis');

const REDIS_URL     = process.env.REDIS_URL     || '';
const REDIS_HOST    = process.env.REDIS_HOST    || '127.0.0.1';
const REDIS_PORT    = parseInt(process.env.REDIS_PORT  || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB      = parseInt(process.env.REDIS_DB   || '1', 10); // cache=0, queue=1 (আলাদা DB)

const REDIS_ENABLED = String(process.env.REDIS_ENABLED || 'true').toLowerCase() !== 'false';

let connection = null;
let isReady = false;

function createConnection() {
  if (!REDIS_ENABLED) return null;
  try {
    const opts = REDIS_URL
      ? { maxRetriesPerRequest: null }
      : {
          host: REDIS_HOST,
          port: REDIS_PORT,
          password: REDIS_PASSWORD,
          db: REDIS_DB,
          maxRetriesPerRequest: null,          // BullMQ-এর requirement
          enableReadyCheck: false,
          connectTimeout: 5000,
          retryStrategy: (times) => Math.min(times * 500, 10000)
        };

    const client = REDIS_URL
      ? new IORedis(REDIS_URL, opts)
      : new IORedis(opts);

    client.on('ready', () => { isReady = true; console.log('[queue] Redis ready'); });
    client.on('error', (err) => { isReady = false; console.error('[queue] Redis error:', err.message); });
    client.on('close', () => { isReady = false; });

    return client;
  } catch (err) {
    console.error('[queue] connection init failed (non-blocking):', err.message);
    return null;
  }
}

connection = createConnection();

function getConnection() { return connection; }
function isAvailable()   { return !!(connection && isReady); }

module.exports = { getConnection, isAvailable };
