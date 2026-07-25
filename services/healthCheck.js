/**
 * services/healthCheck.js
 * ---------------------------------------------------------------------------
 * সিস্টেমের বিভিন্ন সার্ভিস (DB, Redis, Queue, Email, Disk, Memory, Uptime)
 * চেক করে Healthy/Warning/Error স্ট্যাটাস রিটার্ন করে।
 * - /health ও /ready রুট (routes/health.js) এবং
 * - অ্যাডমিন প্যানেলের System Diagnostics পেজ (routes/admin.js) — দুই জায়গাতেই এই সার্ভিস ব্যবহার হয়।
 * এই ফাইলের কোনো ফাংশনই থ্রো করে না — প্রতিটা চেক নিজের try/catch-এ র‍্যাপ করা,
 * ব্যর্থ হলে status: 'error' রিটার্ন করে, পুরো health check কখনো ক্র্যাশ করে না।
 * ---------------------------------------------------------------------------
 */

const os = require('os');
const { pool } = require('../db');
const cache = require('./cache');
const emailService = require('./email');

const STATUS = { OK: 'healthy', WARN: 'warning', ERROR: 'error' };

async function timed(fn) {
  const start = Date.now();
  const result = await fn();
  return { ...result, responseTimeMs: Date.now() - start };
}

// ==================== PostgreSQL ====================
async function checkDatabase() {
  return timed(async () => {
    try {
      await pool.query('SELECT 1');
      return { status: STATUS.OK, message: 'সংযুক্ত' };
    } catch (err) {
      return { status: STATUS.ERROR, message: err.message };
    }
  });
}

// ==================== Redis ====================
async function checkRedis() {
  return timed(async () => {
    try {
      const status = cache.getStatus();
      if (!status.enabled) {
        return { status: STATUS.WARN, message: 'Redis কনফিগার করা নেই (ঐচ্ছিক — DB fallback দিয়ে চলছে)' };
      }
      if (!status.connected) {
        return { status: STATUS.WARN, message: status.lastError || 'সংযোগ বিচ্ছিন্ন — DB fallback দিয়ে চলছে', disabledReason: status.disabledReason };
      }
      return { status: STATUS.OK, message: 'সংযুক্ত' };
    } catch (err) {
      return { status: STATUS.WARN, message: err.message };
    }
  });
}

// ==================== Background Job Queue (BullMQ) ====================
async function checkQueue() {
  return timed(async () => {
    try {
      const { getQueueHealthStats } = require('../queues');
      const stats = await getQueueHealthStats();
      if (!stats.redisConnected) {
        return { status: STATUS.WARN, message: 'কিউ সিস্টেম নিষ্ক্রিয় (Redis ছাড়া কাজ করে না, ঐচ্ছিক ফিচার)' };
      }
      const failedTotal = stats.queues.reduce((sum, q) => sum + (q.counts?.failed || 0), 0);
      const anyPaused = stats.queues.some(q => q.paused);
      const status = failedTotal > 50 ? STATUS.WARN : anyPaused ? STATUS.WARN : STATUS.OK;
      return {
        status,
        message: `${stats.queues.length}টা কিউ সক্রিয়${failedTotal ? `, ${failedTotal}টা ফেইলড জব` : ''}${anyPaused ? ' (কিছু paused)' : ''}`,
        queues: stats.queues.map(q => ({ name: q.name, ...q.counts }))
      };
    } catch (err) {
      return { status: STATUS.WARN, message: err.message };
    }
  });
}

// ==================== ইমেইল সার্ভিস (SMTP) ====================
async function checkEmail() {
  return timed(async () => {
    try {
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        return { status: STATUS.WARN, message: 'EMAIL_USER/EMAIL_PASS সেট করা নেই' };
      }
      await emailService.verifyConnection();
      return { status: STATUS.OK, message: 'SMTP সংযোগ যাচাই সফল' };
    } catch (err) {
      return { status: STATUS.ERROR, message: err.message };
    }
  });
}

// ==================== ডিস্ক স্পেস ====================
async function checkDiskSpace() {
  return timed(async () => {
    try {
      if (typeof require('fs').statfs !== 'function') {
        return { status: STATUS.WARN, message: 'এই Node.js ভার্সনে ডিস্ক চেক সাপোর্ট নেই' };
      }
      const stats = await new Promise((resolve, reject) => {
        require('fs').statfs('.', (err, s) => (err ? reject(err) : resolve(s)));
      });
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bfree * stats.bsize;
      const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
      const status = usedPercent >= 90 ? STATUS.ERROR : (usedPercent >= 75 ? STATUS.WARN : STATUS.OK);
      return {
        status,
        message: `${usedPercent}% ব্যবহৃত`,
        totalGB: +(totalBytes / 1e9).toFixed(2),
        freeGB: +(freeBytes / 1e9).toFixed(2),
        usedPercent
      };
    } catch (err) {
      return { status: STATUS.WARN, message: 'ডিস্ক চেক করা যায়নি: ' + err.message };
    }
  });
}

// ==================== মেমরি ব্যবহার ====================
async function checkMemory() {
  return timed(async () => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
      const proc = process.memoryUsage();
      const status = usedPercent >= 90 ? STATUS.ERROR : (usedPercent >= 75 ? STATUS.WARN : STATUS.OK);
      return {
        status,
        message: `${usedPercent}% ব্যবহৃত`,
        totalMB: Math.round(totalMem / 1e6),
        freeMB: Math.round(freeMem / 1e6),
        usedPercent,
        processRssMB: Math.round(proc.rss / 1e6),
        processHeapUsedMB: Math.round(proc.heapUsed / 1e6)
      };
    } catch (err) {
      return { status: STATUS.WARN, message: err.message };
    }
  });
}

// ==================== আপটাইম ====================
function checkUptime() {
  const seconds = Math.floor(process.uptime());
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return {
    status: STATUS.OK,
    message: `${d}দ ${h}ঘ ${m}মি ${s}সে`,
    seconds,
    startedAt: new Date(Date.now() - seconds * 1000).toISOString()
  };
}

/**
 * সবগুলো চেক একসাথে চালায় এবং একটা সামগ্রিক স্ট্যাটাস বের করে।
 * overall: error (কোনো critical সার্ভিস ডাউন) > warning > healthy
 */
async function runAllChecks() {
  const [database, redis, queueStatus, email, disk, memory] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    checkEmail(),
    checkDiskSpace(),
    checkMemory()
  ]);
  const uptime = checkUptime();

  const checks = { database, redis, queue: queueStatus, email, disk, memory, uptime };

  // ডাটাবেজ ছাড়া বাকি সব ঐচ্ছিক/গ্রেসফুল-ফলব্যাক থাকা সার্ভিস — তাই overall status-এ
  // শুধু database-এর error সরাসরি 'error' করে দেয়, বাকিদের error/warning মিলিয়ে 'warning' এ নামায়
  let overall = STATUS.OK;
  if (database.status === STATUS.ERROR) {
    overall = STATUS.ERROR;
  } else {
    const others = [redis, queueStatus, email, disk, memory];
    if (others.some(c => c.status === STATUS.ERROR)) overall = STATUS.WARN;
    else if (others.some(c => c.status === STATUS.WARN)) overall = STATUS.WARN;
  }

  return { overall, checks, timestamp: new Date().toISOString() };
}

// admin.js-এর পুরনো রুট runDiagnostics নামে import করে — alias রাখা হয়েছে
const runDiagnostics = runAllChecks;

module.exports = {
  STATUS,
  checkDatabase,
  checkRedis,
  checkQueue,
  checkEmail,
  checkDiskSpace,
  checkMemory,
  checkUptime,
  runAllChecks,
  runDiagnostics
};
