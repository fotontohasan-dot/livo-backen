// tests/afterEnv.js
// ---------------------------------------------------------------------------
// আগে এখানে প্রতিটা টেস্ট ফাইলের শুরুতে একটা নিরেট `setTimeout(1500)` ছিল।
// সেটা কোনো ফিক্স ছিল না — উপসর্গ ঢাকার উপায় ছিল: `require('../../app.js')`
// নিজেই startServer() চালাত, তাই DB কানেকশন ও মাইগ্রেশন ব্যাকগ্রাউন্ডে চলতে
// থাকত এবং টেস্ট সেই কাজ শেষ হওয়ার "আশায়" দেড় সেকেন্ড ঘুমাত। ধীর মেশিনে
// দেড় সেকেন্ড যথেষ্ট হতো না (রেস), আর দ্রুত মেশিনে পুরোটাই নষ্ট সময়।
//
// এখন app.js শুধু Express অ্যাপ অবজেক্ট এক্সপোর্ট করে — ইম্পোর্ট করলে কোনো
// I/O শুরু হয় না। স্কিমা tests/globalSetup.js পুরো স্যুটের আগে একবারই তৈরি
// করে। তাই কোনো অপেক্ষার দরকার নেই।
//
// এই ফাইলটা ইচ্ছাকৃতভাবে টাইমার-মুক্ত রাখা হয়েছে; ভবিষ্যতে "টেস্ট ফ্লেকি,
// একটু sleep দিই" — এই সমাধান এখানে যোগ করা যাবে না, মূল কারণ খুঁজতে হবে।

// ---------------------------------------------------------------------------
// কেন্দ্রীয় ক্যাশ আইসোলেশন (শুধু টেস্ট-env)।
//
// পুরো স্যুট একটাই Redis শেয়ার করে, আর অ্যাপের ক্যাশ কী (যেমন `payment_methods:active` ৩০ সেকেন্ড,
// `matches:live` ১০ সেকেন্ড) একটা ফাইল থেকে পরের ফাইলে চুইয়ে পড়ে: আগের ফাইলের ভরা ক্যাশ হিট করলে পরের
// টেস্টের ব্যর্থ-করানো ক্যোয়ারি/সদ্য-ঢোকানো সারি আদৌ দেখা যায় না — ফলে ক্রম-নির্ভর ফেল।
// তাই প্রতিটা টেস্ট ফাইলের শুরুতে (root beforeAll) শুধু ক্যাশ কী মুছে ফেলা হয়।
//
// সীমা — যা ইচ্ছাকৃতভাবে ছোঁয়া হয় না:
//   • REDIS_PREFIX (ডিফল্ট `bet420:`)-এর বাইরের সব key: সেশন (`livo:sess:`), BullMQ কিউ (`bull:`) ইত্যাদি।
//   • `<prefix>rl:*` — রেট-লিমিট কাউন্টার ক্যাশ নয়; কিছু টেস্ট (login limiter ইত্যাদি) এগুলোর ক্রমের
//     উপর নির্ভর করে, তাই এখানে অপরিবর্তিত।
// Redis বন্ধ/অকনফিগার্ড হলে নীরবে কিছু করে না। প্রোডাকশন কোড অপরিবর্তিত — এটা শুধু jest setupFilesAfterEnv।
// কোনো টাইমার/sleep নেই (উপরের নিয়ম বহাল)।
// ---------------------------------------------------------------------------
const CACHE_KEEP_SUBPREFIXES = ['rl:'];

async function clearTestCacheKeys() {
  if (process.env.NODE_ENV !== 'test') return;
  // কিছু ফাইল jest.useFakeTimers() দিয়ে সব টাইমার/nextTick নকল করে (যেমন tests/unit/bootTimerShutdown.test.js,
  // যা Redis-ই ছোঁয় না — সব mock)। নকল ঘড়িতে ioredis-এর কানেক্ট কখনো এগোয় না এবং hook আটকে ফাইল ফেল করায়।
  // এমন ফাইলে ক্যাশ পরিষ্কারের কিছু নেই, তাই বাদ।
  if (typeof setTimeout.clock !== 'undefined' || setTimeout._isMockFunction) return;
  if (String(process.env.REDIS_ENABLED || '').toLowerCase() === 'false') return;
  const url = process.env.CACHE_REDIS_URL || process.env.REDIS_URL;
  if (!url) return;
  let Redis;
  try { Redis = require('ioredis'); } catch (e) { return; }
  const prefix = process.env.REDIS_PREFIX || 'bet420:';
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 2000 });
  client.on('error', () => {});
  try {
    await client.connect();
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      const doomed = keys.filter((k) => !CACHE_KEEP_SUBPREFIXES.some((sp) => k.startsWith(prefix + sp)));
      if (doomed.length) await client.del(...doomed);
    } while (cursor !== '0');
  } catch (e) {
    // Redis অনুপলব্ধ — অ্যাপও তখন ক্যাশ ছাড়াই চলে, তাই আইসোলেশনের কিছু নেই
  } finally {
    client.disconnect();
  }
}

// আসল (নকল-নয়) টাইমারে সীমা: পরিষ্কার কখনোই ফাইল আটকাবে না বা ফেল করাবে না — সর্বোচ্চ ৫ সেকেন্ড, তারপর এগিয়ে যায়।
function boundedClear() {
  const realTimers = require('timers');
  return new Promise((resolve) => {
    const t = realTimers.setTimeout(resolve, 5000);
    clearTestCacheKeys().catch(() => {}).then(() => { realTimers.clearTimeout(t); resolve(); });
  });
}

if (typeof beforeAll === 'function') beforeAll(boundedClear, 15000);

module.exports = {};
