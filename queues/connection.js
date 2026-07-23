// queues/connection.js
// BullMQ-এর জন্য একটাই শেয়ার্ড Redis connection।
// db.js-এর মতোই প্যাটার্ন: REDIS_URL সেট না থাকলে অ্যাপ ক্র্যাশ করবে না,
// শুধু Queue System বন্ধ থাকবে এবং সরাসরি (non-queued) fallback দিয়ে কাজ চলবে।

const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || '';

let connection = null;
let redisAvailable = false;

if (REDIS_URL) {
  try {
    connection = new IORedis(REDIS_URL, {
      // BullMQ-এর জন্য আবশ্যক — নাহলে blocking commands (BRPOPLPUSH ইত্যাদি) নিজে থেকে
      // রিট্রাই করার সময় BullMQ-এর নিজস্ব রিট্রাই লজিকের সাথে সংঘর্ষ হয়
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        // এক্সপোনেনশিয়াল ব্যাকঅফ, সর্বোচ্চ ১০ সেকেন্ড
        return Math.min(times * 500, 10000);
      }
    });

    connection.on('error', (err) => {
      console.error('⚠️ Redis (Queue) connection error:', err.message);
    });

    connection.on('connect', () => {
      redisAvailable = true;
      console.log('✅ Redis (Queue System) connected successfully');
    });

    connection.on('close', () => {
      redisAvailable = false;
    });
  } catch (err) {
    console.error('⚠️ Redis client তৈরি করতে গিয়ে সমস্যা হয়েছে — Queue System বন্ধ থাকবে:', err.message);
    connection = null;
  }
} else {
  console.warn('⚠️ REDIS_URL সেট করা নেই। Background Queue System বন্ধ থাকবে — সব জব সরাসরি (inline) চালানো হবে।');
}

async function connectQueueRedis() {
  if (!connection) return false;
  try {
    await connection.connect();
    redisAvailable = true;
    return true;
  } catch (err) {
    // BullMQ-এর Queue instance তৈরি হওয়ার সময়ই (queues/definitions.js) ioredis
    // নিজে থেকে auto-connect শুরু করে দেয় (lazyConnect সত্ত্বেও প্রথম কমান্ডে)।
    // তাই আমাদের এই ম্যানুয়াল connect() কল অনেক সময় "already connecting/connected"
    // এরর দেয় যদিও সংযোগ আসলে ঠিকই হচ্ছে/হয়েছে — এটা প্রকৃত ব্যর্থতা না।
    if (/already connecting|already connected/i.test(err.message)) {
      // ready হওয়া পর্যন্ত অপেক্ষা করি (সর্বোচ্চ ৫ সেকেন্ড)
      if (connection.status === 'ready' || connection.status === 'connect') {
        redisAvailable = true;
        return true;
      }
      const ready = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        connection.once('ready', () => { clearTimeout(timer); resolve(true); });
        connection.once('error', () => { clearTimeout(timer); resolve(false); });
      });
      redisAvailable = ready;
      return ready;
    }
    console.error('⚠️ Redis (Queue) connect ব্যর্থ হয়েছে। Queue System বন্ধ থাকবে:', err.message);
    redisAvailable = false;
    return false;
  }
}

function isQueueEnabled() {
  return !!(connection && redisAvailable);
}

module.exports = { connection, connectQueueRedis, isQueueEnabled };
