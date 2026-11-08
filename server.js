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
const { resolveProcessRole } = require('./services/processRole');
const workerRuntime = require('./services/workerRuntime');

// PROCESS_ROLE (all | web | worker) — ভুল মান import-এ throw করে না (টেস্টে require করা যায়);
// startServer() সবকিছু চালু করার আগেই স্পষ্ট এরর দিয়ে exit(1) করে।
let roleInfo;
let roleError = null;
try {
  roleInfo = resolveProcessRole();
} catch (err) {
  roleError = err;
  roleInfo = { role: 'invalid', runsWeb: false, runsWorker: false };
}

// ==================== প্রসেস-লেভেল ক্র্যাশ গার্ড ====================
// কোনো একটা জায়গায় unhandled promise rejection হলে Node.js (v15+) ডিফল্টভাবে
// পুরো প্রসেস বন্ধ করে দেয় — তখন Render/হোস্টিং প্ল্যাটফর্মের জেনেরিক
// "Internal Server Error" পেজ দেখা যায় যতক্ষণ না প্রসেস আবার রিস্টার্ট হয়।
// এখানে সেটা আটকে শুধু লগ করে সার্ভার চালু রাখা হচ্ছে — এখন Sentry-তেও রিপোর্ট হয়।
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
  sentryService.captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' });
});
// unhandledRejection-এ প্রসেস চালু রাখা তুলনামূলক গ্রহণযোগ্য, কিন্তু
// uncaughtException আলাদা: Node-এর ডকুমেন্টেশন স্পষ্টভাবে বলে এর পর প্রসেস
// undefined state-এ থাকে। টাকার প্ল্যাটফর্মে এর মানে অর্ধেক-কমিট হওয়া
// ট্রানজেকশন আর ফাঁস হওয়া DB কানেকশন — corrupted প্রসেস চালিয়ে যাওয়ার চেয়ে
// বেরিয়ে যাওয়া নিরাপদ। Sentry-কে পাঠানোর জন্য ২ সেকেন্ড সময় দিয়ে exit;
// Render/Docker restart policy সাথে সাথেই আবার তুলে দেয়।
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err && err.stack ? err.stack : err);
  sentryService.captureException(err, { source: 'uncaughtException' });
  setTimeout(() => process.exit(1), 2000).unref();
});
// গ্রেসফুল শাটডাউন। আগে শুধু SIGTERM হ্যান্ডেল হতো (SIGINT নয়, অর্থাৎ Ctrl+C-তে
// ব্যাকগ্রাউন্ড কাজ ও কানেকশন গুছিয়ে বন্ধ হতো না), আর হ্যান্ডলারটা সরাসরি
// process.exit(0) ডাকত — চলমান কাজ শেষ হওয়ার সুযোগ বা PG/Redis কানেকশন বন্ধ করার
// ধাপ ছাড়াই। এখন দুটো সিগন্যালই এক পথে যায়, একবারের বেশি চলে না, এবং সময়সীমার
// মধ্যে গুছিয়ে বেরোয়। সময়সীমা পেরোলে জোর করে বেরিয়ে যায় যাতে কখনো ঝুলে না থাকে।
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10000;

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
  // ২. HTTP + Socket.IO আগে: নতুন কানেকশন বন্ধ, চলমান রিকোয়েস্ট (bet/wallet ট্রানজেকশন সহ)
  //    শেষ হওয়ার জন্য অপেক্ষা। queue/Redis এর আগে বন্ধ করা হয় না, কারণ চলমান রিকোয়েস্ট
  //    জব enqueue করতে পারে। io.close() নিজেই underlying HTTP সার্ভারও বন্ধ করে।
  try {
    const srv = global.__bet420Server;
    if (srv && typeof srv.closeIdleConnections === 'function') srv.closeIdleConnections();
    const io = require('./services/socket').getIo();
    if (io) {
      await new Promise((resolve) => io.close(() => resolve()));
    } else if (srv && srv.listening) {
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  } catch (e) {}
  // ৩. ব্যাকগ্রাউন্ড টাইমার (match sync, backup, বুট-টাইমার) বন্ধ + চলমান PG-queue batch drain
  try {
    await workerRuntime.stopBackgroundWork({ drainTimeoutMs: Math.max(1000, SHUTDOWN_TIMEOUT_MS - 2000) });
  } catch (e) {}
  // ৪. BullMQ consumer + queue Redis কানেকশন বন্ধ
  try { await require('./queues').shutdownQueueSystem(); } catch (e) {}
  // ৫. ক্যাশ Redis ও ডাটাবেস কানেকশন বন্ধ (lazy require — হ্যান্ডলারটা ইম্পোর্টের আগেই সংজ্ঞায়িত)
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

// web/all: Express অ্যাপ ও HTTP সার্ভার লোড হয়। worker: app.js লোডই হয় না, তাই
// Socket.IO সার্ভার তৈরি হয় না এবং কোনো পোর্টও খোলা হয় না।
const app = roleInfo.runsWeb ? require('./app') : null;
const server = app ? app.httpServer : null;
const { connectDB } = require('./db');
const runMigrations = require('./migrations');
const { syncMatches } = require('./services/matchUpdater');
const { scheduleDailyBackup } = require('./services/backup');
const { scheduleAutoBackup } = require('./services/backupManager');
const queueService = require('./services/queue');

const PORT = process.env.PORT || 3000;

let backgroundStarted = false;

// listen() হওয়ার পরেই কেবল ব্যাকগ্রাউন্ড কাজ শুরু হয়। আগে এগুলো একটা
// অনির্দিষ্ট `setTimeout(..., 3000)`-এর ভেতরে ছিল; সেটা রাখা হয়েছে শুধু
// বুট-টাইম DB চাপ কমানোর জন্য, তবে টেস্ট পথে এই কোড আর কখনো চলে না।
//
// PROCESS_ROLE অনুযায়ী:
//   web          → কোনো consumer/timer নয়; শুধু BullMQ *producer* কানেকশন (add() কাজ করার জন্য)
//   worker / all → নিচের সব ব্যাকগ্রাউন্ড কাজ (all = আগের আচরণ হুবহু)
// একই প্রসেসে দুবার ডাকলে দ্বিতীয়বার কিছুই হয় না।
function startBackgroundWork() {
  if (backgroundStarted) return;
  backgroundStarted = true;

  if (!roleInfo.runsWorker) {
    require('./queues').initQueueProducers()
      .catch(err => console.error('queues initQueueProducers error:', err.message));
    return;
  }

  const bootTimer = setTimeout(() => {
    syncMatches().catch(err => console.error('Initial match sync failed:', err));
    // PHASE 3 — বুট-টাইম ক্যাসিনো গেম sync। উদ্দেশ্য: একটা নতুন প্রোভাইডারের
    // credential .env-এ বসিয়ে ডিপ্লয় করলেই অ্যাডমিনকে কিছু না করেই গেম
    // লবিতে চলে আসবে। ইচ্ছাকৃতভাবে await করা হয় না এবং কখনো throw করে না —
    // ক্যাটালগ sync-এর জন্য সার্ভার বুট আটকে থাকা গ্রহণযোগ্য নয়।
    require('./services/casinoGameSync').syncNewProvidersOnBoot()
      .catch(err => console.error('Initial casino game sync failed:', err.message));
    try { require('./services/queueHandlers'); queueService.startWorker(); } catch (e) { console.error('queue worker start error:', e.message); }
    // queues/index.js (BullMQ, activity-log/fraud-scan/admin queue dashboard) — REDIS_URL
    // না থাকলে নিরাপদে false রিটার্ন করে স্কিপ করে (connection.js দেখুন)।
    require('./queues').initQueueSystem().catch(err => console.error('queues initQueueSystem error:', err.message));
  }, 3000);
  bootTimer.unref();
  workerRuntime.trackTimer(bootTimer);

  scheduleDailyBackup();
  scheduleAutoBackup();
  require('./services/scheduler').start()
    .catch(err => console.error('⚠️ Scheduler চালু করতে সমস্যা হয়েছে (সার্ভার চলতে থাকবে):', err.message));
}

// স্টার্টআপ মাঝপথে ব্যর্থ হলে যা যা চালু হয়ে গেছে তা বন্ধ করে (সর্বোচ্চ ৫ সেকেন্ড)।
async function cleanupPartialStartup() {
  const cap = new Promise((resolve) => { const t = setTimeout(resolve, 5000); if (t.unref) t.unref(); });
  const work = (async () => {
    try { require('./services/scheduler').stop(); } catch (e) {}
    try { await workerRuntime.stopBackgroundWork({ drainTimeoutMs: 1000 }); } catch (e) {}
    try { await require('./queues').shutdownQueueSystem(); } catch (e) {}
    try { await require('./db').pool.end(); } catch (e) {}
  })();
  await Promise.race([work, cap]);
}

async function startServer() {
  // ভুল PROCESS_ROLE হলে কোনো সার্ভিস (DB, Redis, টাইমার) চালু করার আগেই বন্ধ।
  if (roleError) {
    console.error(`❌ ${roleError.message}`);
    process.exit(1);
    return;
  }
  const { role, runsWeb } = roleInfo;
  console.log(`🧭 PROCESS_ROLE=${role}`);
  try {
    await connectDB();
    console.log("✅ PostgreSQL connected successfully");

    if (runsWeb) {
      await runMigrations();
      console.log("✅ DB migration done");

      // PHASE 2 fix: critical table verification ব্যর্থ হলে আগে শুধু log করে
      // listen করা হত। এখন এটি fail-closed — ভাঙা schema নিয়ে payment/admin
      // operation চালু করা হবে না।
      const { ensureCriticalTables } = require('./services/ensureCriticalTables');
      await ensureCriticalTables();

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, resolve);
      });
      console.log(`✅ Server running on port ${PORT}`);
    } else {
      // worker মাইগ্রেশন চালায় না (web-এর সাথে DDL race এড়াতে) — শুধু schema প্রস্তুত কি না দেখে।
      await workerRuntime.waitForSchema();
      console.log('✅ Worker: schema যাচাই সম্পন্ন (মাইগ্রেশন web প্রসেসের দায়িত্ব)');
    }

    // পাবলিক URL কনফিগার যাচাই — ভুল/অনুপস্থিত কনফিগ প্রথম রিসেট ইমেইলের
    // সময় নয়, বুটের সময়ই ধরা পড়ুক।
    try {
      require('./utils/publicUrl').assertConfigured();
    } catch (err) {
      console.error('❌ কনফিগারেশন সমস্যা:', err.message);
      process.exit(1);
    }

    // worker-এ HTTP সার্ভার নেই; প্রসেস জীবিত রাখতে keep-alive টাইমার।
    if (role === 'worker') workerRuntime.startKeepAlive();

    startBackgroundWork();
    if (role === 'worker') console.log('✅ Worker চালু — ব্যাকগ্রাউন্ড কাজ সক্রিয় (কোনো HTTP পোর্ট খোলা নেই)');
    return server;
  } catch (err) {
    console.error('❌ Server startup failed:', err);
    cleanupPartialStartup().finally(() => process.exit(1));
  }
}

// require('./server') করলে কিছুই চালু হয় না — শুধু `node server.js`-এ।
if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer, startBackgroundWork, processRole: roleInfo };
