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
const { resolveProcessRole, runsWeb, runsWorker } = require('./services/processRole');

// PROCESS_ROLE = all (ডিফল্ট, পুরোনো আচরণ) | web | worker — services/processRole.js দেখুন।
// অবৈধ মান এখানে throw করা হয় না; startServer() প্রথম ধাপেই সেটা রিপোর্ট করে exit(1) করে,
// যাতে কোনো service/DB কানেকশন চালু হওয়ার আগেই পরিষ্কার error দিয়ে থামে।
let PROCESS_ROLE = 'all';
let roleError = null;
try { PROCESS_ROLE = resolveProcessRole(); } catch (err) { roleError = err; }
// শাটডাউন কোন role-এর জন্য চলবে (startServer({ role }) দিয়ে টেস্টে বদলানো যায়)
let activeRole = PROCESS_ROLE;
// PROCESS_ROLE=worker হলে সক্রিয় runtime (services/workerRuntime.js)
let workerRuntime = null;

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
// worker-এ চলমান queue batch শেষ হওয়ার জন্য বাড়তি সময় লাগে; web/all-এর ১০s অপরিবর্তিত।
const SHUTDOWN_TIMEOUT_MS = PROCESS_ROLE === 'worker'
  ? parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '25000', 10)
  : 10000;

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
  //    worker role: runtime উল্টো ক্রমে সব সার্ভিস থামায় (scheduler, queue drain, match sync, backup timer…)
  //    all role: আগের পথ — সাথে queue drain, match sync ও auto-backup timer বন্ধ
  //    web role: কোনো background সার্ভিস চালু ছিল না, তাই থামানোরও কিছু নেই
  if (activeRole === 'worker') {
    try { if (workerRuntime) await workerRuntime.stop(); } catch (e) {}
  } else if (activeRole === 'all') {
    stopBackgroundBoot(); // ৩s boot-timer এখনো বাকি থাকলে বাতিল
    try { require('./services/scheduler').stop(); } catch (e) {}
    try { require('./services/queue').stopWorker(); } catch (e) {}
    // ২. চলমান কিউ কাজ গুছিয়ে শেষ করা (ক্লেইম করা batch মাঝপথে ফেলা হয় না)
    try { await require('./services/queue').stopWorkerAndDrain(); } catch (e) {}
    try { require('./services/matchUpdater').stopMatchSync(); } catch (e) {}
    try { require('./services/backupManager').stopAutoBackup(); } catch (e) {}
    try { require('./services/backup').stopDailyBackup(); } catch (e) {}
  }
  // BullMQ consumer (থাকলে) + producer Queue + shared Redis কানেকশন বন্ধ
  try { await require('./queues').shutdownQueueSystem(); } catch (e) {}
  // ৩. Socket.IO ও HTTP সার্ভার নতুন কানেকশন নেওয়া বন্ধ করে চলমানগুলো শেষ করুক
  //    (বেট/ওয়ালেট রিকোয়েস্ট শেষ হওয়ার পরেই নিচে DB pool বন্ধ হয়)
  if (runsWeb(activeRole)) {
    try {
      if (global.__bet420Server && typeof global.__bet420Server.closeIdleConnections === 'function') global.__bet420Server.closeIdleConnections();
      const io = require('./services/socket').getIo();
      if (io) await new Promise((resolve) => io.close(() => resolve()));
    } catch (e) {}
    try {
      if (global.__bet420Server) {
        await new Promise((resolve) => global.__bet420Server.close(() => resolve()));
      }
    } catch (e) {}
  }
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

// app.js (Express + Socket.IO অবজেক্ট) শুধু web/all role-এ লোড হয়। worker role কখনো
// এটা require করে না — নইলে অপ্রয়োজনীয় Socket.IO সার্ভার তৈরি হয়ে যেত।
let _app = null;
function loadApp() {
  if (!_app) _app = require('./app');
  return _app;
}
const { connectDB } = require('./db');
const runMigrations = require('./migrations');
const { syncMatches } = require('./services/matchUpdater');
const { scheduleDailyBackup } = require('./services/backup');
const { scheduleAutoBackup } = require('./services/backupManager');
const queueService = require('./services/queue');

const PORT = process.env.PORT || 3000;

// `all` role-এর ৩ সেকেন্ডের boot-timer হ্যান্ডল। শাটডাউন শুরু হলে এটা বাতিল করা হয়, নইলে
// server.close() অপেক্ষা করার সময় timer ফায়ার করে queue/BullMQ consumer চালু করে ফেলতে পারে।
let bootTimer = null;
function stopBackgroundBoot() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

// listen() হওয়ার পরেই কেবল ব্যাকগ্রাউন্ড কাজ শুরু হয়। আগে এগুলো একটা
// অনির্দিষ্ট `setTimeout(..., 3000)`-এর ভেতরে ছিল; সেটা রাখা হয়েছে শুধু
// বুট-টাইম DB চাপ কমানোর জন্য, তবে টেস্ট পথে এই কোড আর কখনো চলে না।
//
// মাল্টি-ইনস্ট্যান্স আর্কিটেকচার: আলাদা Render Background Worker থাকলে
// DISABLE_BACKGROUND_WORKER=true বা IS_WORKER=false দিয়ে ওয়েব ইনস্ট্যান্সে
// ব্যাকগ্রাউন্ড কাজ বন্ধ রাখা যায়, ফলে ফিড ও শিডিউলার ডুপ্লিকেট রান হয় না।
function startBackgroundWork() {
  if (process.env.DISABLE_BACKGROUND_WORKER === 'true' || process.env.DISABLE_BACKGROUND_WORKER === '1') {
    console.log('ℹ️ DISABLE_BACKGROUND_WORKER সক্রিয় — এই ওয়েব ইনস্ট্যান্সে ব্যাকগ্রাউন্ড কাজ বন্ধ রাখা হয়েছে (Worker প্রসেস এটি পরিচালনা করছে)');
    return;
  }

  bootTimer = setTimeout(() => {
    bootTimer = null;
    if (shuttingDown) return; // শাটডাউন শুরু হয়ে গেলে নতুন consumer চালু নয়
    syncMatches().catch(err => console.error('Initial match sync failed:', err));
    require('./services/casinoGameSync').syncNewProvidersOnBoot()
      .catch(err => console.error('Initial casino game sync failed:', err.message));
    try { require('./services/queueHandlers'); queueService.startWorker(); } catch (e) { console.error('queue worker start error:', e.message); }
    require('./queues').initQueueSystem().catch(err => console.error('queues initQueueSystem error:', err.message));
  }, 3000);
  bootTimer.unref();

  scheduleDailyBackup();
  scheduleAutoBackup();
  require('./services/scheduler').start()
    .catch(err => console.error('⚠️ Scheduler চালু করতে সমস্যা হয়েছে (সার্ভার চলতে থাকবে):', err.message));
}

// পাবলিক URL কনফিগার যাচাই — ভুল/অনুপস্থিত কনফিগ প্রথম রিসেট ইমেইলের
// সময় নয়, বুটের সময়ই ধরা পড়ুক। (worker-ও ইমেইল জব পাঠায়, তাই সেখানেও দরকার)
function assertPublicUrlOrExit() {
  try {
    require('./utils/publicUrl').assertConfigured();
  } catch (err) {
    console.error('❌ কনফিগারেশন সমস্যা:', err.message);
    process.exit(1);
  }
}

async function startServer(opts = {}) {
  try {
    if (roleError) throw roleError; // অবৈধ PROCESS_ROLE — কোনো কিছু চালু হওয়ার আগেই থামো
    const role = opts.role || PROCESS_ROLE;
    activeRole = role;
    console.log(`🧭 PROCESS_ROLE=${role}`);

    await connectDB();
    console.log("✅ PostgreSQL connected successfully");

    if (runsWeb(role)) {
      await runMigrations();
      console.log("✅ DB migration done");

      // PHASE 2 fix: critical table verification ব্যর্থ হলে আগে শুধু log করে
      // listen করা হত। এখন এটি fail-closed — ভাঙা schema নিয়ে payment/admin
      // operation চালু করা হবে না।
      const { ensureCriticalTables } = require('./services/ensureCriticalTables');
      await ensureCriticalTables();
    } else {
      // worker migration/DDL চালায় না (একাধিক প্রসেসের migration race এড়াতে) — web/all যে schema
      // বানায় সেটা তৈরি হওয়া পর্যন্ত সীমিত সময় অপেক্ষা করে, না হলে fail-closed।
      const { waitForWorkerSchema } = require('./services/workerRuntime');
      await waitForWorkerSchema(require('./db').pool);
      console.log('✅ Worker schema ready (কোনো migration চালানো হয়নি)');
    }

    if (runsWeb(role)) {
      const app = loadApp();
      const server = app.httpServer;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, resolve);
      });
      console.log(`✅ Server running on port ${PORT}`);
      // Step 3: heartbeat (env ফ্ল্যাগ + breaker অবস্থা) — Integrations পেজে web কলামের উৎস
      try { require('./services/integrationStatus').startHeartbeat(role === 'all' ? 'all' : 'web'); } catch (e) { console.warn('heartbeat start failed:', e.message); }

      assertPublicUrlOrExit();

      if (role === 'all') {
        startBackgroundWork();
      } else {
        // web: শুধু producer — enqueue-এর জন্য Redis সংযোগ; কোনো consumer/scheduler/timer নয়
        require('./queues').initQueueProducers()
          .catch(err => console.error('queues initQueueProducers error:', err.message));
      }
      return server;
    }

    // ---- PROCESS_ROLE=worker: HTTP/Socket.IO নেই ----
    assertPublicUrlOrExit();
    const { createWorkerRuntime, defaultServices } = require('./services/workerRuntime');
    workerRuntime = createWorkerRuntime({
      services: defaultServices(),
      strict: true,
      heartbeatMs: parseInt(process.env.WORKER_HEARTBEAT_MS || '60000', 10)
    });
    await workerRuntime.start();
    try { require('./services/integrationStatus').startHeartbeat('worker'); } catch (e) { console.warn('heartbeat start failed:', e.message); }
    console.log('✅ Worker process running (HTTP listener নেই)');
    return null;
  } catch (err) {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
  }
}

// require('./server') করলে কিছুই চালু হয় না — শুধু `node server.js`-এ।
if (require.main === module) {
  startServer();
}

module.exports = {
  get app() { return loadApp(); },
  get server() { return loadApp().httpServer; },
  startServer,
  startBackgroundWork,
  stopBackgroundBoot
};
