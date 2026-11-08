// services/workerRuntime.js
// ---------------------------------------------------------------------------
// ব্যাকগ্রাউন্ড কাজের লাইফসাইকেল সহায়ক — PROCESS_ROLE=worker এবং all-এর জন্য।
//
// দায়িত্ব:
//   * worker প্রসেস জীবিত রাখা (HTTP সার্ভার নেই, তাই keep-alive টাইমার)
//   * worker-এর schema-প্রস্তুতি অপেক্ষা (worker মাইগ্রেশন চালায় না — web চালায়)
//   * shutdown-এ সব ব্যাকগ্রাউন্ড টাইমার/consumer থামানো ও চলমান কাজ drain করা
//
// অর্থনৈতিক (bet/wallet/settlement) কোড এখানে নেই; এই মডিউল সেগুলো ছোঁয় না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');

// worker শুরুর আগে অবশ্যই থাকতে হবে এমন টেবিল (web-এর মাইগ্রেশনের ফল)।
const REQUIRED_TABLES = ['users', 'matches', 'bets', 'coin_transactions', 'job_queue', 'cron_jobs'];

const state = {
  startedAt: null,
  keepAlive: null,
  timers: new Set(),
  stopped: false,
  stopPromise: null
};

/** মাইগ্রেশন ছাড়া read-only অপেক্ষা: web প্রসেস schema তৈরি না করা পর্যন্ত worker বসে থাকে। */
async function waitForSchema({ attempts, delayMs, sleep } = {}) {
  const maxAttempts = attempts || Number(process.env.WORKER_SCHEMA_WAIT_ATTEMPTS) || 24;
  const delay = delayMs || Number(process.env.WORKER_SCHEMA_WAIT_MS) || 5000;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let missing = REQUIRED_TABLES;
  for (let i = 1; i <= maxAttempts; i++) {
    const r = await pool.query(
      'SELECT t AS name FROM unnest($1::text[]) AS t WHERE to_regclass(\'public.\' || t) IS NULL',
      [REQUIRED_TABLES]
    );
    missing = r.rows.map((x) => x.name);
    if (!missing.length) return true;
    console.warn(`[worker] schema প্রস্তুত নয় (${i}/${maxAttempts}) — অনুপস্থিত: ${missing.join(', ')}`);
    if (i < maxAttempts) await wait(delay);
  }
  throw new Error(`Worker schema not ready after ${maxAttempts} attempts; missing tables: ${missing.join(', ')}`);
}

/** HTTP listen নেই বলে event loop খালি হয়ে প্রসেস বেরিয়ে না যাওয়ার জন্য (ref'd, shutdown-এ clear)। */
function startKeepAlive() {
  if (state.keepAlive) return;
  state.keepAlive = setInterval(() => {}, 60 * 1000);
  state.startedAt = new Date();
}

/** shutdown-এ clear করার জন্য একটা টাইমার হ্যান্ডল রেজিস্টার করে (যেমন বুট-টাইম setTimeout)। */
function trackTimer(handle) {
  if (handle) state.timers.add(handle);
  return handle;
}

/**
 * ব্যাকগ্রাউন্ড টাইমার (match sync, backup, বুট-টাইমার) থামায় ও PG-queue drain করে।
 * Scheduler থামানো server.js-এর দায়িত্ব (একবারই; দুবার stop() লগ/কাজ ডুপ্লিকেট করত)। একাধিকবার ডাকলে একবারই চলে।
 * BullMQ/Redis বন্ধ করা shutdownQueueSystem()-এর কাজ (server.js থেকে ডাকা হয়)।
 */
function stopBackgroundWork({ drainTimeoutMs = 8000 } = {}) {
  if (state.stopPromise) return state.stopPromise;
  state.stopped = true;
  state.stopPromise = (async () => {
    if (state.keepAlive) { clearInterval(state.keepAlive); state.keepAlive = null; }
    for (const h of state.timers) { clearTimeout(h); clearInterval(h); }
    state.timers.clear();

    const safe = (label, fn) => { try { return fn(); } catch (e) { console.error(`[workerRuntime] ${label}:`, e.message); } };
    safe('matchSync.stop', () => require('./matchUpdater').stopSync());
    safe('backup.stop', () => require('./backup').stopDailyBackup());
    safe('autoBackup.stop', () => require('./backupManager').stopAutoBackup());

    // PostgreSQL queue: নতুন poll বন্ধ + চলমান batch শেষ হওয়ার জন্য অপেক্ষা (সর্বোচ্চ drainTimeoutMs)।
    try {
      const r = await require('./queue').drainWorker(drainTimeoutMs);
      if (!r.drained) console.warn('[workerRuntime] queue drain সময়সীমা পেরিয়েছে — চলমান জব heartbeat/stalled-recovery দিয়ে পুনরুদ্ধার হবে');
    } catch (e) {
      console.error('[workerRuntime] queue.drain:', e.message);
    }
  })();
  return state.stopPromise;
}

function _resetForTests() {
  if (state.keepAlive) clearInterval(state.keepAlive);
  state.keepAlive = null; state.timers.clear(); state.stopped = false; state.stopPromise = null; state.startedAt = null;
}

function getStatus() {
  return { startedAt: state.startedAt, keepAliveActive: !!state.keepAlive, stopped: state.stopped, trackedTimers: state.timers.size };
}

module.exports = { waitForSchema, startKeepAlive, trackTimer, stopBackgroundWork, getStatus, REQUIRED_TABLES, _resetForTests };
