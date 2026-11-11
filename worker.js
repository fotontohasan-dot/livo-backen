// worker.js
// ---------------------------------------------------------------------------
// Livo Sports Platform — Dedicated Background Worker Process
//
// দায়িত্ব বিভাজন:
//   server.js → HTTP Web traffic, WebSockets/Socket.IO connections, health checks.
//   worker.js → Background queues (BullMQ & Postgres queue), sports feed ingestion
//               (syncMatches), scheduled cron jobs, automated backups.
//
// এই প্রসেসটি কোনো HTTP পোর্ট বাইন্ড করে না। এটি আলাদা Render Background Worker
// সার্ভিস হিসেবে চলে। একাধিক Web Instance থাকা অবস্থায় এটি স্পোর্টস ফিড বা ক্রন জব
// ডুপ্লিকেট রান হওয়া সম্পূর্ণ প্রতিরোধ করে।
// ---------------------------------------------------------------------------

require('dotenv').config();
const process = require('node:process');
const sentryService = require('./services/sentry');
const { connectDB } = require('./db');
const runMigrations = require('./migrations');
const { syncMatches } = require('./services/matchUpdater');
const { scheduleDailyBackup } = require('./services/backup');
const { scheduleAutoBackup } = require('./services/backupManager');
const queueService = require('./services/queue');

// ==================== ক্র্যাশ ও এক্সেপশন গার্ড ====================
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [worker] Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
  sentryService.captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'worker-unhandledRejection' });
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ [worker] Uncaught Exception:', err && err.stack ? err.stack : err);
  sentryService.captureException(err, { source: 'worker-uncaughtException' });
  setTimeout(() => process.exit(1), 2000).unref();
});

// ==================== গ্রেসফুল শাটডাউন ====================
let shuttingDown = false;
// চলমান queue batch drain হতে সময় লাগে (QUEUE_DRAIN_TIMEOUT_MS ডিফল্ট ২০s), তাই server.js-এর
// PROCESS_ROLE=worker পথের সাথে মিলিয়ে ২৫s; বদলানো যায় WORKER_SHUTDOWN_TIMEOUT_MS দিয়ে।
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '25000', 10);

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`↩️ [worker] ${signal} পাওয়া গেছে — ওয়ার্কার গ্রেসফুল শাটডাউন শুরু`);

  const forceExit = setTimeout(() => {
    console.error('⚠️ [worker] শাটডাউন সময়সীমা পেরিয়েছে — জোর করে বন্ধ করা হচ্ছে');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (forceExit.unref) forceExit.unref();

  // ১. নতুন কাজ নেওয়া বন্ধ: সব টাইমার/শিডিউলার (ক্রম server.js worker-runtime-এর সাথে সামঞ্জস্যপূর্ণ)
  try { require('./services/backupManager').stopAutoBackup(); } catch (e) {}
  try { require('./services/backup').stopDailyBackup(); } catch (e) {}
  try { require('./services/matchUpdater').stopMatchSync(); } catch (e) {}
  try { require('./services/scheduler').stop(); } catch (e) {}
  // ২. চলমান Postgres-queue batch গুছিয়ে শেষ করা — ক্লেইম করা জব মাঝপথে ফেলা হয় না
  try { await require('./services/queue').stopWorkerAndDrain(); } catch (e) {}
  try { await require('./queues').shutdownQueueSystem(); } catch (e) {}

  // ৩. Redis ও DB কানেকশন বন্ধ
  try {
    const cache = require('./services/cache');
    const client = cache.getRawClient && cache.getRawClient();
    if (client && typeof client.quit === 'function') await client.quit();
  } catch (e) {}
  try { await require('./db').pool.end(); } catch (e) {}

  clearTimeout(forceExit);
  console.log('✅ [worker] গ্রেসফুল শাটডাউন সম্পন্ন');
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

async function startWorker() {
  try {
    console.log('🚀 [worker] Starting Livo Background Worker Process...');
    await connectDB();
    console.log('✅ [worker] PostgreSQL connected successfully');

    await runMigrations();
    console.log('✅ [worker] DB migrations verified');

    const { ensureCriticalTables } = require('./services/ensureCriticalTables');
    await ensureCriticalTables();

    // Step 3: heartbeat — env-presence ফ্ল্যাগ (শুধু true/false), boot সময় ও breaker অবস্থা DB-তে; অ্যাডমিন Integrations পেজ পড়ে
    require('./services/integrationStatus').startHeartbeat('worker');

    // 1. Initial sports match sync & periodic update
    syncMatches().catch(err => console.error('[worker] Initial match sync failed:', err.message));

    // 2. Casino providers sync on boot
    require('./services/casinoGameSync').syncNewProvidersOnBoot()
      .catch(err => console.error('[worker] Initial casino sync failed:', err.message));

    // 3. PostgreSQL-backed queue processor
    try {
      require('./services/queueHandlers');
      queueService.startWorker();
      console.log('✅ [worker] Postgres job_queue worker started');
    } catch (e) {
      console.error('[worker] queue worker start error:', e.message);
    }

    // 4. Redis-backed BullMQ processor
    require('./queues').initQueueSystem()
      .then(() => console.log('✅ [worker] BullMQ queue system initialized'))
      .catch(err => console.error('[worker] queues initQueueSystem error:', err.message));

    // 5. Automated backups
    scheduleDailyBackup();
    scheduleAutoBackup();

    // 6. Cron scheduler
    await require('./services/scheduler').start();
    console.log('✅ [worker] Scheduler started and active');

    console.log('🎯 [worker] Background worker is fully operational and listening for jobs.');
  } catch (err) {
    console.error('❌ [worker] Startup failed:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startWorker();
}

module.exports = { startWorker, gracefulShutdown };
