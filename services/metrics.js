// services/metrics.js
// Prometheus মেট্রিক্স — CPU/মেমরি (Node default metrics), HTTP রিকোয়েস্ট কাউন্ট/রেসপন্স টাইম/এরর রেট,
// অ্যাক্টিভ ইউজার, Queue স্ট্যাটাস, Redis ও Database স্বাস্থ্য।
//
// ডিজাইন নীতি: এই মডিউল কখনো মূল রিকোয়েস্ট-রেসপন্স ফ্লো ব্যর্থ করে না। httpMiddleware ব্যর্থ হলেও
// (যেমন prom-client ইনস্টল করা না থাকলে) next() কল হয়ে রিকোয়েস্ট চলতে থাকে; /metrics এন্ডপয়েন্ট
// কোনো সাব-সিস্টেম (DB/Redis/Queue) ডাউন থাকলেও বাকি মেট্রিক্স নিয়ে সাড়া দেয়।

let client;
try {
  client = require('prom-client');
} catch (e) {
  client = null; // প্যাকেজ না থাকলেও অ্যাপ চলতে থাকবে, শুধু /metrics খালি থাকবে
}

const register = client ? new client.Registry() : null;

if (client) {
  client.collectDefaultMetrics({ register, prefix: 'livo_' }); // CPU, মেমরি, event loop lag, GC ইত্যাদি Node-এর ডিফল্ট মেট্রিক্স
}

// ==================== HTTP রিকোয়েস্ট মেট্রিক্স ====================
const httpRequestDuration = client && new client.Histogram({
  name: 'livo_http_request_duration_seconds',
  help: 'HTTP রিকোয়েস্ট রেসপন্স টাইম (সেকেন্ডে)',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register]
});

const httpRequestsTotal = client && new client.Counter({
  name: 'livo_http_requests_total',
  help: 'মোট HTTP রিকোয়েস্ট সংখ্যা',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const httpErrorsTotal = client && new client.Counter({
  name: 'livo_http_errors_total',
  help: 'মোট HTTP এরর রেসপন্স (status >= 400) সংখ্যা',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// ==================== অ্যাপ্লিকেশন-লেভেল Gauge ====================
const activeUsersGauge = client && new client.Gauge({ name: 'livo_active_users', help: 'গত ১৫ মিনিটে সক্রিয় ইউজার সংখ্যা', registers: [register] });
const dbUpGauge = client && new client.Gauge({ name: 'livo_db_up', help: 'Database কানেকশন সচল কিনা (1=up, 0=down)', registers: [register] });
const dbPoolTotalGauge = client && new client.Gauge({ name: 'livo_db_pool_total', help: 'Postgres pool-এর মোট কানেকশন', registers: [register] });
const dbPoolIdleGauge = client && new client.Gauge({ name: 'livo_db_pool_idle', help: 'Postgres pool-এর অলস কানেকশন', registers: [register] });
const dbPoolWaitingGauge = client && new client.Gauge({ name: 'livo_db_pool_waiting', help: 'Postgres pool-এ অপেক্ষমান রিকোয়েস্ট', registers: [register] });
const redisUpGauge = client && new client.Gauge({ name: 'livo_redis_up', help: 'Redis কানেক্টেড কিনা (1=connected, 0=down/disabled)', registers: [register] });
const queuePendingGauge = client && new client.Gauge({ name: 'livo_queue_pending_jobs', help: 'Job queue-তে pending জব সংখ্যা', registers: [register] });
const queueProcessingGauge = client && new client.Gauge({ name: 'livo_queue_processing_jobs', help: 'Job queue-তে processing জব সংখ্যা', registers: [register] });
const queueFailedGauge = client && new client.Gauge({ name: 'livo_queue_failed_jobs', help: 'Job queue-তে failed জব সংখ্যা', registers: [register] });
const queueCompletedGauge = client && new client.Gauge({ name: 'livo_queue_completed_jobs', help: 'Job queue-তে completed জব সংখ্যা', registers: [register] });
const queueWorkerUpGauge = client && new client.Gauge({ name: 'livo_queue_worker_up', help: 'Background job worker চলছে কিনা (1=running, 0=stopped)', registers: [register] });

// ==================== Route path normalize — /users/123 কে /users/:id বানায়, যাতে লেবেল কার্ডিনালিটি না বাড়ে ====================
function normalizeRoute(req) {
  if (req.route && req.route.path) {
    const base = req.baseUrl || '';
    return (base + req.route.path).replace(/\/+/g, '/') || '/';
  }
  // ম্যাচ না পাওয়া রুট (404 ইত্যাদি) — কার্ডিনালিটি বিস্ফোরণ ঠেকাতে path সরাসরি ব্যবহার না করে সাধারণীকরণ
  return (req.path || '/unknown').replace(/\/\d+(?=\/|$)/g, '/:id');
}

/** app.js-এ সবার আগে বসাতে হবে যাতে সব রিকোয়েস্টের সময়/স্ট্যাটাস মাপা যায়। prom-client না থাকলে বা কোনো এরর হলেও রিকোয়েস্ট আটকায় না। */
function httpMiddleware(req, res, next) {
  if (!client) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const route = normalizeRoute(req);
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      httpRequestDuration.observe(labels, durationSec);
      httpRequestsTotal.inc(labels);
      if (res.statusCode >= 400) httpErrorsTotal.inc(labels);
    } catch (err) {
      console.error('[metrics] httpMiddleware finish handler error (non-blocking):', err.message);
    }
  });
  next();
}

/**
 * /metrics স্ক্র্যাপ করার ঠিক আগে কল হয় — অ্যাক্টিভ ইউজার/DB/Redis/Queue-এর সর্বশেষ অবস্থা Gauge-এ বসায়।
 * প্রতিটা সাব-সিস্টেম আলাদা try/catch-এ মোড়ানো, একটা ব্যর্থ হলে বাকিগুলো ঠিকই আপডেট হয়।
 */
async function refreshAsyncMetrics() {
  if (!client) return;

  try {
    const { pool } = require('../db');
    await pool.query('SELECT 1');
    dbUpGauge.set(1);
    dbPoolTotalGauge.set(pool.totalCount || 0);
    dbPoolIdleGauge.set(pool.idleCount || 0);
    dbPoolWaitingGauge.set(pool.waitingCount || 0);

    const activeRes = await pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE last_login > NOW() - INTERVAL '15 minutes'`);
    activeUsersGauge.set(parseInt(activeRes.rows[0].cnt, 10) || 0);
  } catch (err) {
    dbUpGauge.set(0);
    console.error('[metrics] DB metrics refresh error:', err.message);
  }

  try {
    const cache = require('./cache');
    const status = cache.getStatus();
    redisUpGauge.set(status.connected ? 1 : 0);
  } catch (err) {
    redisUpGauge.set(0);
    console.error('[metrics] Redis metrics refresh error:', err.message);
  }

  try {
    const queue = require('./queue');
    const stats = await queue.getStats();
    const qStatus = queue.getStatus();
    queuePendingGauge.set(stats.pending || 0);
    queueProcessingGauge.set(stats.processing || 0);
    queueFailedGauge.set(stats.failed || 0);
    queueCompletedGauge.set(stats.completed || 0);
    queueWorkerUpGauge.set(qStatus.running ? 1 : 0);
  } catch (err) {
    console.error('[metrics] Queue metrics refresh error:', err.message);
  }
}

module.exports = { register, httpMiddleware, refreshAsyncMetrics, enabled: !!client };
