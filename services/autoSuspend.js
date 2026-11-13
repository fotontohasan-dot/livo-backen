// services/autoSuspend.js
// ==================== K10: অটো-সাসপেন্ড — বাইরের API ডাউন হলে নির্ভরশীল ফিচার নিজে বন্ধ, ঠিক হলে নিজে চালু ====================
// অবস্থা Postgres-এর `integration_suspend` টেবিলে (web ও worker একই দেখে); প্রতি প্রসেসে ছোট TTL-ক্যাশ (ডিফল্ট ৫s)।
//
// সংকেত (শুধু একটা ব্যর্থতায় নয় — সীমা পেরোলে):
//   ১. circuit breaker OPEN হলে (breaker নিজে ৫ পরপর ব্যর্থতা বা window-এ ≥৫০% ব্যর্থতায় খোলে — services/circuitBreaker.js)
//   ২. নিজস্ব স্লাইডিং-উইন্ডো: টানা N ব্যর্থতা (AUTO_SUSPEND_CONSECUTIVE_FAILURES=5; ১০ মিনিটের বেশি ফাঁকে নয়) অথবা
//      AUTO_SUSPEND_WINDOW_MS (৬০s)-এ ন্যূনতম AUTO_SUSPEND_MIN_REQUESTS (১০) কলের মধ্যে ≥ AUTO_SUSPEND_ERROR_RATE (০.৫)
//   ৩. রেট-লিমিট (HTTP 429) window-এ AUTO_SUSPEND_RATE_LIMIT_HITS (৩) বার
//      (K9-এর আলাদা রেট-লিমিট "থামার" মডিউল এই রিপোতে নেই; এখানে 429 সরাসরি গোনা হয়)
// চালু করা: auto-সাসপেন্ডের পর টানা AUTO_SUSPEND_RESUME_SUCCESSES (৩) সফল কল + ন্যূনতম AUTO_SUSPEND_MIN_SUSPEND_MS (২ মিনিট)
//           পেরোনো (flapping ঠেকাতে) + এই প্রসেসের breaker closed। হাতে (manual) সাসপেন্ড কখনো নিজে খোলে না।
//
// ⛔ কখনো সাসপেন্ডযোগ্য নয়: payment:* (SSLCommerz), wallet:* (callback) — এই মডিউল এগুলো ট্র্যাকই করে না, হাতেও বন্ধ করা যায় না।
//    সেটেলমেন্ট/পেআউট/ডিপোজিট/উইথড্র/ওয়ালেট কোড এই মডিউল কখনো ডাকে না।
// ⚠️ ফেইল-ওপেন: DB/টেবিল না থাকলে "সাসপেন্ড নেই" ধরা হয় (আগের আচরণ) — এই ফিচার নিজে সাইট বন্ধ করে না।
// কোনো সিক্রেট এখানে সংরক্ষিত হয় না; detail integrationStatus.sanitizeError দিয়ে পরিষ্কার ও ২০০ অক্ষরে ছাঁটা।

const MATCH_PROVIDER_INTEGRATION = {
  'cricket-cricapi': 'sports:cricapi',
  'football-rapidapi': 'sports:rapidapi'
};

const NEVER_SUSPEND = [/^payment:/, /^wallet:/];
const SUSPENDABLE = [/^sports:/, /^casino:/, /^sms$/, /^email$/];

function isSuspendable(name) {
  const n = String(name || '');
  if (NEVER_SUSPEND.some((re) => re.test(n))) return false;
  return SUSPENDABLE.some((re) => re.test(n));
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig(env = process.env) {
  return {
    enabled: String(env.AUTO_SUSPEND_ENABLED === undefined ? 'true' : env.AUTO_SUSPEND_ENABLED).toLowerCase() !== 'false',
    consecutiveFailures: num(env.AUTO_SUSPEND_CONSECUTIVE_FAILURES, 5),
    consecutiveMaxAgeMs: num(env.AUTO_SUSPEND_CONSECUTIVE_MAX_AGE_MS, 600000), // এর চেয়ে পুরনো ব্যর্থতা "টানা"-তে গোনা হয় না
    windowMs: num(env.AUTO_SUSPEND_WINDOW_MS, 60000),
    errorRate: Math.min(1, num(env.AUTO_SUSPEND_ERROR_RATE, 0.5)),
    minRequests: num(env.AUTO_SUSPEND_MIN_REQUESTS, 10),
    rateLimitHits: num(env.AUTO_SUSPEND_RATE_LIMIT_HITS, 3),
    onBreakerOpen: String(env.AUTO_SUSPEND_ON_BREAKER_OPEN === undefined ? 'true' : env.AUTO_SUSPEND_ON_BREAKER_OPEN).toLowerCase() !== 'false',
    resumeSuccesses: num(env.AUTO_SUSPEND_RESUME_SUCCESSES, 3),
    minSuspendMs: num(env.AUTO_SUSPEND_MIN_SUSPEND_MS, 120000),
    cacheTtlMs: num(env.AUTO_SUSPEND_CACHE_TTL_MS, 5000),
    probeIntervalMs: num(env.AUTO_SUSPEND_PROBE_INTERVAL_MS, 60000)
  };
}

/** বিশুদ্ধ ফাংশন: ট্র্যাকার দেখে সাসপেন্ড করা উচিত কিনা। ফেরত: { reason, detail } অথবা null। */
function evaluateTrip(tracker, cfg, now) {
  if (tracker.consecutive >= cfg.consecutiveFailures) {
    return { reason: 'consecutive_failures', detail: `টানা ${tracker.consecutive}টি ব্যর্থ কল` };
  }
  const cutoff = now - cfg.windowMs;
  const win = tracker.window.filter((r) => r.t >= cutoff);
  if (win.length >= cfg.minRequests) {
    const failed = win.filter((r) => !r.ok).length;
    const rate = failed / win.length;
    if (rate >= cfg.errorRate) {
      return { reason: 'error_rate', detail: `${win.length}টি কলের ${Math.round(rate * 100)}% ব্যর্থ` };
    }
  }
  const rl = tracker.rateLimited.filter((t) => t >= cutoff).length;
  if (rl >= cfg.rateLimitHits) {
    return { reason: 'rate_limited', detail: `${rl}বার রেট-লিমিট (429)` };
  }
  return null;
}

// ---------- স্টোর (Postgres; টেস্টে মেমরি-স্টোর ইনজেক্ট করা যায়) ----------
function pgStore(pool) {
  return {
    async get(name) {
      const r = await pool.query('SELECT * FROM integration_suspend WHERE name = $1', [name]);
      return r.rows[0] || null;
    },
    async list() {
      const r = await pool.query('SELECT * FROM integration_suspend ORDER BY name');
      return r.rows;
    },
    // ফেরত: { transitioned: bool, state } অথবা null (হাতের সাসপেন্ড auto দিয়ে বদলানো হয় না)
    async suspend(name, { source, reason, detail, by }) {
      const r = await pool.query(
        `WITH prev AS (SELECT suspended FROM integration_suspend WHERE name = $1)
         INSERT INTO integration_suspend AS s (name, suspended, source, reason, detail, suspended_at, success_streak, suspend_count, updated_by, updated_at)
         VALUES ($1, true, $2, $3, $4, NOW(), 0, 1, $5, NOW())
         ON CONFLICT (name) DO UPDATE SET
           suspended = true, source = EXCLUDED.source, reason = EXCLUDED.reason, detail = EXCLUDED.detail,
           suspended_at = CASE WHEN s.suspended THEN s.suspended_at ELSE NOW() END,
           success_streak = 0,
           suspend_count = s.suspend_count + CASE WHEN s.suspended THEN 0 ELSE 1 END,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()
         WHERE NOT (s.suspended AND s.source = 'manual' AND EXCLUDED.source = 'auto')
         RETURNING s.*, COALESCE((SELECT suspended FROM prev), false) AS was_suspended`,
        [name, source, reason, detail, by || null]
      );
      const row = r.rows[0];
      if (!row) return null;
      const { was_suspended: was, ...state } = row;
      return { transitioned: !was, state };
    },
    async bumpSuccess(name) {
      const r = await pool.query(
        `UPDATE integration_suspend SET success_streak = success_streak + 1, updated_at = NOW()
         WHERE name = $1 AND suspended AND source = 'auto' RETURNING *`, [name]);
      return r.rows[0] || null;
    },
    async resetStreak(name) {
      await pool.query(
        `UPDATE integration_suspend SET success_streak = 0, updated_at = NOW()
         WHERE name = $1 AND suspended AND source = 'auto' AND success_streak <> 0`, [name]);
    },
    async resume(name, { onlyAuto, by }) {
      const r = await pool.query(
        `UPDATE integration_suspend SET suspended = false, resumed_at = NOW(), success_streak = 0, updated_by = $2, updated_at = NOW()
         WHERE name = $1 AND suspended ${onlyAuto ? "AND source = 'auto'" : ''} RETURNING *`, [name, by || null]);
      return r.rows[0] || null;
    }
  };
}

function createAutoSuspend({ store, now = Date.now, env = process.env, logger = console, breakers = null, audit = null } = {}) {
  const trackers = new Map(); // name -> { consecutive, window, rateLimited }
  const cache = new Map();    // name -> { at, state|null }
  const probes = new Map();   // name -> async fn
  const lastProbeAt = new Map();
  let listCache = { at: 0, rows: [] };
  let lastErrLog = 0;

  const cfg = () => resolveConfig(env);

  function logStoreError(err) {
    const t = now();
    if (t - lastErrLog > 30000) {
      lastErrLog = t;
      logger.warn('[auto-suspend] স্টোর ত্রুটি (ফেইল-ওপেন, ফিচার বন্ধ হচ্ছে না):', String(err && (err.code || err.message)).slice(0, 80));
    }
  }

  function sanitize(text) {
    try { return require('./integrationStatus').sanitizeError(text); } catch (_) { return String(text || '').slice(0, 200); }
  }

  async function readState(name) {
    const c = cache.get(name);
    if (c && now() - c.at < cfg().cacheTtlMs) return c.state;
    try {
      const row = await store.get(name);
      const state = row && row.suspended ? row : null;
      cache.set(name, { at: now(), state });
      return state;
    } catch (err) {
      logStoreError(err);
      return null; // ফেইল-ওপেন
    }
  }

  function invalidate(name) { cache.delete(name); listCache = { at: 0, rows: [] }; }

  function tracker(name) {
    let t = trackers.get(name);
    if (!t) { t = { consecutive: 0, window: [], rateLimited: [] }; trackers.set(name, t); }
    return t;
  }

  async function emitTransition(name, kind, state, actor) {
    logger.warn(`[auto-suspend] ${name} ${kind === 'suspended' ? 'সাসপেন্ড' : 'চালু'} (${state.source}/${state.reason || '-'})`);
    try {
      if (audit) {
        await audit((actor && actor.id) || null, (actor && actor.label) || 'SYSTEM',
          kind === 'suspended' ? 'INTEGRATION_SUSPENDED' : 'INTEGRATION_RESUMED',
          `${name} — ${state.source}${state.reason ? `/${state.reason}` : ''}${state.detail ? `: ${state.detail}` : ''}`);
      }
    } catch (_) { /* লগ ব্যর্থ হলে মূল কাজ থামে না */ }
  }

  async function doSuspend(name, { source, reason, detail, by, byId }) {
    if (!isSuspendable(name)) { const e = new Error('NOT_SUSPENDABLE'); e.code = 'NOT_SUSPENDABLE'; throw e; }
    const res = await store.suspend(name, { source, reason, detail: sanitize(detail || ''), by });
    invalidate(name);
    if (res && res.transitioned) await emitTransition(name, 'suspended', res.state, source === 'manual' ? { id: byId, label: by } : null);
    return res;
  }

  async function doResume(name, { onlyAuto, by, byId }) {
    const row = await store.resume(name, { onlyAuto, by });
    invalidate(name);
    if (row) await emitTransition(name, 'resumed', { ...row, source: onlyAuto ? 'auto' : 'manual' }, onlyAuto ? null : { id: byId, label: by });
    return row;
  }

  function breakerClosed(name) {
    try {
      const snaps = (breakers || require('./circuitBreaker')).getAllBreakerSnapshots();
      const b = snaps.find((x) => x.name === name);
      return !b || b.state === 'closed';
    } catch (_) { return true; }
  }

  async function handleOutcome(name, ok, { rateLimited } = {}) {
    const c = cfg();
    const tr = tracker(name);
    const t = now();
    tr.window.push({ t, ok });
    const cutoff = t - c.windowMs;
    while (tr.window.length && tr.window[0].t < cutoff) tr.window.shift();
    if (rateLimited) { tr.rateLimited.push(t); }
    tr.rateLimited = tr.rateLimited.filter((x) => x >= cutoff);
    if (ok) {
      tr.consecutive = 0;
    } else {
      // অনেক আগের একটা ব্যর্থতার সাথে নতুন একটা জুড়ে "টানা N" বানানো হয় না
      if (tr.lastFailAt && t - tr.lastFailAt > c.consecutiveMaxAgeMs) tr.consecutive = 0;
      tr.consecutive += 1;
      tr.lastFailAt = t;
    }

    const state = await readState(name);
    if (state) {
      if (state.source !== 'auto') return;
      if (!ok) {
        await store.resetStreak(name);
        invalidate(name);
        return;
      }
      const row = await store.bumpSuccess(name);
      if (!row) return;
      invalidate(name);
      const elapsed = t - new Date(row.suspended_at).getTime();
      if (row.success_streak >= c.resumeSuccesses && elapsed >= c.minSuspendMs && breakerClosed(name) && c.enabled) {
        tr.consecutive = 0; tr.window = []; tr.rateLimited = []; // পুরনো ব্যর্থতা নিয়ে সঙ্গে সঙ্গে আবার বন্ধ নয়
        await doResume(name, { onlyAuto: true });
      }
      return;
    }
    if (ok || !c.enabled) return;
    const trip = evaluateTrip(tr, c, t);
    if (trip) await doSuspend(name, { source: 'auto', ...trip });
  }

  /** ফায়ার-অ্যান্ড-ফরগেট: কখনো throw করে না, কলারকে আটকায় না। */
  function recordOutcome(name, ok, opts) {
    if (!isSuspendable(name)) return Promise.resolve();
    return handleOutcome(name, !!ok, opts || {}).catch(logStoreError);
  }

  /** circuit breaker OPEN হলে (breaker-এর নিজস্ব সীমা পেরিয়েছে) */
  function onBreakerChange(ev) {
    if (!ev || !isSuspendable(ev.name) || ev.to !== 'open') return Promise.resolve();
    const c = cfg();
    if (!c.enabled || !c.onBreakerOpen) return Promise.resolve();
    return doSuspend(ev.name, { source: 'auto', reason: 'breaker_open', detail: `circuit breaker open${ev.reason ? ` (${ev.reason})` : ''}` }).catch(logStoreError);
  }

  async function isSuspended(name) { return !!(await readState(name)); }
  async function getSuspension(name) { return readState(name); }

  async function getMatchProviderSuspension(provider) {
    const integ = MATCH_PROVIDER_INTEGRATION[String(provider || '')];
    return integ ? readState(integ) : null;
  }

  async function listStates() {
    if (now() - listCache.at < cfg().cacheTtlMs) return listCache.rows;
    try {
      const rows = await store.list();
      listCache = { at: now(), rows };
      return rows;
    } catch (err) { logStoreError(err); return []; }
  }

  /** সাসপেন্ড থাকা casino প্রোভাইডারের নামের Set (লবির জন্য, এক কোয়েরিতে) */
  async function suspendedCasinoProviders() {
    const rows = await listStates();
    return new Set(rows.filter((r) => r.suspended && /^casino:/.test(r.name)).map((r) => r.name.slice('casino:'.length)));
  }

  async function manualSuspend(name, { by, byId, reason } = {}) {
    return doSuspend(name, { source: 'manual', reason: 'manual', detail: reason || 'অ্যাডমিন হাতে বন্ধ করেছেন', by: by || null, byId });
  }
  async function manualResume(name, { by, byId } = {}) {
    if (!isSuspendable(name)) { const e = new Error('NOT_SUSPENDABLE'); e.code = 'NOT_SUSPENDABLE'; throw e; }
    return doResume(name, { onlyAuto: false, by: by || null, byId });
  }

  function registerProbe(name, fn) { probes.set(name, fn); }

  /** worker-এর ছোট টিক: auto-সাসপেন্ড থাকা API-তে একটা probe কল (ফলাফল recordOutcome-এ breaker/integrationFetch দিয়েই যায়)। */
  async function runProbes() {
    const c = cfg();
    let ran = 0;
    for (const row of await listStates()) {
      if (!row.suspended || row.source !== 'auto') continue;
      const fn = probes.get(row.name);
      if (!fn) continue;
      if (now() - (lastProbeAt.get(row.name) || 0) < c.probeIntervalMs) continue; // রেট-লিমিটেড API-তে ঘন ঘন নয়
      lastProbeAt.set(row.name, now());
      try { await fn(); ran++; } catch (_) { /* ব্যর্থ probe = breaker/outcome নিজেই ধরেছে */ }
    }
    return ran;
  }

  return {
    recordOutcome, onBreakerChange, isSuspended, getSuspension, getMatchProviderSuspension,
    listStates, suspendedCasinoProviders, manualSuspend, manualResume,
    registerProbe, runProbes, resolveConfig: cfg, _invalidate: invalidate, _trackers: trackers
  };
}

// ---------- ডিফল্ট সিঙ্গেলটন (Postgres + বিদ্যমান breaker শ্রোতা) ----------
let singleton = null;
function instance() {
  if (singleton) return singleton;
  const store = pgStore({ query: (...a) => require('../db').pool.query(...a) });
  singleton = createAutoSuspend({
    store,
    audit: (id, label, action, details) => require('./auditLog').logAdminAction(id, label, action, details, null)
  });
  try { require('./circuitBreaker').onStateChange((ev) => singleton.onBreakerChange(ev)); } catch (_) { /* breaker না থাকলে শুধু নিজস্ব সংকেত */ }
  return singleton;
}

const lazy = (fn) => (...args) => instance()[fn](...args);

module.exports = {
  MATCH_PROVIDER_INTEGRATION, isSuspendable, resolveConfig, evaluateTrip, pgStore, createAutoSuspend,
  recordOutcome: lazy('recordOutcome'),
  isSuspended: lazy('isSuspended'),
  getSuspension: lazy('getSuspension'),
  getMatchProviderSuspension: lazy('getMatchProviderSuspension'),
  listStates: lazy('listStates'),
  suspendedCasinoProviders: lazy('suspendedCasinoProviders'),
  manualSuspend: lazy('manualSuspend'),
  manualResume: lazy('manualResume'),
  registerProbe: lazy('registerProbe'),
  runProbes: lazy('runProbes')
};
