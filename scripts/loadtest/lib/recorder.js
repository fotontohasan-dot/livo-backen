// scripts/loadtest/lib/recorder.js
// ---------------------------------------------------------------------------
// C4 — ফলাফল রেকর্ড: p50/p95/p99, error rate, 429 rate, WebSocket disconnect/reconnect, "Session ID unknown" গণনা।
// কোনো secret/cookie/টোকেন রেকর্ড হয় না — শুধু সংখ্যা, স্ট্যাটাস কোড ও সময়।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const MAX_SAMPLES = 2_000_000; // মেমরি সীমা; এর বেশি হলে reservoir-এর মতো এলোমেলো রিপ্লেস

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

class Recorder {
  constructor(name) {
    this.name = name;
    this.startedAt = Date.now();
    this.samples = [];          // ms
    this.seen = 0;
    this.byClass = {};          // '2xx' | '3xx' | '4xx' | '5xx' | 'net'
    this.byStatus = {};         // '200', '429' ...
    this.byRoute = {};          // route -> { n, errors, samples: [] }
    this.netErrors = {};        // error-code -> n
    this.ws = { attempted: 0, connected: 0, connectErrors: 0, disconnects: 0, reconnects: 0, sessionIdUnknown: 0, eventsReceived: 0, peakConnected: 0, currentConnected: 0, connectedAtEnd: null, neverGotEvent: null };
    this.timeline = [];         // { t, ...snapshot } — 1 নমুনা/সেকেন্ডের কাছাকাছি
    this.notes = [];
  }

  note(msg) { this.notes.push({ t: Date.now(), msg }); console.log(`[${this.name}] ${msg}`); }

  http(route, status, ms, errCode) {
    const cls = errCode ? 'net' : `${Math.floor(status / 100)}xx`;
    this.byClass[cls] = (this.byClass[cls] || 0) + 1;
    if (!errCode) this.byStatus[status] = (this.byStatus[status] || 0) + 1;
    else this.netErrors[errCode] = (this.netErrors[errCode] || 0) + 1;
    this.seen++;
    if (this.samples.length < MAX_SAMPLES) this.samples.push(ms);
    else this.samples[Math.floor(Math.random() * MAX_SAMPLES)] = ms;
    const r = (this.byRoute[route] = this.byRoute[route] || { n: 0, errors: 0, s429: 0, samples: [] });
    r.n++;
    if (errCode || status >= 500) r.errors++;
    if (status === 429) r.s429++;
    if (r.samples.length < 200_000) r.samples.push(ms);
  }

  summary() {
    const total = this.seen;
    const c = (k) => this.byClass[k] || 0;
    const s429 = this.byStatus[429] || 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const routes = {};
    for (const [k, r] of Object.entries(this.byRoute)) {
      const s = [...r.samples].sort((a, b) => a - b);
      routes[k] = { requests: r.n, errors5xxOrNet: r.errors, rate429: r.n ? r.s429 / r.n : 0, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) };
    }
    const w = this.ws;
    return {
      scenario: this.name,
      durationSec: Math.round((Date.now() - this.startedAt) / 1000),
      http: total ? {
        requests: total,
        latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] },
        // error rate = 5xx + নেটওয়ার্ক ব্যর্থতা (429 ইচ্ছাকৃত লিমিট — আলাদা রেট; 4xx ক্লায়েন্ট-এরর নয় ধরা হয় না)
        errorRate: (c('5xx') + c('net')) / total,
        rate429: s429 / total,
        byClass: this.byClass,
        byStatus: this.byStatus,
        netErrors: this.netErrors,
        routes
      } : null,
      websocket: w.attempted ? { ...w, disconnectRate: w.connected ? w.disconnects / w.connected : null } : null,
      notes: this.notes.map((n) => ({ at: new Date(n.t).toISOString(), msg: n.msg }))
    };
  }

  markdown() {
    const s = this.summary();
    const pct = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(2) + '%');
    const L = [`### ${s.scenario}`, '', `Duration: ${s.durationSec}s`, ''];
    if (s.http) {
      const h = s.http;
      L.push('| Metric | Value |', '|---|---|',
        `| Requests | ${h.requests} |`,
        `| p50 / p95 / p99 (ms) | ${h.latencyMs.p50} / ${h.latencyMs.p95} / ${h.latencyMs.p99} |`,
        `| Error rate (5xx + network) | ${pct(h.errorRate)} |`,
        `| 429 rate | ${pct(h.rate429)} |`, '');
      L.push('| Route | n | p50 | p95 | p99 | 5xx/net | 429 |', '|---|---|---|---|---|---|---|');
      for (const [k, r] of Object.entries(h.routes)) L.push(`| ${k} | ${r.requests} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.errors5xxOrNet} | ${pct(r.rate429)} |`);
      L.push('');
    }
    if (s.websocket) {
      const w = s.websocket;
      L.push('| WebSocket | Value |', '|---|---|',
        `| Attempted / connected | ${w.attempted} / ${w.connected} |`,
        `| Peak concurrent | ${w.peakConnected} |`,
        `| Connected at end | ${w.connectedAtEnd} |`,
        `| Disconnects (after connect) | ${w.disconnects} (${pct(w.disconnectRate)} of connected) |`,
        `| Reconnects | ${w.reconnects} |`,
        `| Connect errors | ${w.connectErrors} |`,
        `| "Session ID unknown" | ${w.sessionIdUnknown} |`,
        `| Events received | ${w.eventsReceived} |`,
        `| Connections that never received an event | ${w.neverGotEvent} |`, '');
    }
    if (s.notes.length) { L.push('Notes:', ...s.notes.map((n) => `- ${n.at} ${n.msg}`), ''); }
    return L.join('\n');
  }

  /** results/<name>-<ts>.json + .md. URL-এ query/secret থাকতে পারে না — শুধু সংখ্যা। */
  write(dir = path.join(__dirname, '..', 'results')) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${this.name}-${stamp}`);
    fs.writeFileSync(base + '.json', JSON.stringify({ ...this.summary(), timeline: this.timeline }, null, 2));
    fs.writeFileSync(base + '.md', this.markdown());
    return base;
  }
}

module.exports = { Recorder, percentile };
