// services/workerRuntime.js
// ---------------------------------------------------------------------------
// Background সার্ভিসগুলোর জন্য একটা পরিষ্কার lifecycle।
//
//  • প্রতিটা সার্ভিস সর্বোচ্চ একবার চালু হয় (start() দ্বিতীয়বার ডাকলে একই promise ফেরত)।
//  • strict মোডে (worker role) কোনো সার্ভিস চালু হতে ব্যর্থ হলে আগে চালু হওয়াগুলো
//    উল্টো ক্রমে বন্ধ হয় এবং start() reject করে। non-strict মোডে (all role) আগের
//    আচরণ বজায় থাকে: ব্যর্থতা লগ হয়, বাকিরা চলতে থাকে।
//  • stop() idempotent — দুবার ডাকলে cleanup দ্বিতীয়বার চলে না।
//  • delayMs-সহ সার্ভিস (পুরোনো `setTimeout(..., 3000)` boot delay) বন্ধ হওয়ার আগে
//    ফায়ার না করলে timer clear হয়, ফায়ার করলে সার্ভিসও stop হয়।
//
// আর্থিক কাজ (bet/wallet/settlement) এখানে নেই এবং থাকবে না।
// ---------------------------------------------------------------------------

function createWorkerRuntime({ services, strict = false, logger = console, heartbeatMs = 0 } = {}) {
  if (!Array.isArray(services)) throw new Error('services তালিকা আবশ্যক');

  const status = new Map(services.map((s) => [s.name, 'idle'])); // idle|pending|running|stopped|failed
  const timers = new Map();   // name -> delay timer
  const started = [];         // সফলভাবে চালু হওয়া সার্ভিস (stop ক্রম নির্ধারণে)
  let startPromise = null;
  let stopPromise = null;
  let stopping = false;
  let heartbeat = null;

  async function runStart(svc) {
    status.set(svc.name, 'running');
    started.push(svc);
    const result = svc.start();
    if (svc.fireAndForget) {
      Promise.resolve(result).catch((err) => {
        logger.error(`[worker] ${svc.name} ব্যাকগ্রাউন্ড startup ত্রুটি:`, err && err.message);
      });
      return;
    }
    await result;
  }

  function scheduleDelayed(svc) {
    status.set(svc.name, 'pending');
    const t = setTimeout(() => {
      timers.delete(svc.name);
      if (stopping) return;
      runStart(svc).catch((err) => {
        status.set(svc.name, 'failed');
        logger.error(`[worker] ${svc.name} চালু করতে সমস্যা:`, err && err.message);
      });
    }, svc.delayMs);
    if (t.unref) t.unref();
    timers.set(svc.name, t);
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      for (const svc of services) {
        if (stopping) break;
        if (svc.delayMs > 0) { scheduleDelayed(svc); continue; }
        try {
          await runStart(svc);
          logger.log(`[worker] ✅ ${svc.name} চালু`);
        } catch (err) {
          status.set(svc.name, 'failed');
          logger.error(`[worker] ❌ ${svc.name} চালু হয়নি:`, err && err.message);
          if (strict) {
            await stop();
            throw err;
          }
        }
      }
      if (heartbeatMs > 0 && !stopping) {
        // একই সাথে প্রসেসকে জীবিত রাখে (কিছু সার্ভিসের timer unref করা) ও লগে হেলথ চিহ্ন রাখে
        heartbeat = setInterval(() => {
          logger.log(`[worker] heartbeat ${JSON.stringify(getStatus())}`);
        }, heartbeatMs);
      }
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      // উল্টো ক্রমে বন্ধ — যে সবার শেষে চালু হয়েছে সে সবার আগে থামে
      for (const svc of [...started].reverse()) {
        try {
          if (typeof svc.stop === 'function') await svc.stop();
          // ব্যর্থ startup-এর partial resource বন্ধ হয়, কিন্তু অবস্থা 'failed'-ই থাকে
          if (status.get(svc.name) !== 'failed') status.set(svc.name, 'stopped');
        } catch (err) {
          logger.error(`[worker] ${svc.name} বন্ধ করতে সমস্যা:`, err && err.message);
        }
      }
      started.length = 0;
    })();
    return stopPromise;
  }

  function getStatus() {
    return Object.fromEntries(status);
  }

  return { start, stop, getStatus };
}

// ---------------------------------------------------------------------------
// প্রোডাকশনের সার্ভিস তালিকা। lazy require — মডিউল ইম্পোর্টে কোনো side-effect নেই।
// ক্রম গুরুত্বপূর্ণ: queue handler রেজিস্টার হওয়ার পরেই queue consumer চালু হয়।
// `bootDelayMs` শুধু `all` role-এর backward-compat (আগের ৩ সেকেন্ডের বিলম্ব)।
// ---------------------------------------------------------------------------
function defaultServices({ bootDelayMs = 0 } = {}) {
  return [
    {
      name: 'pgQueueConsumer',
      delayMs: bootDelayMs,
      start: () => { require('./queueHandlers'); require('./queue').startWorker(); },
      stop: () => require('./queue').stopWorkerAndDrain(),
    },
    {
      name: 'bullmqConsumers',
      delayMs: bootDelayMs,
      // REDIS_URL না থাকলে বা Redis না উঠলে false রিটার্ন করে (inline fallback) — ব্যর্থতা নয়
      start: () => require('../queues').startQueueConsumers(),
      stop: () => require('../queues').stopQueueConsumers(),
    },
    {
      name: 'scheduler',
      start: () => require('./scheduler').start(),
      stop: () => require('./scheduler').stop(),
    },
    {
      name: 'matchSync',
      delayMs: bootDelayMs,
      fireAndForget: true, // প্রথম sync নেটওয়ার্ক-নির্ভর; startup আটকানো যাবে না
      start: () => require('./matchUpdater').syncMatches(),
      stop: () => require('./matchUpdater').stopMatchSync(),
    },
    {
      name: 'casinoBootSync',
      delayMs: bootDelayMs,
      fireAndForget: true,
      start: () => require('./casinoGameSync').syncNewProvidersOnBoot(),
    },
    {
      name: 'dailyBackup',
      start: () => require('./backup').scheduleDailyBackup(),
      stop: () => require('./backup').stopDailyBackup(),
    },
    {
      name: 'autoBackup',
      start: () => require('./backupManager').scheduleAutoBackup(),
      stop: () => require('./backupManager').stopAutoBackup(),
    },
  ];
}

// ---------------------------------------------------------------------------
// worker migration/DDL চালায় না। web/all যে টেবিলগুলো বানায় সেগুলো থাকা পর্যন্ত
// সীমিত সময় অপেক্ষা করে (read-only to_regclass চেক); সময় পেরোলে throw → startup fail-closed।
// ---------------------------------------------------------------------------
const WORKER_REQUIRED_TABLES = ['cron_jobs', 'cron_job_logs', 'job_queue', 'dead_letter_jobs', 'matches'];

async function waitForWorkerSchema(pool, {
  tables = WORKER_REQUIRED_TABLES,
  timeoutMs = parseInt(process.env.WORKER_SCHEMA_WAIT_MS || '60000', 10),
  intervalMs = 3000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = console,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let missing = tables;
  for (;;) {
    const r = await pool.query(
      'SELECT t AS name FROM unnest($1::text[]) AS t WHERE to_regclass(\'public.\' || t) IS NULL',
      [tables]
    );
    missing = r.rows.map((row) => row.name);
    if (missing.length === 0) return true;
    if (Date.now() >= deadline) {
      throw new Error(`worker schema প্রস্তুত নয় — অনুপস্থিত টেবিল: ${missing.join(', ')} (web/all প্রসেস আগে migration চালাবে)`);
    }
    logger.warn(`[worker] schema অপেক্ষা — অনুপস্থিত: ${missing.join(', ')}`);
    await sleep(intervalMs);
  }
}

module.exports = { createWorkerRuntime, defaultServices, waitForWorkerSchema, WORKER_REQUIRED_TABLES };
