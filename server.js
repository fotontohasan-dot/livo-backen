// server.js
// ---------------------------------------------------------------------------
// প্রোডাকশন/ডেভেলপমেন্ট এন্ট্রিপয়েন্ট।
//
// দায়িত্ব বিভাজন:
//   app.js    → শুধু Express অ্যাপ (config, middleware, routes) — কোনো I/O নয়।
//   server.js → প্রসেস-লেভেল গার্ড, DB কানেকশন, মাইগ্রেশন, ব্যাকগ্রাউন্ড ওয়ার্কার,
//               শিডিউলার, কিউ এবং `listen()`।
//
// কেন এই আলাদা করা: আগে app.js নিজেই নিচে `startServer()` কল করত, তাই টেস্ট
// থেকে অ্যাপ ইম্পোর্ট করলেই DB কানেকশন ও মাইগ্রেশন চালু হয়ে যেত — Jest teardown-এর
// পরেও async কাজ চলত, মাইগ্রেশন রেস হতো, কানেকশন contention থেকে ECONNRESET হতো।
// এখন টেস্ট শুধু অ্যাপ অবজেক্ট ইম্পোর্ট করে; DB সেটআপ টেস্ট নিজে নিয়ন্ত্রণ করে
// (tests/globalSetup.js একবার মাইগ্রেশন চালায়)।
//
// এই ফাইলটা সরাসরি চালালেই (`node server.js`) সার্ভার ওঠে; require করলে শুধু
// startServer() এক্সপোর্ট হয় (টেস্ট থেকে যাচাই করা যায়, কিন্তু চালু হয় না)।
// ---------------------------------------------------------------------------

require('dotenv').config();
const process = require('node:process');
const sentryService = require('./services/sentry');

// ==================== প্রসেস-লেভেল ক্র্যাশ গার্ড ====================
// কোনো একটা জায়গায় unhandled promise rejection হলে Node.js (v15+) ডিফল্টভাবে
// পুরো প্রসেস বন্ধ করে দেয় — তখন Render/হোস্টিং প্ল্যাটফর্মের জেনেরিক
// "Internal Server Error" পেজ দেখা যায় যতক্ষণ না প্রসেস আবার রিস্টার্ট হয়।
// এখানে সেটা আটকে শুধু লগ করে সার্ভার চালু রাখা হচ্ছে — এখন Sentry-তেও রিপোর্ট হয়।
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
  sentryService.captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err && err.stack ? err.stack : err);
  sentryService.captureException(err, { source: 'uncaughtException' });
});
// গ্রেসফুল শাটডাউন। আগে শুধু SIGTERM হ্যান্ডেল হতো (SIGINT নয়, অর্থাৎ Ctrl+C-তে
// ব্যাকগ্রাউন্ড কাজ ও কানেকশন গুছিয়ে বন্ধ হতো না), আর হ্যান্ডলারটা সরাসরি
// process.exit(0) ডাকত — চলমান কাজ শেষ হওয়ার সুযোগ বা PG/Redis কানেকশন বন্ধ করার
// ধাপ ছাড়াই। এখন দুটো সিগন্যালই এক পথে যায়, একবারের বেশি চলে না, এবং সময়সীমার
// মধ্যে গুছিয়ে বেরোয়। সময়সীমা পেরোলে জোর করে বেরিয়ে যায় যাতে কখনো ঝুলে না থাকে।
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10000;

async function gracefulShutdown(signal) {
  if (shuttingDown) return; // ডুপ্লিকেট সিগন্যালে দুবার চলবে না
  shuttingDown = true;
  console.log(`↩️ ${signal} পাওয়া গেছে — গ্রেসফুল শাটডাউন শুরু`);

  // যত সময়ই লাগুক, প্রসেস যেন চিরকাল ঝুলে না থাকে
  const forceExit = setTimeout(() => {
    console.error('⚠️ শাটডাউন সময়সীমা পেরিয়েছে — জোর করে বন্ধ করা হচ্ছে');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (forceExit.unref) forceExit.unref();

  // ১. নতুন কাজ নেওয়া বন্ধ (worker + scheduler টাইমার)
  try { require('./services/scheduler').stop(); } catch (e) {}
  try { require('./services/queue').stopWorker(); } catch (e) {}
  // ২. চলমান কিউ কাজ গুছিয়ে শেষ করা
  try { await require('./queues').shutdownQueueSystem(); } catch (e) {}
  // ৩. HTTP সার্ভার নতুন কানেকশন নেওয়া বন্ধ করে চলমানগুলো শেষ করুক
  try {
    if (global.__livoServer) {
      await new Promise((resolve) => global.__livoServer.close(resolve));
    }
  } catch (e) {}
  // ৪. ডাটাবেজ/ক্যাশ কানেকশন বন্ধ (lazy require — হ্যান্ডলারটা ইম্পোর্টের আগেই সংজ্ঞায়িত)
  try {
    const cache = require('./services/cache');
    const client = cache.getRawClient && cache.getRawClient();
    if (client && typeof client.quit === 'function') await client.quit();
  } catch (e) {}
  try { await require('./db').pool.end(); } catch (e) {}

  clearTimeout(forceExit);
  console.log('✅ গ্রেসফুল শাটডাউন সম্পন্ন');
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

const app = require('./app');
const server = app.httpServer;
const { connectDB } = require('./db');
const runMigrations = require('./migrations');
const { syncMatches } = require('./services/matchUpdater');
const { scheduleDailyBackup } = require('./services/backup');
const { scheduleAutoBackup } = require('./services/backupManager');
const queueService = require('./services/queue');

const PORT = process.env.PORT || 3000;

// listen() হওয়ার পরেই কেবল ব্যাকগ্রাউন্ড কাজ শুরু হয়। আগে এগুলো একটা
// অনির্দিষ্ট `setTimeout(..., 3000)`-এর ভেতরে ছিল; সেটা রাখা হয়েছে শুধু
// বুট-টাইম DB চাপ কমানোর জন্য, তবে টেস্ট পথে এই কোড আর কখনো চলে না।
function startBackgroundWork() {
  setTimeout(() => {
    syncMatches().catch(err => console.error('Initial match sync failed:', err));
    try { require('./services/queueHandlers'); queueService.startWorker(); } catch (e) { console.error('queue worker start error:', e.message); }
    // queues/index.js (BullMQ, activity-log/fraud-scan/admin queue dashboard) — REDIS_URL
    // না থাকলে নিরাপদে false রিটার্ন করে স্কিপ করে (connection.js দেখুন)।
    require('./queues').initQueueSystem().catch(err => console.error('queues initQueueSystem error:', err.message));
  }, 3000).unref();

  scheduleDailyBackup();
  scheduleAutoBackup();
  require('./services/scheduler').start()
    .catch(err => console.error('⚠️ Scheduler চালু করতে সমস্যা হয়েছে (সার্ভার চলতে থাকবে):', err.message));
}

async function startServer() {
  try {
    await connectDB();
    console.log("✅ PostgreSQL connected successfully");

    await runMigrations();
    console.log("✅ DB migration done");

    try {
      const { ensureCriticalTables } = require('./services/ensureCriticalTables');
      await ensureCriticalTables();
    } catch (e) {
      console.error('ensureCriticalTables:', e.message);
    }

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, resolve);
    });
    console.log(`✅ Server running on port ${PORT}`);

    // পাবলিক URL কনফিগার যাচাই — ভুল/অনুপস্থিত কনফিগ প্রথম রিসেট ইমেইলের
    // সময় নয়, বুটের সময়ই ধরা পড়ুক।
    try {
      require('./utils/publicUrl').assertConfigured();
    } catch (err) {
      console.error('❌ কনফিগারেশন সমস্যা:', err.message);
      process.exit(1);
    }

    startBackgroundWork();
    return server;
  } catch (err) {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
  }
}

// require('./server') করলে কিছুই চালু হয় না — শুধু `node server.js`-এ।
if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer, startBackgroundWork };
