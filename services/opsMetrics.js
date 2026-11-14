// services/opsMetrics.js
// ---------------------------------------------------------------------------
// Step 4 D1 — /metrics-এ যোগ হওয়া অপারেশনাল গেজ: Redis মেমরি/কানেকশন (দুই ইনস্ট্যান্স আলাদা),
// BullMQ কিউ ডেপথ, api-log ড্রপ/পেন্ডিং, circuit breaker অবস্থা, DB pool in-use।
//
// event loop lag, process মেমরি → services/metrics.js-এর collectDefaultMetrics (bet420_nodejs_eventloop_lag_*,
// bet420_process_resident_memory_bytes)। 5xx রেট → bet420_http_requests_total{status_code=~"5.."}-এর PromQL।
// job_queue (Postgres) ডেপথ → বিদ্যমান bet420_queue_pending_jobs।
//
// ডিজাইন নীতি: services/metrics.js-এর মতোই — কোনো সাব-সিস্টেম ডাউন থাকলে বাকিগুলো ঠিকই আপডেট হয়,
// কখনো throw করে না, কোনো রিকোয়েস্ট আটকায় না। কোনো secret/URL লেবেলে যায় না (শুধু instance নাম)।
// ---------------------------------------------------------------------------

const REDIS_INFO_TIMEOUT_MS = Number(process.env.METRICS_REDIS_TIMEOUT_MS) || 1500;
const REDIS_INFO_CACHE_MS = Number(process.env.METRICS_REDIS_CACHE_MS) || 5000;

const BREAKER_STATE_VALUE = { closed: 0, half_open: 1, open: 2 };

/** `INFO` টেক্সট থেকে "key:value" লাইনগুলো অবজেক্টে। কমেন্ট (#) ও ফাঁকা লাইন বাদ। */
function parseRedisInfo(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** parse করা INFO → গেজের মান। maxmemory 0 = সীমাহীন → ratio নেই (null)। */
function redisSnapshot(info) {
  const used = Number(info.used_memory) || 0;
  const max = Number(info.maxmemory) || 0;
  return {
    usedBytes: used,
    maxBytes: max,
    ratio: max > 0 ? used / max : null,
    clients: Number(info.connected_clients) || 0,
    evictedKeys: Number(info.evicted_keys) || 0
  };
}

function breakerStateValue(state) {
  return Object.prototype.hasOwnProperty.call(BREAKER_STATE_VALUE, state) ? BREAKER_STATE_VALUE[state] : -1;
}

function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const infoCache = new Map(); // instance -> { at, snap }

async function readRedis(instance, getClient) {
  const hit = infoCache.get(instance);
  if (hit && Date.now() - hit.at < REDIS_INFO_CACHE_MS) return hit.snap;
  const client = getClient();
  if (!client) return null;
  // 'memory' ও 'clients' ও 'stats' আলাদা সেকশন — evicted_keys stats-এ থাকে
  const [mem, cli, st] = await Promise.all([
    withTimeout(client.info('memory'), REDIS_INFO_TIMEOUT_MS),
    withTimeout(client.info('clients'), REDIS_INFO_TIMEOUT_MS),
    withTimeout(client.info('stats'), REDIS_INFO_TIMEOUT_MS)
  ]);
  const snap = redisSnapshot({ ...parseRedisInfo(mem), ...parseRedisInfo(cli), ...parseRedisInfo(st) });
  infoCache.set(instance, { at: Date.now(), snap });
  return snap;
}

/** prom-client গেজ তৈরি (registers: [register])। client == null হলে null। */
function createOpsGauges(client, register) {
  if (!client) return null;
  const g = (name, help, labelNames = []) => new client.Gauge({ name: `bet420_${name}`, help, labelNames, registers: [register] });
  return {
    dbPoolInUse: g('db_pool_in_use', 'Postgres pool-এ ব্যবহৃত (checked-out) কানেকশন = total - idle'),
    redisMemUsed: g('redis_memory_used_bytes', 'Redis used_memory (বাইট)', ['instance']),
    redisMemMax: g('redis_memory_max_bytes', 'Redis maxmemory (বাইট; 0 = সীমাহীন)', ['instance']),
    redisMemRatio: g('redis_memory_ratio', 'used_memory / maxmemory (0..1); maxmemory 0 হলে সেট হয় না', ['instance']),
    redisClients: g('redis_connected_clients', 'Redis connected_clients', ['instance']),
    redisEvicted: g('redis_evicted_keys', 'Redis evicted_keys (মোট, মনোটোনিক) — noeviction ইনস্ট্যান্সে 0 থাকা উচিত', ['instance']),
    redisScrapeOk: g('redis_info_ok', 'Redis INFO সফল কিনা (1/0)', ['instance']),
    bullmqJobs: g('bullmq_jobs', 'BullMQ কিউ জব সংখ্যা', ['queue', 'state']),
    apiLogDropped: g('apilog_dropped', 'api-log ওভারলোডে ফেলে দেওয়া মোট এন্ট্রি (এই প্রসেসে, মনোটোনিক)'),
    apiLogFailed: g('apilog_failed', 'api-log এনকিউ ব্যর্থ মোট (এই প্রসেসে)'),
    apiLogPending: g('apilog_pending', 'api-log এনকিউ অপেক্ষমাণ (এই মুহূর্তে)'),
    breakerState: g('circuit_breaker_state', 'Circuit breaker অবস্থা: 0=closed, 1=half_open, 2=open', ['name']),
    casinoStuckRounds: g('casino_stuck_rounds', 'আটকে থাকা ক্যাসিনো রাউন্ড: bet ডেবিট হয়েছে, STUCK_ROUND_HOURS (ডিফল্ট ৬) ঘণ্টা পরেও win/rollback নেই; -1 = গণনা ব্যর্থ'),
    integrationSuspended: g('integration_suspended', 'অটো-সাসপেন্ড: 1 = সাসপেন্ড, 0 = চালু (sports:*/casino:*/sms/email)', ['name', 'source']),
    integrationSuspendedSeconds: g('integration_suspended_seconds', 'সাসপেন্ড কতক্ষণ ধরে (সেকেন্ড); চালু থাকলে 0', ['name']),
    integrationSuspendCount: g('integration_suspend_count', 'মোট কতবার সাসপেন্ড হয়েছে (মনোটোনিক; flapping অ্যালার্টে increase() ব্যবহার করুন)', ['name']),
    breakerWindowErrorRate: g('circuit_breaker_window_error_rate', 'Breaker-এর স্লাইডিং উইন্ডোতে ব্যর্থতার হার (0..1)', ['name'])
  };
}

/** প্রতিটা ধাপ আলাদা try/catch — একটা ব্যর্থ হলে বাকিগুলো চলে। */
async function refreshOpsMetrics(gauges, deps = {}) {
  if (!gauges) return;

  try {
    const { pool } = deps.db || require('../db');
    gauges.dbPoolInUse.set(Math.max(0, (pool.totalCount || 0) - (pool.idleCount || 0)));
  } catch (_) { /* non-fatal */ }

  const redisTargets = deps.redisTargets || [
    ['queue', () => { try { return require('../queues/connection').connection; } catch (_) { return null; } }],
    ['cache', () => { try { return require('./cache').getRawClient(); } catch (_) { return null; } }]
  ];
  for (const [instance, getClient] of redisTargets) {
    try {
      const s = await readRedis(instance, getClient);
      if (!s) { gauges.redisScrapeOk.set({ instance }, 0); continue; }
      gauges.redisMemUsed.set({ instance }, s.usedBytes);
      gauges.redisMemMax.set({ instance }, s.maxBytes);
      if (s.ratio !== null) gauges.redisMemRatio.set({ instance }, s.ratio);
      gauges.redisClients.set({ instance }, s.clients);
      gauges.redisEvicted.set({ instance }, s.evictedKeys);
      gauges.redisScrapeOk.set({ instance }, 1);
    } catch (err) {
      gauges.redisScrapeOk.set({ instance }, 0);
      console.error(`[metrics] Redis(${instance}) INFO error:`, err.message);
    }
  }

  try {
    const { getQueueHealthStats } = deps.queueHealth || require('../queues/health');
    const qh = await getQueueHealthStats();
    for (const q of qh.queues) {
      if (!q.enabled || q.error) continue;
      for (const [state, n] of Object.entries(q.counts || {})) gauges.bullmqJobs.set({ queue: q.name, state }, Number(n) || 0);
    }
  } catch (err) {
    console.error('[metrics] BullMQ depth error:', err.message);
  }

  try {
    const { getApiLogStats } = deps.apiLogger || require('../middleware/apiLogger');
    const s = getApiLogStats();
    gauges.apiLogDropped.set(s.dropped || 0);
    gauges.apiLogFailed.set(s.failed || 0);
    gauges.apiLogPending.set(s.pending || 0);
  } catch (_) { /* non-fatal */ }

  try {
    const { getAllBreakerSnapshots } = deps.breakers || require('./circuitBreaker');
    for (const b of getAllBreakerSnapshots()) {
      gauges.breakerState.set({ name: b.name }, breakerStateValue(b.state));
      gauges.breakerWindowErrorRate.set({ name: b.name }, b.windowErrorRate || 0);
    }
  } catch (_) { /* non-fatal */ }

  // আটকে থাকা ক্যাসিনো রাউন্ড (শুধু-পড়া কোয়েরি, services/stuckCasinoRounds.js)। ব্যর্থ হলে -1 (০ নয়)।
  try {
    const n = await (deps.stuckRounds || require('./stuckCasinoRounds')).countStuckRounds(deps.pool || require('../db').pool);
    gauges.casinoStuckRounds.set(n === null || n === undefined ? -1 : n);
  } catch (_) { try { gauges.casinoStuckRounds.set(-1); } catch (__) { /* non-fatal */ } }

  // K10: অটো-সাসপেন্ড অবস্থা (DB থেকে; web ও worker উভয়ের সিদ্ধান্ত একই দেখায়)
  try {
    const rows = await (deps.suspend || require('./autoSuspend')).listStates();
    for (const r of rows) {
      gauges.integrationSuspended.set({ name: r.name, source: r.source || 'none' }, r.suspended ? 1 : 0);
      gauges.integrationSuspendedSeconds.set({ name: r.name }, r.suspended && r.suspended_at ? Math.max(0, Math.round((Date.now() - new Date(r.suspended_at).getTime()) / 1000)) : 0);
      gauges.integrationSuspendCount.set({ name: r.name }, Number(r.suspend_count) || 0);
    }
  } catch (_) { /* non-fatal */ }
}

module.exports = { parseRedisInfo, redisSnapshot, breakerStateValue, createOpsGauges, refreshOpsMetrics, BREAKER_STATE_VALUE };
