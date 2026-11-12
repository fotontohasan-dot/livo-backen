#!/usr/bin/env node
// scripts/loadtest/mockProvider.js
// ---------------------------------------------------------------------------
// C2 — স্পোর্টস / ক্যাসিনো / SMS মক সার্ভার। লোড টেস্টে আসল (পেইড) API কখনো ডাকা হয় না।
// কোনো বাইরের নেটওয়ার্ক কল নেই, কোনো আসল key লাগে না; শুধু নিজের পোর্টে শোনে।
//
// অ্যাপকে এখানে ঘোরানো (staging env, শুধু staging-এ — production-এ কখনো নয়):
//   ALLOW_PROVIDER_BASE_URL_OVERRIDE=true
//   CRICKET_API_BASE_URL=https://<mock-host>/cricket      (→ /cricket/v1/currentMatches ...)
//   FOOTBALL_API_BASE_URL=https://<mock-host>/football    (→ /football/predictions/list)
//   CRICKET_API_KEY=mock  RAPIDAPI_KEY=mock               (নকল মান)
//   SMS_API_URL=https://<mock-host>/sms/send  SMS_API_KEY=mock
//   PROVIDER_<NAME>_API_URL=https://<mock-host>/casino     (ক্যাসিনো অ্যাডাপ্টারের জন্য)
// মক হোস্টটা staging-এর নিজের একটা ছোট Render Web Service হিসেবে চালানো যায় (docs/STAGING_SETUP.md), অথবা
// লোড-জেনারেটর মেশিনে — যেখানে staging থেকে পৌঁছানো যায়।
//
// নিয়ন্ত্রণ (ব্যর্থতা-ড্রিল, Scenario 3):
//   POST /__control  {"mode":"ok"|"slow"|"fail"|"flaky", "delayMs":8000, "failRate":0.5, "status":503}
//   GET  /__stats    কল সংখ্যা (route অনুযায়ী), বর্তমান মোড
//   নিয়ন্ত্রণ endpoint-এ header `x-mock-control-key` লাগে (MOCK_CONTROL_KEY env; না থাকলে নিয়ন্ত্রণ বন্ধ)।
// ---------------------------------------------------------------------------
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.MOCK_PORT || process.env.PORT || 4900);
const CONTROL_KEY = process.env.MOCK_CONTROL_KEY || '';
const MATCH_COUNT = Number(process.env.MOCK_MATCHES || 20);

const state = { mode: 'ok', delayMs: 8000, failRate: 0.5, status: 503, calls: {}, startedAt: Date.now() };
let tick = 0;
setInterval(() => { tick++; }, 2000).unref(); // স্কোর ধীরে ধীরে বাড়ে — ডেটা "জীবন্ত" দেখায়

const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cricketMatches() {
  return Array.from({ length: MATCH_COUNT }, (_, i) => ({
    id: `mock-cric-${i + 1}`, name: `Mock Team A${i + 1} vs Mock Team B${i + 1}`,
    status: i % 3 === 0 ? 'Match not started' : 'Live',
    venue: 'Mock Ground', date: new Date().toISOString().slice(0, 10), dateTimeGMT: new Date().toISOString(),
    teams: [`Mock Team A${i + 1}`, `Mock Team B${i + 1}`], teamInfo: [], matchType: 't20',
    score: [{ r: (tick * 3 + i) % 200, w: (tick + i) % 10, o: ((tick + i) % 20) + 0.1, inning: 'Mock Team A Inning 1' }]
  }));
}
function footballList() {
  return Array.from({ length: MATCH_COUNT }, (_, i) => ({
    id: `mock-fb-${i + 1}`, home_team: `Mock FC H${i + 1}`, away_team: `Mock FC A${i + 1}`,
    competition_name: 'Mock League', date: new Date().toISOString().slice(0, 10)
  }));
}

/** মোড অনুযায়ী বিলম্ব/ব্যর্থতা। true = ইতিমধ্যে সাড়া দেওয়া হয়েছে (ব্যর্থতা)। */
async function applyMode(res) {
  if (state.mode === 'slow') await sleep(state.delayMs);
  if (state.mode === 'fail') { json(res, state.status, { error: 'mock failure' }); return true; }
  if (state.mode === 'flaky' && Math.random() < state.failRate) { json(res, state.status, { error: 'mock flaky failure' }); return true; }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const key = `${req.method} ${p.replace(/\/[^/]*\d[^/]*$/, '/:id')}`;
  state.calls[key] = (state.calls[key] || 0) + 1;

  if (p === '/__control' || p === '/__stats') {
    const given = String(req.headers['x-mock-control-key'] || '');
    const ok = CONTROL_KEY && given.length === CONTROL_KEY.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(CONTROL_KEY));
    if (!ok) return json(res, 403, { error: 'control disabled or bad key' });
    if (p === '/__stats') return json(res, 200, { mode: state.mode, delayMs: state.delayMs, failRate: state.failRate, status: state.status, uptimeSec: Math.round((Date.now() - state.startedAt) / 1000), calls: state.calls });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    let body = '';
    for await (const c of req) { body += c; if (body.length > 4096) break; }
    let d; try { d = JSON.parse(body || '{}'); } catch (_) { return json(res, 400, { error: 'bad json' }); }
    if (['ok', 'slow', 'fail', 'flaky'].includes(d.mode)) state.mode = d.mode;
    if (Number.isFinite(d.delayMs) && d.delayMs >= 0 && d.delayMs <= 120000) state.delayMs = d.delayMs;
    if (Number.isFinite(d.failRate) && d.failRate >= 0 && d.failRate <= 1) state.failRate = d.failRate;
    if (Number.isInteger(d.status) && d.status >= 400 && d.status <= 599) state.status = d.status;
    return json(res, 200, { mode: state.mode, delayMs: state.delayMs, failRate: state.failRate, status: state.status });
  }
  if (p === '/health') return json(res, 200, { ok: true });

  if (p.startsWith('/cricket/v1/') || p.startsWith('/football/') || p.startsWith('/sms/') || p.startsWith('/casino/')) {
    if (await applyMode(res)) return;
  }

  // ---- cricapi.com আকার ----
  if (p === '/cricket/v1/currentMatches' || p === '/cricket/v1/matches') return json(res, 200, { status: 'success', data: cricketMatches(), info: { hitsToday: 1, hitsLimit: 100000 } });
  if (p === '/cricket/v1/match_info') return json(res, 200, { status: 'success', data: cricketMatches()[0] });
  // ---- RapidAPI football আকার ----
  if (p === '/football/predictions/list') return json(res, 200, { data: footballList() });
  // ---- SMS জেনেরিক গেটওয়ে: শুধু গ্রহণ করে, কোথাও পাঠায় না ----
  if (p === '/sms/send') { for await (const _ of req) { /* বডি ফেলে দেওয়া */ } return json(res, 200, { ok: true, id: crypto.randomUUID(), mock: true }); }
  // ---- ক্যাসিনো: গেম তালিকা (adapter-এর আকার প্রোভাইডারভেদে; এটা সাধারণ ফরম্যাট, প্রয়োজনে মানিয়ে নিন) ----
  if (p === '/casino/games') return json(res, 200, { games: Array.from({ length: 50 }, (_, i) => ({ id: `mock-game-${i + 1}`, name: `Mock Game ${i + 1}`, category: 'slots' })) });
  if (p.startsWith('/casino/')) return json(res, 200, { ok: true, mock: true });

  json(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`[mock-provider] listening on :${PORT} (control ${CONTROL_KEY ? 'enabled' : 'DISABLED — set MOCK_CONTROL_KEY'})`));
}
module.exports = { server, state };
