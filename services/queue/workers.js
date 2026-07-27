// services/queue/workers.js
// প্রতিটি Queue-এর Worker — job প্রসেস করে।
// Redis না থাকলে কোনো Worker শুরু হয় না।

const { Worker } = require('bullmq');
const { getConnection, isAvailable } = require('./connection');
const { pool } = require('../../db');

let workersStarted = false;
const activeWorkers = [];

// ==================== Email Worker ====================
function processEmail(job) {
  const { type } = job;
  const { sendOTP, sendPasswordReset, sendWelcome } = require('../email');
  const data = job.data;

  switch (data.emailType || job.name) {
    case 'otp':         return sendOTP(data.email, data.otp);
    case 'resetPass':   return sendPasswordReset(data.email, data.resetUrl);
    case 'welcome':     return sendWelcome ? sendWelcome(data.email, data.username) : Promise.resolve();
    default:
      console.warn('[queue:email] অজানা email job:', job.name);
      return Promise.resolve();
  }
}

// ==================== Notification Worker ====================
async function processNotification(job) {
  const data = job.data;
  switch (job.name) {
    case 'webPush': {
      const { sendAdminPush } = require('../push');
      if (sendAdminPush) await sendAdminPush(data.title, data.body, data.url);
      break;
    }
    case 'socketBroadcast': {
      const { getIo } = require('../socket');
      const io = getIo ? getIo() : null;
      if (io && data.event) io.emit(data.event, data.payload || {});
      break;
    }
    default:
      console.warn('[queue:notification] অজানা notification job:', job.name);
  }
}

// ==================== Activity Log Worker ====================
async function processActivityLog(job) {
  const { adminId, adminUsername, actionType, details, ip } = job.data;
  const { logAdminAction } = require('../auditLog');
  await logAdminAction(adminId || null, adminUsername || 'SYSTEM', actionType, details, ip || null);
}

// ==================== API Log Worker ====================
async function processApiLog(job) {
  const d = job.data;
  await pool.query(
    `INSERT INTO api_logs (method, endpoint, status_code, response_time_ms, user_id, ip, user_agent, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING`,
    [d.method, d.endpoint, d.statusCode, d.responseTimeMs, d.userId || null, d.ip || null, d.userAgent || null, d.errorMessage || null]
  ).catch(() => {}); // api_logs টেবিল না থাকলে silently skip
}

// ==================== Fraud Scan Worker ====================
async function processFraudScan(job) {
  const { userId, context } = job.data;
  if (!userId) return;
  const { evaluateDuplicateAccount } = require('../duplicateDetection');
  await evaluateDuplicateAccount(userId, context || {});
}

// ==================== Background Worker ====================
async function processBackground(job) {
  switch (job.name) {
    case 'dbBackup': {
      const { runBackupNow } = require('../backup');
      if (runBackupNow) await runBackupNow();
      break;
    }
    case 'matchSync': {
      const { syncMatches } = require('../matchUpdater');
      await syncMatches();
      break;
    }
    default:
      console.warn('[queue:background] অজানা background job:', job.name);
  }
}

// ==================== Worker Registry ====================
const WORKER_MAP = {
  email:        processEmail,
  notification: processNotification,
  activityLog:  processActivityLog,
  apiLog:       processApiLog,
  fraudScan:    processFraudScan,
  background:   processBackground,
};

const WORKER_CONCURRENCY = {
  email:        3,
  notification: 5,
  activityLog:  5,
  apiLog:       5,
  fraudScan:    2,
  background:   2,
};

function startWorkers() {
  if (workersStarted) return;
  if (!isAvailable()) {
    console.warn('[queue] Redis অনুপলব্ধ — Workers শুরু হবে না (Queue ছাড়াই সব কাজ করবে)');
    return;
  }
  workersStarted = true;

  for (const [name, processor] of Object.entries(WORKER_MAP)) {
    const worker = new Worker(name, processor, {
      connection: getConnection(),
      concurrency: WORKER_CONCURRENCY[name] || 3,
    });

    worker.on('completed', (job) => {
      if (process.env.QUEUE_DEBUG) console.log(`[queue:${name}] ✅ Job #${job.id} (${job.name}) সম্পন্ন`);
    });
    worker.on('failed', (job, err) => {
      console.error(`[queue:${name}] ❌ Job #${job?.id} (${job?.name}) ব্যর্থ (attempt ${job?.attemptsMade}):`, err.message);
    });
    worker.on('error', (err) => {
      console.error(`[queue:${name}] worker error:`, err.message);
    });

    activeWorkers.push(worker);
    console.log(`[queue] ✅ Worker শুরু: ${name}`);
  }
}

async function stopWorkers() {
  for (const w of activeWorkers) {
    try { await w.close(); } catch (e) {}
  }
  console.log('[queue] সব Worker বন্ধ');
}

module.exports = { startWorkers, stopWorkers, activeWorkers };
