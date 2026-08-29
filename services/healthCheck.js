// services/healthCheck.js
// সব সার্ভিসের health পরীক্ষা করে।
// প্রতিটি চেক স্বাধীনভাবে timeout-safe — একটা ব্যর্থ হলেও বাকিগুলো চলে।

const os = require('os');
const { execSync } = require('child_process');

const APP_START_TIME = Date.now();

// ==================== helpers ====================
function ms(start) { return Date.now() - start; }
function toMB(bytes) { return Math.round(bytes / 1024 / 1024); }

function withTimeout(promise, timeoutMs = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  ]);
}

// ==================== PostgreSQL ====================
async function checkPostgres() {
  const t = Date.now();
  try {
    const { pool } = require('../db');
    const r = await withTimeout(pool.query('SELECT 1'), 3000);
    const row = await withTimeout(pool.query(`SELECT COUNT(*) FROM users`), 3000);
    return { status: 'healthy', latencyMs: ms(t), userCount: parseInt(row.rows[0].count) };
  } catch (err) {
    return { status: 'error', latencyMs: ms(t), error: err.message };
  }
}

// ==================== Redis ====================
async function checkRedis() {
  const t = Date.now();
  try {
    const { isAvailable: cacheAvailable, getStatus } = require('./cache');
    const st = getStatus();
    if (!cacheAvailable()) {
      return { status: 'warning', latencyMs: ms(t), note: st.disabledReason || 'Redis unavailable' };
    }
    // ping via cache set/get
    const { set, get, del } = require('./cache');
    const key = '_health_ping_' + Date.now();
    await withTimeout(set(key, '1', 5), 2000);
    await withTimeout(del(key), 2000);
    return { status: 'healthy', latencyMs: ms(t) };
  } catch (err) {
    return { status: 'warning', latencyMs: ms(t), error: err.message };
  }
}

// ==================== Queue ====================
// নোট: পুরনো services/queue/ (BullMQ+Redis ফোল্ডার) ২৮ জুলাই "dead duplicate" হিসেবে
// সরানো হয়েছিল — এখন services/queue.js (Postgres-backed job_queue) হলো একমাত্র সক্রিয়
// কিউ সিস্টেম (app.js দেখুন)। এই ফাংশনটা তখন আপডেট হয়নি বলে চুপচাপ ব্যর্থ হচ্ছিল।
async function checkQueue() {
  const t = Date.now();
  try {
    const { getHealthStatus, getStats } = require('./queue');
    const [health, stats] = await Promise.all([
      withTimeout(getHealthStatus(), 3000),
      withTimeout(getStats(), 3000)
    ]);
    const status = health.level === 'error' ? 'error' : health.level === 'warning' ? 'warning' : 'healthy';
    return {
      status,
      latencyMs: ms(t),
      running: health.running,
      issues: health.issues,
      totalPending: stats.pending,
      totalProcessing: stats.processing,
      totalFailed: stats.failed,
      totalDeadLetter: stats.deadLetter
    };
  } catch (err) {
    return { status: 'warning', latencyMs: ms(t), error: err.message };
  }
}

// ==================== Email ====================
async function checkEmail() {
  const t = Date.now();
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return { status: 'warning', latencyMs: ms(t), note: 'EMAIL_USER / EMAIL_PASS সেট নেই' };
    }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false }
    });
    await withTimeout(transporter.verify(), 5000);
    return { status: 'healthy', latencyMs: ms(t), provider: 'smtp.gmail.com' };
  } catch (err) {
    return { status: 'warning', latencyMs: ms(t), error: err.message };
  }
}

// ==================== Memory ====================
function checkMemory() {
  const used = process.memoryUsage();
  const totalMB   = toMB(os.totalmem());
  const freeMB    = toMB(os.freemem());
  const heapUsed  = toMB(used.heapUsed);
  const heapTotal = toMB(used.heapTotal);
  const rss       = toMB(used.rss);
  const usagePct  = Math.round(((totalMB - freeMB) / totalMB) * 100);
  return {
    status: usagePct > 90 ? 'error' : usagePct > 75 ? 'warning' : 'healthy',
    totalMB, freeMB, heapUsedMB: heapUsed, heapTotalMB: heapTotal, rssMB: rss, usagePct
  };
}

// ==================== Disk ====================
function checkDisk() {
  try {
    const out = execSync('df -k / 2>/dev/null', { timeout: 2000 }).toString().trim().split('\n');
    const parts = out[1].trim().split(/\s+/);
    const total   = Math.round(parseInt(parts[1]) / 1024);
    const used    = Math.round(parseInt(parts[2]) / 1024);
    const avail   = Math.round(parseInt(parts[3]) / 1024);
    const usePct  = parseInt(parts[4]);
    return {
      status: usePct > 90 ? 'error' : usePct > 75 ? 'warning' : 'healthy',
      totalMB: total, usedMB: used, availMB: avail, usagePct: usePct
    };
  } catch (err) {
    return { status: 'warning', error: 'disk check unavailable' };
  }
}

// ==================== Uptime ====================
function checkUptime() {
  const appUptimeSec  = Math.floor((Date.now() - APP_START_TIME) / 1000);
  const sysUptimeSec  = Math.floor(os.uptime());
  const fmt = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
  };
  return {
    status: 'healthy',
    appUptime: fmt(appUptimeSec), appUptimeSec,
    sysUptime: fmt(sysUptimeSec), sysUptimeSec,
    nodeVersion: process.version,
    platform: process.platform,
    cpus: os.cpus().length,
    pid: process.pid
  };
}

// ==================== Full Diagnostics ====================
async function runAllChecks() {
  const [pg, redis, queue, email] = await Promise.allSettled([
    checkPostgres(), checkRedis(), checkQueue(), checkEmail()
  ]);

  const memory = checkMemory();
  const disk   = checkDisk();
  const uptime = checkUptime();

  const pick = (settled) => settled.status === 'fulfilled' ? settled.value : { status: 'error', error: settled.reason?.message };

  const checks = {
    postgres: pick(pg),
    redis:    pick(redis),
    queue:    pick(queue),
    email:    pick(email),
    memory,
    disk,
    uptime,
  };

  // সামগ্রিক status — যেকোনো 'error' থাকলে error, 'warning' থাকলে warning
  const statuses = Object.values(checks).map(c => c.status);
  const overall  = statuses.includes('error') ? 'error' : statuses.includes('warning') ? 'warning' : 'healthy';

  return { overall, timestamp: new Date().toISOString(), checks };
}

// ==================== Liveness & Readiness ====================
async function liveness() {
  // শুধু প্রসেস জীবিত কিনা — সবসময় 200
  return { status: 'ok', uptime: Math.floor((Date.now() - APP_START_TIME) / 1000) };
}

async function readiness() {
  // PHASE 2 fix: শুধু DB ping যথেষ্ট নয় — migration ব্যর্থ হলে schema ভাঙা থাকে,
  // সেই অবস্থায় /ready কখনো healthy দেখাবে না (no fake success)।
  const startupState = require('./startupState');
  if (!startupState.isSchemaReady()) {
    const { migrationError } = startupState.getState();
    throw new Error('Schema not ready: migrations did not complete' + (migrationError ? ` (${migrationError})` : ''));
  }

  // DB connect হলেই ready
  try {
    const { pool } = require('../db');
    await withTimeout(pool.query('SELECT 1'), 2000);
    return { status: 'ready' };
  } catch (err) {
    throw new Error('DB not ready: ' + err.message);
  }
}

module.exports = { runAllChecks, liveness, readiness };
