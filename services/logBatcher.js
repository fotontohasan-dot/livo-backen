// services/logBatcher.js
// অনেকগুলো ছোট লগ-লেখাকে জমিয়ে একটা multi-row INSERT-এ পাঠায়।
// ব্যবহার: BULLMQ_ENABLED=false থাকলে api_usage_logs ও activity_logs এখান দিয়ে লেখা হয় —
// প্রতি রিকোয়েস্টে Redis/DB কোনোটাতেই আলাদা কমান্ড যায় না।
//   • flush: প্রতি FLUSH_MS (ডিফল্ট ১০s) অথবা MAX_BATCH (ডিফল্ট 200) জমলে
//   • সীমিত বাফার: MAX_BUFFER (ডিফল্ট 5000) ছাড়ালে নতুন লগ ফেলে দেওয়া হয় ও গোনা হয় (রিকোয়েস্ট কখনো আটকায় না)
//   • শাটডাউনে flushAll() ডাকলে বাকি লগ লেখা হয়
// লগ হারানো গ্রহণযোগ্য (আগের ডিজাইনেও overload-এ ফেলে দেওয়া হতো)।

const FLUSH_MS = parseInt(process.env.LOG_BATCH_FLUSH_MS || '10000', 10);
const MAX_BATCH = parseInt(process.env.LOG_BATCH_MAX || '200', 10);
const MAX_BUFFER = parseInt(process.env.LOG_BATCH_MAX_BUFFER || '5000', 10);

const batchers = new Set();

/**
 * @param {object} o
 * @param {string} o.name
 * @param {(rows:any[]) => Promise<void>} o.writeRows  একটা ব্যাচ DB-তে লেখে
 */
function createBatcher({ name, writeRows, flushMs = FLUSH_MS, maxBatch = MAX_BATCH, maxBuffer = MAX_BUFFER }) {
  let buffer = [];
  let timer = null;
  let flushing = null;
  const stats = { added: 0, written: 0, dropped: 0, failedBatches: 0 };

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs);
    if (timer.unref) timer.unref();
  }

  async function flush() {
    if (flushing) return flushing; // একসাথে একটাই flush
    if (!buffer.length) return;
    const rows = buffer;
    buffer = [];
    flushing = (async () => {
      try {
        for (let i = 0; i < rows.length; i += maxBatch) {
          const chunk = rows.slice(i, i + maxBatch);
          try {
            await writeRows(chunk);
            stats.written += chunk.length;
          } catch (err) {
            stats.failedBatches++;
            stats.dropped += chunk.length; // রিট্রাই নয় — লগ হারানো গ্রহণযোগ্য, বাফার ফুলে ওঠা নয়
            console.error(`[logBatcher:${name}] ব্যাচ লেখা ব্যর্থ (${chunk.length} লগ বাদ):`, err.message);
          }
        }
      } finally {
        flushing = null;
        if (buffer.length) schedule();
      }
    })();
    return flushing;
  }

  function add(row) {
    if (buffer.length >= maxBuffer) { stats.dropped++; return false; }
    buffer.push(row);
    stats.added++;
    if (buffer.length >= maxBatch) flush().catch(() => {});
    else schedule();
    return true;
  }

  async function flushNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (flushing) await flushing;
    await flush();
  }

  const api = { name, add, flush: flushNow, getStats: () => ({ ...stats, buffered: buffer.length }) };
  batchers.add(api);
  return api;
}

async function flushAllLogBatchers() {
  await Promise.allSettled([...batchers].map((b) => b.flush()));
}

// ---------- multi-row INSERT তৈরি ----------
function buildInsert(table, columns, rows, toValues) {
  const params = [];
  const tuples = rows.map((r) => {
    const vals = toValues(r);
    const ph = vals.map((v) => { params.push(v); return `$${params.length}`; });
    return `(${ph.join(',')})`;
  });
  return { text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(',')}`, params };
}

let apiBatcher = null;
let activityBatcher = null;

function getApiLogBatcher() {
  if (!apiBatcher) {
    apiBatcher = createBatcher({
      name: 'api-log',
      writeRows: async (rows) => {
        const { pool } = require('../db');
        const q = buildInsert('api_usage_logs',
          ['api_key_id', 'user_id', 'ip', 'endpoint', 'method', 'status_code', 'response_time_ms', 'user_agent'],
          rows,
          (d) => [d.apiKeyId || null, d.userId || null, d.ip || null, String(d.endpoint || '').slice(0, 500),
            d.method || 'GET', d.statusCode || 200, d.responseTimeMs || 0, d.userAgent || null]);
        await pool.query(q.text, q.params);
      }
    });
  }
  return apiBatcher;
}

function getActivityLogBatcher() {
  if (!activityBatcher) {
    activityBatcher = createBatcher({
      name: 'activity-log',
      writeRows: async (rows) => {
        const { pool } = require('../db');
        const q = buildInsert('activity_logs',
          ['user_id', 'username', 'action_type', 'details', 'ip_address', 'user_agent'],
          rows,
          (d) => [d.userId || null, d.username || null, d.actionType, d.details || null, d.ip || null, d.userAgent || null]);
        await pool.query(q.text, q.params);
      }
    });
  }
  return activityBatcher;
}

module.exports = { createBatcher, flushAllLogBatchers, getApiLogBatcher, getActivityLogBatcher, buildInsert };
