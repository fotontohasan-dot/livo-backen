/**
 * services/healthCheck.js
 */

const os = require('os');
const { pool } = require('../db');
const cache = require('./cache');

const STATUS = { OK: 'healthy', WARN: 'warning', ERROR: 'error' };

async function timed(fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, responseTimeMs: Date.now() - start };
  } catch (err) {
    return { status: STATUS.ERROR, message: err.message || String(err), responseTimeMs: Date.now() - start };
  }
}

async function checkDatabase() {
  return timed(async () => {
    await pool.query('SELECT 1');
    return { status: STATUS.OK, message: 'সংযুক্ত' };
  });
}

async function checkRedis() {
  return timed(async () => {
    const status = cache.getStatus();
    if (!status.enabled) {
      return { status: STATUS.WARN, message: 'Redis কনফিগার করা নেই (ঐচ্ছিক — DB fallback দিয়ে চলছে)' };
    }
    if (!status.connected) {
      return { status: STATUS.WARN, message: status.lastError || status.disabledReason || 'সংযোগ বিচ্ছিন্ন — DB fallback দিয়ে চলছে' };
    }
    return { status: STATUS.OK, message: 'সংযুক্ত' };
  });
}

async function checkQueue() {
  return timed(async () => {
    try {
      const { getQueueHealthStats } = require('../queues');
      const stats = await getQueueHealthStats();
      if (!stats.redisConnected) {
        return { status: STATUS.WARN, message: 'কিউ সিস্টেম নিষ্ক্রিয় (Redis ছাড়া কাজ করে না, ঐচ্ছিক ফিচার)' };
      }
      const failedTotal = (stats.queues || []).reduce((sum, q) => sum + (q.counts?.failed || 0), 0);
      const anyPaused = (stats.queues || []).some(q => q.paused);
      const status = failedTotal > 50 ? STATUS.WARN : anyPaused ? STATUS.WARN : STATUS.OK;
      return {
        status,
        message: `${(stats.queues || []).length}টা কিউ সক্রিয়${failedTotal ? `, ${failedTotal}টা ফেইলড জব` : ''}${anyPaused ? ' (কিছু paused)' : ''}`,
        queues: (stats.queues || []).map(q => ({ name: q.name, ...q.counts }))
      };
    } catch (err) {
      return { status: STATUS.WARN, message: err.message || 'Queue চেক ব্যর্থ' };
    }
  });
}

async function checkEmail() {
  return timed(async () => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return { status: STATUS.WARN, message: 'EMAIL_USER/EMAIL_PASS সেট করা নেই' };
    }
    try {
      const emailService = require('./email');
      if (typeof emailService.verifyConnection === 'function') {
        await emailService.verifyConnection();
      }
      return { status: STATUS.OK, message: 'SMTP সংযোগ যাচাই সফল' };
    } catch (err) {
      return { status: STATUS.ERROR, message: err.message || 'Email চেক ব্যর্থ' };
    }
  });
}

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

async function checkMemory() {
  return timed(async () => {
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
  });
}

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

async function runAllChecks() {
  try {
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

    let overall = STATUS.OK;
    if (database.status === STATUS.ERROR) {
      overall = STATUS.ERROR;
    } else {
      const others = [redis, queueStatus, email, disk, memory];
      if (others.some(c => c.status === STATUS.ERROR)) overall = STATUS.WARN;
      else if (others.some(c => c.status === STATUS.WARN)) overall = STATUS.WARN;
    }

    return { overall, checks, timestamp: new Date().toISOString() };
  } catch (err) {
    return {
      overall: STATUS.ERROR,
      checks: {
        database: { status: STATUS.ERROR, message: err.message },
        redis: { status: STATUS.WARN, message: '—' },
        queue: { status: STATUS.WARN, message: '—' },
        email: { status: STATUS.WARN, message: '—' },
        disk: { status: STATUS.WARN, message: '—' },
        memory: { status: STATUS.WARN, message: '—' },
        uptime: checkUptime()
      },
      timestamp: new Date().toISOString()
    };
  }
}

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
  runDiagnostics: runAllChecks // alias — কিছু জায়গায় এই নামে কল করা হয়
};
