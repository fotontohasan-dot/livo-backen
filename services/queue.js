// services/queue.js
// Postgres-backed ব্যাকগ্রাউন্ড জব কিউ। Redis-এর মতো বাইরের সার্ভিসের উপর নির্ভর করে না —
// একই DB ব্যবহার করে বলে আলাদা কোনো ইনফ্রাস্ট্রাকচার লাগে না, এবং job_queue টেবিলেই
// জব-গুলো persist থাকে (সার্ভার রিস্টার্ট হলেও হারায় না)।
//
// ডিজাইনের মূলনীতি: enqueue() কখনো throw করে না এবং কখনো caller-কে ব্লক করে না।
// ওয়ার্কার লুপ ব্যাকগ্রাউন্ডে আলাদাভাবে চলে; ওয়ার্কার ক্র্যাশ করলে বা কিউ বন্ধ থাকলে
// ওয়েবসাইটের কোনো রিকোয়েস্ট-রেসপন্স ফ্লো প্রভাবিত হয় না।

const { pool } = require('../db');
const sentryService = require('./sentry');

const POLL_INTERVAL_MS = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '2000', 10);
const BATCH_SIZE = parseInt(process.env.QUEUE_BATCH_SIZE || '5', 10);
const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10);
const QUEUE_ENABLED = String(process.env.QUEUE_ENABLED || 'true').toLowerCase() !== 'false';
// 'processing'-এ কত পুরোনো হলে জব stalled ধরা হবে (ওয়ার্কার ক্র্যাশ/রিস্টার্ট রিকভারি ও হেলথ চেক — দুটোতেই ব্যবহৃত)
const STALLED_THRESHOLD_MS = parseInt(process.env.QUEUE_STALLED_THRESHOLD_MS || '300000', 10); // ৫ মিনিট

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
    // Stalled job recovery — কন্টেইনার রিস্টার্ট/ক্র্যাশে (Docker SIGTERM, redeploy) যেসব জব
    // 'processing' অবস্থায় আটকে ছিল সেগুলো আর কখনো তোলা হতো না, কারণ নিচের কোয়েরি শুধু
    // 'pending' খোঁজে। থ্রেশহোল্ডের চেয়ে পুরোনো হলে আবার pending-এ ফেরত পাঠানো হচ্ছে যাতে
    // অন্তত একবার প্রসেস হওয়ার নিশ্চয়তা থাকে (attempts বাড়ে না — এটা ওয়ার্কার ব্যর্থতা,
    // জব ব্যর্থতা নয়; max-attempts লজিক অপরিবর্তিত)।
    await client.query(
      `UPDATE job_queue SET status = 'pending', started_at = NULL
       WHERE status = 'processing' AND started_at < NOW() - ($1 || ' milliseconds')::interval`,
      [STALLED_THRESHOLD_MS]
    );
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
  const startedAt = job.started_at ? new Date(job.started_at) : new Date();
  try {
    if (!handler) throw new Error(`কোনো হ্যান্ডলার রেজিস্টার করা নেই টাইপের জন্য: "${job.type}"`);
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    await handler(payload);
    const durationMs = Date.now() - startedAt.getTime();
    await pool.query(
      `UPDATE job_queue SET status = 'completed', completed_at = NOW(), attempts = attempts + 1, duration_ms = $2 WHERE id = $1`,
      [job.id, durationMs]
    );
    state.processedCount++;
  } catch (err) {
    const attempts = job.attempts + 1;
    const errMsg = (err && err.message) ? err.message.slice(0, 500) : String(err).slice(0, 500);
    console.error(`[queue] job #${job.id} (${job.type}) failed (attempt ${attempts}/${job.max_attempts}):`, errMsg);

    // কনসোল লগ ও dead_letter_jobs রেকর্ডিং-এর পাশাপাশি Sentry-তেও রিপোর্ট — services/sentry.js-এর
    // captureException() নিজে কখনো থ্রো করে না এবং DSN/SENTRY_ENABLED না থাকলে no-op, তাই queue-এর
    // retry/DLQ লজিক এতে প্রভাবিত হয় না।
    sentryService.captureException(err instanceof Error ? err : new Error(errMsg), {
      source: 'queue.runJob', jobId: job.id, jobType: job.type, attempts, maxAttempts: job.max_attempts
    });

    if (attempts >= job.max_attempts) {
      const durationMs = Date.now() - startedAt.getTime();
      await pool.query(
        `UPDATE job_queue SET status = 'failed', attempts = $1, last_error = $2, completed_at = NOW(), duration_ms = $3 WHERE id = $4`,
        [attempts, errMsg, durationMs, job.id]
      );
      state.failedCount++;
      await moveToDeadLetter(job, attempts, errMsg);
    } else {
      const retryAt = new Date(Date.now() + backoffSeconds(attempts) * 1000);
      await pool.query(
        `UPDATE job_queue SET status = 'pending', attempts = $1, last_error = $2, available_at = $3 WHERE id = $4`,
        [attempts, errMsg, retryAt, job.id]
      );
    }
  }
}

/** স্থায়ীভাবে ব্যর্থ জব (max_attempts শেষ) DLQ-তে আর্কাইভ করে — job_queue row অপরিবর্তিত থাকে */
async function moveToDeadLetter(job, attempts, errMsg) {
  try {
    await pool.query(
      `INSERT INTO dead_letter_jobs (original_job_id, type, payload, attempts, max_attempts, last_error, job_created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [job.id, job.type, typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload), attempts, job.max_attempts, errMsg, job.created_at]
    );
  } catch (err) {
    console.error('[queue] failed to archive job into dead letter queue (non-blocking):', err.message);
  }
}

// ==================== ওভারল্যাপ গার্ড (অডিট P2-14) ====================
// startWorker() একটা setInterval দিয়ে প্রতি POLL_INTERVAL_MS-এ tick() ডাকে। একটা ব্যাচ
// ইন্টারভালের চেয়ে বেশি সময় নিলে (ধীর হ্যান্ডলার, ইমেইল/HTTP কল) আগের tick শেষ হওয়ার
// আগেই পরেরটা শুরু হয়ে যেত এবং tick-গুলো জমতে থাকত। প্রতিটা tick একটা pool client
// ধরে রাখে, আর pg.Pool-এর ডিফল্ট সিলিং ১০ — অর্থাৎ কিউ ধীর হলে সেটা ওয়েব রিকোয়েস্টের
// কানেকশনও খেয়ে ফেলতে পারত। FOR UPDATE SKIP LOCKED একই জব দুবার তোলা আটকাত, কিন্তু
// কানেকশন-ক্ষুধা আটকাত না। এখন একসাথে সর্বোচ্চ একটাই tick চলে।
let tickInFlight = false;

async function tick() {
  if (tickInFlight) {
    // আগের ব্যাচ এখনো চলছে — এই টিকটা নীরবে বাদ, পরের ইন্টারভালে আবার চেষ্টা হবে।
    return;
  }
  tickInFlight = true;
  state.lastTickAt = new Date();
  try {
    await processOneBatch();
  } catch (err) {
    state.lastError = err.message;
    state.lastErrorAt = new Date();
    console.error('[queue] worker tick error (non-blocking, will retry next tick):', err.message);
  } finally {
    tickInFlight = false;
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
  const [r, dlq] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) FROM job_queue GROUP BY status`),
    pool.query(`SELECT COUNT(*) FROM dead_letter_jobs`)
  ]);
  const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of r.rows) counts[row.status] = parseInt(row.count, 10);
  counts.deadLetter = parseInt(dlq.rows[0].count, 10);
  return counts;
}

/** টাইপ অনুযায়ী ব্রেকডাউন — অ্যাডমিন প্যানেলের মনিটরিং সেকশনের জন্য */
async function getStatsByType() {
  const r = await pool.query(`
    SELECT type,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending,
           COUNT(*) FILTER (WHERE status = 'processing') AS processing,
           COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed,
           ROUND(AVG(duration_ms) FILTER (WHERE status = 'completed'))::int AS avg_duration_ms
    FROM job_queue
    GROUP BY type
    ORDER BY type
  `);
  return r.rows.map(row => ({
    type: row.type,
    pending: parseInt(row.pending, 10),
    processing: parseInt(row.processing, 10),
    completed: parseInt(row.completed, 10),
    failed: parseInt(row.failed, 10),
    avgDurationMs: row.avg_duration_ms || 0
  }));
}

/** গত N ঘণ্টার প্রতি ঘণ্টায় সম্পন্ন হওয়া জবের সংখ্যা — থ্রুপুট চার্টের জন্য */
async function getThroughput(hours = 24) {
  const r = await pool.query(
    `SELECT date_trunc('hour', completed_at) AS hour,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed
     FROM job_queue
     WHERE completed_at >= NOW() - ($1 || ' hours')::interval
     GROUP BY hour ORDER BY hour ASC`,
    [hours]
  );
  return r.rows.map(row => ({
    hour: row.hour,
    completed: parseInt(row.completed, 10),
    failed: parseInt(row.failed, 10)
  }));
}


/** কিউ হেলথ স্ট্যাটাস — Healthy/Warning/Error, System Diagnostics পেজেও ব্যবহৃত হয় */
async function getHealthStatus() {
  const issues = [];
  let level = 'healthy';

  if (!QUEUE_ENABLED) {
    level = 'error';
    issues.push('কিউ ওয়ার্কার .env-এ ডিসেবল করা আছে (QUEUE_ENABLED=false)');
  } else if (!state.running) {
    level = 'error';
    issues.push('কিউ ওয়ার্কার চালু নেই');
  } else if (state.lastTickAt && (Date.now() - state.lastTickAt.getTime()) > POLL_INTERVAL_MS * 5) {
    level = 'warning';
    issues.push('ওয়ার্কার প্রত্যাশিত সময়ে টিক করেনি — সম্ভবত স্টল হয়ে আছে');
  }

  let stalledJobs = 0, oldestPendingAgeSec = 0;
  try {
    const [stalled, oldest] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM job_queue WHERE status = 'processing' AND started_at < NOW() - ($1 || ' milliseconds')::interval`,
        [STALLED_THRESHOLD_MS]
      ),
      pool.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(available_at)))::int AS age
         FROM job_queue WHERE status = 'pending'`
      )
    ]);
    stalledJobs = parseInt(stalled.rows[0].count, 10);
    if (stalledJobs > 0) {
      if (level === 'healthy') level = 'warning';
      issues.push(`${stalledJobs}টি জব ${Math.round(STALLED_THRESHOLD_MS / 60000)} মিনিটের বেশি সময় ধরে "processing"-এ আটকে আছে`);
    }

    oldestPendingAgeSec = oldest.rows[0].age || 0;
    if (oldestPendingAgeSec > 900) {
      if (level === 'healthy') level = 'warning';
      issues.push(`সবচেয়ে পুরনো pending জব ${Math.round(oldestPendingAgeSec / 60)} মিনিট ধরে অপেক্ষায় আছে`);
    }
  } catch (err) {
    level = 'error';
    issues.push('হেলথ চেক ব্যর্থ: ' + err.message);
  }

  return {
    level, // healthy | warning | error
    issues,
    enabled: QUEUE_ENABLED,
    running: state.running,
    lastTickAt: state.lastTickAt,
    stalledJobs,
    oldestPendingAgeSec
  };
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

// ==================== Dead Letter Queue ম্যানেজমেন্ট ====================
async function getDeadLetterJobs({ type = '' } = {}, limit = 25, offset = 0) {
  const params = [];
  let where = '';
  if (type) { params.push(type); where = `WHERE type = $${params.length}`; }
  const listParams = [...params, limit, offset];
  const [r, countR] = await Promise.all([
    pool.query(
      `SELECT * FROM dead_letter_jobs ${where} ORDER BY id DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    ),
    pool.query(`SELECT COUNT(*) FROM dead_letter_jobs ${where}`, params)
  ]);
  return { rows: r.rows, total: parseInt(countR.rows[0].count, 10) };
}

/** DLQ থেকে জব আবার active কিউতে (pending) ফেরত পাঠায় */
async function requeueDeadLetter(dlqId) {
  const r = await pool.query(`SELECT * FROM dead_letter_jobs WHERE id = $1`, [dlqId]);
  const row = r.rows[0];
  if (!row) return false;

  await pool.query(
    `INSERT INTO job_queue (type, payload, max_attempts, available_at, status)
     VALUES ($1,$2,$3,NOW(),'pending')`,
    [row.type, row.payload, row.max_attempts]
  );
  await pool.query(`DELETE FROM dead_letter_jobs WHERE id = $1`, [dlqId]);
  return true;
}

async function purgeDeadLetter(dlqId) {
  const r = await pool.query(`DELETE FROM dead_letter_jobs WHERE id = $1 RETURNING id`, [dlqId]);
  return r.rows.length > 0;
}

async function purgeAllDeadLetter(olderThanDays = null) {
  const params = [];
  let where = '';
  if (olderThanDays) { params.push(olderThanDays); where = `WHERE dead_lettered_at < NOW() - ($1 || ' days')::interval`; }
  const r = await pool.query(`DELETE FROM dead_letter_jobs ${where} RETURNING id`, params);
  return r.rows.length;
}

module.exports = {
  registerHandler,
  enqueue,
  startWorker,
  stopWorker,
  retryJob,
  retryAllFailed,
  getStats,
  getStatsByType,
  getThroughput,
  getHealthStatus,
  getStatus,
  getDeadLetterJobs,
  requeueDeadLetter,
  purgeDeadLetter,
  purgeAllDeadLetter
};
