// services/circuitBreaker.js
// ==================== ছোট in-house circuit breaker (বাইরের API কলের জন্য) ====================
// সমস্যা: sports/casino/SMS/email provider ধীর বা ডাউন হলে প্রতিটা রিকোয়েস্ট timeout পর্যন্ত (আগে ~১০ সেকেন্ড)
// ঝুলে থাকত, worker/web দুটোর কানেকশন ও থ্রেড জমে যেত।
//
// অবস্থা:  CLOSED  → স্বাভাবিক; ফলাফল গোনা হয়।
//          OPEN    → সঙ্গে সঙ্গে CircuitOpenError (কোনো নেটওয়ার্ক কল নয়); resetTimeoutMs পরে HALF_OPEN।
//          HALF_OPEN → সীমিত probe কল পাঠানো হয়; সফল হলে CLOSED, ব্যর্থ হলে আবার OPEN।
// OPEN হওয়ার শর্ত (যেকোনো একটা): পরপর N ব্যর্থতা, অথবা window-এ ন্যূনতম minRequests কলের মধ্যে error-rate ≥ threshold।
//
// ⚠️ এই মডিউল কখনো কোনো কল নিজে থেকে রিট্রাই করে না — রিট্রাই একটাও নেই। পেমেন্ট/ওয়ালেটের মতো non-idempotent
// কল আদৌ breaker-এ ঢোকানো হয় না (docs/INTEGRATIONS.md); ঢুকলেও এখানে কোনো auto-retry নেই।
//
// সব থ্রেশহোল্ড env দিয়ে বদলানো যায় — গ্লোবাল BREAKER_* বা নির্দিষ্ট breaker-এর BREAKER_<NAME>_*।

const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

class CircuitOpenError extends Error {
  constructor(name, retryInMs) {
    super(`${name}: circuit open — সার্ভিস সাময়িকভাবে বন্ধ, কিছুক্ষণ পরে আবার চেষ্টা করুন`);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.integration = name;
    this.retryInMs = retryInMs;
  }
}

class CircuitTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`${name}: ${timeoutMs}ms-এর মধ্যে সাড়া আসেনি (timeout)`);
    this.name = 'CircuitTimeoutError';
    this.code = 'CIRCUIT_TIMEOUT';
    this.integration = name;
  }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envKeyPart(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** গ্লোবাল BREAKER_X, তারপর নির্দিষ্ট BREAKER_<NAME>_X, তারপর কোড থেকে পাঠানো opts। */
function resolveConfig(name, opts = {}, env = process.env) {
  const k = envKeyPart(name);
  const pick = (suffix, def) => num(env[`BREAKER_${k}_${suffix}`], num(env[`BREAKER_${suffix}`], num(opts[suffix], def)));
  return {
    TIMEOUT_MS: pick('TIMEOUT_MS', 5000),
    FAILURE_THRESHOLD: pick('FAILURE_THRESHOLD', 5),       // পরপর ব্যর্থতা
    ERROR_RATE: Math.min(1, pick('ERROR_RATE', 0.5)),       // window-এ error অনুপাত
    WINDOW_MS: pick('WINDOW_MS', 30000),
    MIN_REQUESTS: pick('MIN_REQUESTS', 10),
    RESET_TIMEOUT_MS: pick('RESET_TIMEOUT_MS', 30000),      // OPEN থেকে HALF_OPEN-এর আগে অপেক্ষা
    HALF_OPEN_MAX: pick('HALF_OPEN_MAX', 1)                 // একসাথে কতগুলো probe
  };
}

const registry = new Map();
const listeners = new Set();

class CircuitBreaker {
  constructor(name, opts = {}, { now = Date.now, env = process.env } = {}) {
    this.name = name;
    this.now = now;
    this.cfg = resolveConfig(name, opts, env);
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.window = []; // { t, ok }
    this.openedAt = null;
    this.halfOpenInFlight = 0;
    this.lastStateChangeAt = null;
    this.lastFailureMessage = null;
    this.totals = { success: 0, failure: 0, rejected: 0, timeouts: 0 };
  }

  _transition(next, reason) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.lastStateChangeAt = this.now();
    if (next === STATE.OPEN) this.openedAt = this.now();
    if (next === STATE.CLOSED) { this.consecutiveFailures = 0; this.window = []; }
    if (next === STATE.HALF_OPEN) this.halfOpenInFlight = 0;
    // প্রতিটা অবস্থা-পরিবর্তন লগ হয় (acceptance: closed/open/half-open সবই)
    console.warn(`[circuit:${this.name}] ${prev} -> ${next}${reason ? ` (${reason})` : ''}`);
    for (const fn of listeners) {
      try { fn({ name: this.name, from: prev, to: next, reason, at: new Date(this.lastStateChangeAt) }); } catch (_) { /* শ্রোতার ভুল breaker ভাঙবে না */ }
    }
  }

  _prune() {
    const cutoff = this.now() - this.cfg.WINDOW_MS;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();
  }

  _record(ok, message) {
    this.window.push({ t: this.now(), ok });
    this._prune();
    if (ok) { this.totals.success++; this.consecutiveFailures = 0; return; }
    this.totals.failure++;
    this.consecutiveFailures++;
    this.lastFailureMessage = message ? String(message).slice(0, 200) : null;
  }

  _shouldOpen() {
    if (this.consecutiveFailures >= this.cfg.FAILURE_THRESHOLD) return `consecutive failures ${this.consecutiveFailures}`;
    if (this.window.length >= this.cfg.MIN_REQUESTS) {
      const failed = this.window.filter((r) => !r.ok).length;
      const rate = failed / this.window.length;
      if (rate >= this.cfg.ERROR_RATE) return `error rate ${Math.round(rate * 100)}% over ${this.window.length} calls`;
    }
    return null;
  }

  /** বর্তমান অবস্থা (OPEN-এ reset-timeout পেরোলে HALF_OPEN-এ নামে) — অ্যাডমিন পেজও এটা পড়ে। */
  getState() {
    if (this.state === STATE.OPEN && this.now() - this.openedAt >= this.cfg.RESET_TIMEOUT_MS) {
      this._transition(STATE.HALF_OPEN, 'reset timeout elapsed — probing');
    }
    return this.state;
  }

  snapshot() {
    this._prune();
    const failed = this.window.filter((r) => !r.ok).length;
    return {
      name: this.name,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      windowCalls: this.window.length,
      windowErrorRate: this.window.length ? Math.round((failed / this.window.length) * 100) / 100 : 0,
      lastStateChangeAt: this.lastStateChangeAt ? new Date(this.lastStateChangeAt).toISOString() : null,
      lastFailureMessage: this.lastFailureMessage, // এখানে raw; দেখানোর আগে integrationStatus.sanitizeError চলে
      totals: { ...this.totals },
      timeoutMs: this.cfg.TIMEOUT_MS
    };
  }

  /**
   * fn(signal) চালায়। টাইমআউটে signal abort হয় ও CircuitTimeoutError ছোঁড়ে।
   * opts.isFailure(result) → true হলে ফলাফল ফেরত যায় কিন্তু ব্যর্থতা হিসেবে গোনা হয় (যেমন HTTP 5xx)।
   */
  async fire(fn, opts = {}) {
    const st = this.getState();
    if (st === STATE.OPEN) {
      this.totals.rejected++;
      throw new CircuitOpenError(this.name, Math.max(0, this.cfg.RESET_TIMEOUT_MS - (this.now() - this.openedAt)));
    }
    let probing = false;
    if (st === STATE.HALF_OPEN) {
      if (this.halfOpenInFlight >= this.cfg.HALF_OPEN_MAX) {
        this.totals.rejected++;
        throw new CircuitOpenError(this.name, 0);
      }
      this.halfOpenInFlight++;
      probing = true;
    }

    const controller = new AbortController();
    const timeoutMs = num(opts.timeoutMs, this.cfg.TIMEOUT_MS);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.totals.timeouts++;
        controller.abort();
        reject(new CircuitTimeoutError(this.name, timeoutMs));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([Promise.resolve().then(() => fn(controller.signal)), timeout]);
      const failed = typeof opts.isFailure === 'function' && opts.isFailure(result);
      this._onResult(!failed, failed ? 'upstream returned failure status' : null, probing);
      return result;
    } catch (err) {
      this._onResult(false, err && err.message, probing);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _onResult(ok, message, probing) {
    if (probing) this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    this._record(ok, message);
    if (this.state === STATE.HALF_OPEN) {
      if (ok) this._transition(STATE.CLOSED, 'probe succeeded');
      else this._transition(STATE.OPEN, 'probe failed');
      return;
    }
    if (this.state === STATE.CLOSED && !ok) {
      const why = this._shouldOpen();
      if (why) this._transition(STATE.OPEN, why);
    }
  }
}

function getBreaker(name, opts) {
  let b = registry.get(name);
  if (!b) { b = new CircuitBreaker(name, opts); registry.set(name, b); }
  return b;
}

function getAllBreakerSnapshots() {
  return [...registry.values()].map((b) => b.snapshot());
}

/** অবস্থা-পরিবর্তনের শ্রোতা (লগ ছাড়া অতিরিক্ত হুক)। ফেরত ফাংশন কল করলে সরে যায়। */
function onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function _resetForTests() { registry.clear(); listeners.clear(); }

module.exports = {
  STATE, CircuitBreaker, CircuitOpenError, CircuitTimeoutError,
  getBreaker, getAllBreakerSnapshots, onStateChange, resolveConfig, _resetForTests
};
