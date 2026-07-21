// services/queue.js
// Postgres-backed ব্যাকগ্রাউন্ড জব কিউ। Redis-এর মতো বাইরের সার্ভিসের উপর নির্ভর করে না —
// একই DB ব্যবহার করে বলে আলাদা কোনো ইনফ্রাস্ট্রাকচার লাগে না, এবং job_queue টেবিলেই
// জব-গুলো persist থাকে (সার্ভার রিস্টার্ট হলেও হারায় না)।
//
// ডিজাইনের মূলনীতি: enqueue() কখনো throw করে না এবং কখনো caller-কে ব্লক করে না।
// ওয়ার্কার লুপ ব্যাকগ্রাউন্ডে আলাদাভাবে চলে; ওয়ার্কার ক্র্যাশ করলে বা কিউ বন্ধ থাকলে
// ওয়েবসাইটের কোনো রিকোয়েস্ট-রেসপন্স ফ্লো প্রভাবিত হয় না।

const { pool } = require('../db');

const POLL_INTERVAL_MS = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '2000', 10);
const BATCH_SIZE = parseInt(process.env.QUEUE_BATCH_SIZE || '5', 10);
const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10);
const QUEUE_ENABLED = String(process.env.QUEUE_ENABLED || 'true').toLowerCase() !== 'false';

const handlers = new Map(); // type -> async (payload) => void
const state = {
  running: false,
  timer: null,
  lastTickAt: null,
  lastError: null,
  lastErrorAt: null,
  processedCount: 0,
  failedCount: 0
};

function registerHandler(type, fn) {
  handlers.set(type, fn);
}

/**
 * নতুন জব কিউতে যোগ করে। কখনো throw করে না — DB সমস্যা হলেও caller-এর ফ্লো ভাঙে না।
 * ব্যর্থ হলে null রিটার্ন করে, caller চাইলে ফলব্যাক হিসেবে সরাসরি সিঙ্ক্রোনাসভাবে কাজটা করতে পারে।
 */
async function enqueue(type, payload = {}, opts = {}) {
  try {
    const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    const availableAt = opts.delaySeconds ? new Date(Date.now() + opts.delaySeconds * 1000) : new Date();
    const r = await pool.query(
      `INSERT INTO job_queue (type, payload, max_attempts, available_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [type, JSON.stringify(payload), maxAttempts, availableAt]
    );
    return r.rows[0]?.id || null;
  } catch (err) {
    console.error('[queue] enqueue error (non-blocking):', err.message);
    return null;
  }
}

function backoffSeconds(attempts) {
  // exponential backoff: 10s, 40s, 90s, ... ক্যাপ ৩০ মিনিট
  return Math.min(10 * Math.pow(2, attempts), 1800);
}

async function processOneBatch() {
  // FOR UPDATE SKIP LOCKED — একাধিক ওয়ার্কার/ইনস্ট্যান্স একই সাথে চললেও একই জব দুইবার প্রসেস হবে না
  const client = await pool.connect();
  let jobs = [];
  try {
    await client.query('BEGIN');
    const picked = await client.query(
      `SELECT * FROM job_queue
       WHERE status = 'pending' AND available_at <= NOW()
       ORDER BY id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE]
    );
    jobs = picked.rows;
    if (jobs.length) {
      const ids = jobs.map(j => j.id);
      await client.query(
        `UPDATE job_queue SET status = 'processing', started_at = NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const job of jobs) {
    await runJob(job);
  }
  return jobs.length;
}

async function runJob(job) {
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`কোনো হ্যান্ডলার রেজিস্টার করা নেই টাইপের জন্য: "${job.type}"`);
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    await handler(payload);
    await pool.query(
      `UPDATE job_queue SET status = 'completed', completed_at = NOW(), attempts = attempts + 1 WHERE id = $1`,
      [job.id]
    );
    state.processedCount++;
  } catch (err) {
    const attempts = job.attempts + 1;
    const errMsg = (err && err.message) ? err.message.slice(0, 500) : String(err).slice(0, 500);
    console.error(`[queue] job #${job.id} (${job.type}) failed (attempt ${attempts}/${job.max_attempts}):`, errMsg);

    if (attempts >= job.max_attempts) {
      await pool.query(
        `UPDATE job_queue SET status = 'failed', attempts = $1, last_error = $2, completed_at = NOW() WHERE id = $3`,
        [attempts, errMsg, job.id]
      );
      state.failedCount++;
    } else {
      const retryAt = new Date(Date.now() + backoffSeconds(attempts) * 1000);
      await pool.query(
        `UPDATE job_queue SET status = 'pending', attempts = $1, last_error = $2, available_at = $3 WHERE id = $4`,
        [attempts, errMsg, retryAt, job.id]
      );
    }
  }
}

async function tick() {
  state.lastTickAt = new Date();
  try {
    await processOneBatch();
  } catch (err) {
    state.lastError = err.message;
    state.lastErrorAt = new Date();
    console.error('[queue] worker tick error (non-blocking, will retry next tick):', err.message);
  }
}

function startWorker() {
  if (!QUEUE_ENABLED) {
    console.log('[queue] disabled via .env (QUEUE_ENABLED=false) — জব শুধু জমা হবে, প্রসেস হবে না');
    return;
  }
  if (state.running) return;
  state.running = true;
  state.timer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  console.log(`[queue] worker started (poll every ${POLL_INTERVAL_MS}ms, batch ${BATCH_SIZE})`);
}

function stopWorker() {
  if (state.timer) clearInterval(state.timer);
  state.running = false;
}

/** ব্যর্থ জব আবার pending-এ ফেরত পাঠায় (ম্যানুয়াল রিট্রাই, অ্যাডমিন প্যানেল থেকে) */
async function retryJob(jobId) {
  const r = await pool.query(
    `UPDATE job_queue SET status = 'pending', available_at = NOW(), last_error = NULL
     WHERE id = $1 AND status = 'failed' RETURNING id`,
    [jobId]
  );
  return r.rows.length > 0;
}

async function retryAllFailed(type = null) {
  const params = type ? [type] : [];
  const where = type ? `WHERE status = 'failed' AND type = $1` : `WHERE status = 'failed'`;
  const r = await pool.query(`UPDATE job_queue SET status = 'pending', available_at = NOW(), last_error = NULL ${where} RETURNING id`, params);
  return r.rows.length;
}

async function getStats() {
  const r = await pool.query(`SELECT status, COUNT(*) FROM job_queue GROUP BY status`);
  const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of r.rows) counts[row.status] = parseInt(row.count, 10);
  return counts;
}

function getStatus() {
  return {
    enabled: QUEUE_ENABLED,
    running: state.running,
    registeredTypes: [...handlers.keys()],
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    processedCount: state.processedCount,
    failedCount: state.failedCount
  };
}

module.exports = {
  registerHandler,
  enqueue,
  startWorker,
  stopWorker,
  retryJob,
  retryAllFailed,
  getStats,
  getStatus
};
