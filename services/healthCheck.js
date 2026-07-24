// services/healthCheck.js
// ==================== System Health Check & Diagnostics ====================
// বিদ্যমান আর্কিটেকচারের প্যাটার্ন অনুসরণ করে লেখা: প্রতিটা চেক নিজে কখনো throw করে না,
// ব্যর্থ হলে { status:'error', message } রিটার্ন করে — একটা সার্ভিস ডাউন থাকলেও
// পুরো ডায়াগনস্টিক রেসপন্স ভেঙে পড়ে না।
//
// status মান তিনটা: 'healthy' | 'warning' | 'error'
// - healthy → স্বাভাবিক
// - warning → কাজ করছে কিন্তু সতর্কতা দরকার (যেমন Redis অফ, ডিস্ক ৮০%+ ভরা)
// - error   → সমস্যা আছে / সার্ভিস আনরিচেবল

const os = require('os');
const fs = require('fs');
const { pool } = require('../db');
const cache = require('./cache');
const queue = require('./queue');
const email = require('./email');

const DISK_WARN_PERCENT = 80;
const DISK_ERROR_PERCENT = 95;
const MEM_WARN_PERCENT = 80;
const MEM_ERROR_PERCENT = 95;
const DB_SLOW_MS = 500; // এর বেশি সময় লাগলে warning

// ==================== PostgreSQL ====================
async function checkDatabase() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const responseTimeMs = Date.now() - start;
    return {
      status: responseTimeMs > DB_SLOW_MS ? 'warning' : 'healthy',
      message: responseTimeMs > DB_SLOW_MS ? `সংযোগ ধীর (${responseTimeMs}ms)` : 'সংযোগ স্বাভাবিক',
      responseTimeMs
    };
  } catch (err) {
    return { status: 'error', message: err.message, responseTimeMs: Date.now() - start };
  }
}

// ==================== Redis ====================
async function checkRedis() {
  const status = cache.getStatus();
  if (!status.enabled) {
    return { status: 'warning', message: status.disabledReason || 'Redis নিষ্ক্রিয় করা আছে (.env)', ...status };
  }
  if (!status.connected) {
    return { status: 'warning', message: status.lastError || 'Redis-এর সাথে সংযোগ নেই — DB fallback ব্যবহার হচ্ছে', ...status };
  }
  return { status: 'healthy', message: 'সংযোগ স্বাভাবিক', ...status };
}

// ==================== Background Job Queue ====================
async function checkQueue() {
  try {
    const st = queue.getStatus();
    const stats = await queue.getStats();
    if (!st.enabled) {
      return { status: 'warning', message: 'কিউ নিষ্ক্রিয় করা আছে (QUEUE_ENABLED=false)', ...st, stats };
    }
    if (!st.running) {
      return { status: 'error', message: 'কিউ enabled কিন্তু ওয়ার্কার চলছে না', ...st, stats };
    }
    const recentError = st.lastErrorAt && (Date.now() - new Date(st.lastErrorAt).getTime()) < 5 * 60 * 1000;
    if (recentError) {
      return { status: 'warning', message: `সাম্প্রতিক এরর: ${st.lastError}`, ...st, stats };
    }
    if (stats.failed > 0) {
      return { status: 'warning', message: `${stats.failed}টি জব ব্যর্থ হয়েছে (রিট্রাই দরকার হতে পারে)`, ...st, stats };
    }
    return { status: 'healthy', message: 'ওয়ার্কার চালু এবং স্বাভাবিক', ...st, stats };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ==================== Email (SMTP) ====================
async function checkEmail() {
  try {
    const result = await email.verifyConnection();
    if (!result.configured) return { status: 'warning', message: result.message };
    if (!result.ok) return { status: 'error', message: result.message, responseTimeMs: result.responseTimeMs };
    return { status: 'healthy', message: result.message, responseTimeMs: result.responseTimeMs };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ==================== ডিস্ক স্পেস ====================
function checkDisk() {
  try {
    if (typeof fs.statfsSync !== 'function') {
      return { status: 'warning', message: 'এই Node.js ভার্সনে ডিস্ক-চেক সমর্থিত না' };
    }
    const stats = fs.statfsSync(process.cwd());
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

    let status = 'healthy';
    if (usedPercent >= DISK_ERROR_PERCENT) status = 'error';
    else if (usedPercent >= DISK_WARN_PERCENT) status = 'warning';

    return {
      status,
      message: `${usedPercent}% ব্যবহৃত`,
      totalGB: +(totalBytes / (1024 ** 3)).toFixed(2),
      freeGB: +(freeBytes / (1024 ** 3)).toFixed(2),
      usedPercent
    };
  } catch (err) {
    return { status: 'warning', message: 'ডিস্ক পরিমাপ করা যায়নি: ' + err.message };
  }
}

// ==================== মেমরি ব্যবহার ====================
function checkMemory() {
  try {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedSystemPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

    let status = 'healthy';
    if (usedSystemPercent >= MEM_ERROR_PERCENT) status = 'error';
    else if (usedSystemPercent >= MEM_WARN_PERCENT) status = 'warning';

    return {
      status,
      message: `সিস্টেম মেমরির ${usedSystemPercent}% ব্যবহৃত`,
      usedPercent: usedSystemPercent,
      totalMB: Math.round(totalMem / (1024 ** 2)),
      freeMB: Math.round(freeMem / (1024 ** 2)),
      heapUsedMB: Math.round(mem.heapUsed / (1024 ** 2)),
      heapTotalMB: Math.round(mem.heapTotal / (1024 ** 2)),
      rssMB: Math.round(mem.rss / (1024 ** 2))
    };
  } catch (err) {
    return { status: 'warning', message: 'মেমরি পরিমাপ করা যায়নি: ' + err.message };
  }
}

// ==================== আপটাইম ====================
function checkUptime() {
  const appSeconds = Math.floor(process.uptime());
  const hostSeconds = Math.floor(os.uptime());
  return {
    status: 'healthy',
    message: formatDuration(appSeconds),
    appUptimeSeconds: appSeconds,
    hostUptimeSeconds: hostSeconds
  };
}

function formatDuration(totalSeconds) {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} দিন`);
  if (h) parts.push(`${h} ঘণ্টা`);
  parts.push(`${m} মিনিট`);
  return parts.join(' ');
}

// ==================== সার্বিক সিস্টেম ডায়াগনস্টিকস — সব চেক সমান্তরালে চালানো হয় ====================
async function runDiagnostics() {
  const [database, redis, queueCheck, emailCheck] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    checkEmail()
  ]);
  const disk = checkDisk();
  const memory = checkMemory();
  const uptime = checkUptime();

  const checks = { database, redis, queue: queueCheck, email: emailCheck, disk, memory, uptime };

  // সার্বিক স্ট্যাটাস: যেকোনো একটা 'error' হলে সার্বিক error, নাহলে যেকোনো 'warning' থাকলে warning, নাহলে healthy
  const values = Object.values(checks).map(c => c.status);
  let overall = 'healthy';
  if (values.includes('error')) overall = 'error';
  else if (values.includes('warning')) overall = 'warning';

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    checks
  };
}

module.exports = {
  runDiagnostics,
  checkDatabase,
  checkRedis,
  checkQueue,
  checkEmail,
  checkDisk,
  checkMemory,
  checkUptime
};
