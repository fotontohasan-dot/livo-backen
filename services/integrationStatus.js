// services/integrationStatus.js
// ==================== ইন্টিগ্রেশন স্ট্যাটাস: ফলাফল রেকর্ড + web/worker heartbeat ====================
// web ও worker আলাদা প্রসেস, তাই স্টেট in-process মেমরিতে রাখা যায় না — Postgres-এ রাখা হয়
// (integration_status, process_heartbeat; migrations.js)। রেকর্ডিং কখনো throw করে না ও কলারকে আটকায় না।
//
// ⚠️ কোনো গোপন মান (কী/টোকেন/পাসওয়ার্ড/গোপন-সহ URL) এখানে সংরক্ষণ বা প্রদর্শন করা হয় না:
//   • কনফিগার্ড = শুধু boolean   • error message sanitizeError() দিয়ে পরিষ্কার + ২০০ অক্ষরে ছাঁটা

const os = require('os');
const { computeEnvFlags, secretEnvNames, listIntegrations } = require('./integrationRegistry');

const MAX_ERR_LEN = 200;
const SUCCESS_WRITE_EVERY_MS = parseInt(process.env.INTEGRATION_STATUS_SUCCESS_THROTTLE_MS || '30000', 10);
const ERROR_WRITE_EVERY_MS = parseInt(process.env.INTEGRATION_STATUS_ERROR_THROTTLE_MS || '5000', 10);
const HEARTBEAT_EVERY_MS = parseInt(process.env.INTEGRATION_HEARTBEAT_MS || '30000', 10);
const HEARTBEAT_STALE_MS = HEARTBEAT_EVERY_MS * 3;

// ---------- sanitize ----------
function sanitizeError(message, env = process.env) {
  let s = String(message === undefined || message === null ? '' : message);
  // ১) এই প্রসেসের আসল গোপন মান (≥৬ অক্ষর) যেখানেই থাকুক মুছে ফেলা
  for (const name of secretEnvNames(env)) {
    const v = env[name];
    if (typeof v === 'string' && v.length >= 6) s = s.split(v).join('[redacted]');
  }
  // ২) যেকোনো URL → [url] (কোয়েরি-স্ট্রিং/ক্রেডেনশিয়াল/টোকেন-পাথ সহ)
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, '[url]');
  // ৩) Telegram bot token, Bearer/Basic, key=value জাতীয়, দীর্ঘ টোকেন-সদৃশ স্ট্রিং
  s = s.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [redacted]');
  s = s.replace(/\b(api[_-]?key|apikey|key|token|secret|password|passwd|pass|sign|signature|authorization|store_passwd)\b\s*[=:]\s*["']?[^\s&"',;]+/gi, '$1=[redacted]');
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_ERR_LEN ? s.slice(0, MAX_ERR_LEN - 1) + '…' : s;
}

// ---------- ফলাফল রেকর্ড ----------
const lastWrite = new Map(); // name -> { ok, at }

function dbPool() { return require('../db').pool; }

/**
 * recordIntegrationResult('sms', true) / recordIntegrationResult('sms', false, err.message)
 * Fire-and-forget; throttle: অবস্থা বদলালে সঙ্গে সঙ্গে, নইলে সফল ৩০ সেকেন্ডে একবার, ব্যর্থ ৫ সেকেন্ডে একবার।
 */
function recordIntegrationResult(name, ok, errorMessage) {
  try {
    if (!name) return;
    const now = Date.now();
    const prev = lastWrite.get(name);
    const changed = !prev || prev.ok !== !!ok;
    const every = ok ? SUCCESS_WRITE_EVERY_MS : ERROR_WRITE_EVERY_MS;
    if (!changed && now - prev.at < every) return;
    lastWrite.set(name, { ok: !!ok, at: now });

    const msg = ok ? null : sanitizeError(errorMessage || 'unknown error');
    const sql = ok
      ? `INSERT INTO integration_status (name, last_success_at, success_count, updated_at)
         VALUES ($1, NOW(), 1, NOW())
         ON CONFLICT (name) DO UPDATE SET last_success_at = NOW(), success_count = integration_status.success_count + 1, updated_at = NOW()`
      : `INSERT INTO integration_status (name, last_error_at, last_error_message, error_count, updated_at)
         VALUES ($1, NOW(), $2, 1, NOW())
         ON CONFLICT (name) DO UPDATE SET last_error_at = NOW(), last_error_message = $2, error_count = integration_status.error_count + 1, updated_at = NOW()`;
    dbPool().query(sql, ok ? [String(name)] : [String(name), msg]).catch((e) => {
      console.warn('[integrationStatus] record failed:', String(e && e.message).slice(0, 120));
    });
  } catch (_) { /* রেকর্ডিং কখনো মূল কাজ ভাঙবে না */ }
}

// ---------- heartbeat (web ও worker উভয়ই লেখে) ----------
const bootedAt = new Date();
let timer = null;

function instanceId(role) {
  return `${role}:${process.env.RENDER_INSTANCE_ID || os.hostname() || 'local'}:${process.pid}`;
}

async function writeHeartbeat(role) {
  const breakers = (() => { try { return require('./circuitBreaker').getAllBreakerSnapshots(); } catch (_) { return []; } })()
    .map((b) => ({ ...b, lastFailureMessage: b.lastFailureMessage ? sanitizeError(b.lastFailureMessage) : null }));
  await dbPool().query(
    `INSERT INTO process_heartbeat (instance_id, role, booted_at, last_seen, env_flags, breakers)
     VALUES ($1, $2, $3, NOW(), $4::jsonb, $5::jsonb)
     ON CONFLICT (instance_id) DO UPDATE SET last_seen = NOW(), env_flags = $4::jsonb, breakers = $5::jsonb`,
    [instanceId(role), role, bootedAt, JSON.stringify(computeEnvFlags()), JSON.stringify(breakers)]
  );
}

/** role: 'web' | 'worker' | 'all'। বুটে একবার ডাকুন; টাইমার unref — প্রসেস বন্ধ আটকায় না। */
function startHeartbeat(role) {
  if (timer) return;
  const beat = () => writeHeartbeat(role).catch((e) => console.warn('[integrationStatus] heartbeat failed:', String(e && e.message).slice(0, 120)));
  beat();
  timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  if (timer.unref) timer.unref();
  // পুরনো heartbeat সারি (মৃত ইনস্ট্যান্স) ২৪ ঘণ্টা পর মুছে ফেলা
  dbPool().query(`DELETE FROM process_heartbeat WHERE last_seen < NOW() - INTERVAL '24 hours'`).catch(() => {});
}

function stopHeartbeat() { if (timer) { clearInterval(timer); timer = null; } }

// ---------- রিপোর্ট (অ্যাডমিন পেজ/JSON) ----------
/**
 * প্রতিটা ইন্টিগ্রেশনের জন্য: web/worker আলাদা configured (true/false/null=heartbeat নেই), শেষ সফল/ব্যর্থ সময়,
 * sanitize করা শেষ error, ও প্রতিটা প্রসেসের breaker অবস্থা। মান কখনো নয়।
 */
async function buildStatusReport() {
  const pool = dbPool();
  const [statusRes, hbRes] = await Promise.all([
    pool.query('SELECT name, last_success_at, last_error_at, last_error_message, success_count, error_count FROM integration_status'),
    pool.query('SELECT instance_id, role, booted_at, last_seen, env_flags, breakers FROM process_heartbeat WHERE last_seen > NOW() - INTERVAL \'24 hours\' ORDER BY last_seen DESC')
  ]);
  const byName = new Map(statusRes.rows.map((r) => [r.name, r]));
  const now = Date.now();
  const processes = hbRes.rows.map((r) => ({
    instanceId: r.instance_id, role: r.role, bootedAt: r.booted_at, lastSeen: r.last_seen,
    online: now - new Date(r.last_seen).getTime() <= HEARTBEAT_STALE_MS,
    envFlags: r.env_flags || {}, breakers: Array.isArray(r.breakers) ? r.breakers : []
  }));

  // একই role-এর সবচেয়ে নতুন online (না থাকলে সবচেয়ে নতুন) heartbeat — 'all' দুটো role-ই ঢাকে
  const pickRole = (role) => {
    const cands = processes.filter((p) => p.role === role || p.role === 'all');
    return cands.find((p) => p.online) || cands[0] || null;
  };
  const web = pickRole('web');
  const worker = pickRole('worker');

  const integrations = listIntegrations().map((def) => {
    const s = byName.get(def.id) || {};
    const breakerFor = (proc) => {
      if (!proc) return null;
      const b = proc.breakers.find((x) => x.name === def.id);
      return b ? { state: b.state, consecutiveFailures: b.consecutiveFailures, lastStateChangeAt: b.lastStateChangeAt } : null;
    };
    return {
      id: def.id, label: def.label, group: def.group,
      configured: {
        web: web ? !!web.envFlags[def.id] : null,
        worker: worker ? !!worker.envFlags[def.id] : null
      },
      lastSuccessAt: s.last_success_at || null,
      lastErrorAt: s.last_error_at || null,
      lastError: s.last_error_message ? sanitizeError(s.last_error_message) : null, // সংরক্ষিত মানও আবার পরিষ্কার
      breaker: { web: breakerFor(web), worker: breakerFor(worker) }
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    web: web && { instanceId: web.instanceId, bootedAt: web.bootedAt, lastSeen: web.lastSeen, online: web.online },
    worker: worker && { instanceId: worker.instanceId, bootedAt: worker.bootedAt, lastSeen: worker.lastSeen, online: worker.online },
    processes: processes.map(({ envFlags, breakers, ...rest }) => rest),
    integrations
  };
}

module.exports = {
  sanitizeError, recordIntegrationResult, startHeartbeat, stopHeartbeat, writeHeartbeat,
  buildStatusReport, MAX_ERR_LEN, _lastWrite: lastWrite
};
