#!/usr/bin/env node
// scripts/loadtest/ws.js — Scenario 1: ধাপে ধাপে WS_TARGET (ডিফল্ট ১০০০) WebSocket সংযোগ, RAMP_SEC (৩০০) জুড়ে, তারপর HOLD_SEC (৬০০) ধরে রাখা।
// প্রতিটা সংযোগ একটা টেস্ট ম্যাচ রুমে (joinMatch) + "matches" রুমে ঢোকে এবং লাইভ ইভেন্ট (scoreUpdate/matchListUpdate/…) গোনে।
// ইভেন্ট আসে feed-driver থেকে: staging-এর POST /api/admin/feed-update (টেস্ট FEED_API_KEY, শুধু টেস্ট ম্যাচ) — প্রতি ২ সেকেন্ডে স্কোর বদলায়।
//
// আবশ্যক env:  LOADTEST_STAGING_URL (guard দেখুন)   LOADTEST_FEED_KEY (staging-এর টেস্ট FEED_API_KEY)
// ঐচ্ছিক:       WS_TARGET=1000 RAMP_SEC=300 HOLD_SEC=600 FEED_MATCHES=20 FEED_EVERY_MS=2000
//
// ক্লায়েন্ট: socket.io-client, transports ['websocket'] (সার্ভারের সাথে মেলে — public/js/socket-client.js)।
// "Session ID unknown" = polling transport ভুলে মাল্টি-ইনস্ট্যান্সে পড়লে; এখানে websocket-only, তাই 0 হওয়ার কথা।
// তবু connect_error/error-এর বার্তায় ওই টেক্সট খোঁজা হয় এবং গোনা হয়।
const { io } = require('socket.io-client');
const { assertStagingTarget } = require('./lib/guard');
const { Recorder } = require('./lib/recorder');
const { makeClient } = require('./lib/client');
const { num, sleep } = require('./lib/env');

async function main() {
  const target = assertStagingTarget();
  const FEED_KEY = process.env.LOADTEST_FEED_KEY || '';
  if (!FEED_KEY) { console.error('❌ LOADTEST_FEED_KEY নেই — ইভেন্ট ছাড়া "প্রতিটা সংযোগ লাইভ ইভেন্ট পায়" যাচাই করা যায় না।'); process.exit(2); }

  const TARGET = num('WS_TARGET', 1000), RAMP = num('RAMP_SEC', 300), HOLD = num('HOLD_SEC', 600);
  const FEED_MATCHES = num('FEED_MATCHES', 20), FEED_EVERY = num('FEED_EVERY_MS', 2000);
  const rec = new Recorder('ws-1000');
  const w = rec.ws;
  const api = makeClient(target.url, { maxSockets: 8 });

  // ---- feed-driver: টেস্ট ম্যাচ তৈরি/আপডেট ----
  let seq = 0;
  const matchIds = new Map(); // external_id -> db id (feed-update-এর রেসপন্স থেকে, না পেলে আগে ফাঁকা)
  async function pushFeed() {
    seq++;
    const matches = Array.from({ length: FEED_MATCHES }, (_, i) => ({
      external_id: `lt-${i + 1}`, sport: 'cricket', league: 'LoadTest', team_a: `LT A${i + 1}`, team_b: `LT B${i + 1}`,
      status: 'live', start_time: new Date().toISOString(), score_a: `${(seq * 3 + i) % 300}/${seq % 10}`, score_b: '', overs: `${seq % 20}.${seq % 6}`,
      markets: [{ key: 'mo', type: 'bookmaker', name: 'Match Odds', status: 'open', runners: [
        { key: '0', name: `LT A${i + 1}`, back: 1.8 + (seq % 5) / 100, lay: 1.85, back_size: 5000, lay_size: 5000 },
        { key: '1', name: `LT B${i + 1}`, back: 2.1, lay: 2.15, back_size: 5000, lay_size: 5000 }] }]
    }));
    const r = await api.request({ method: 'POST', path: '/api/admin/feed-update', headers: { 'x-feed-key': FEED_KEY }, body: { provider: 'loadtest', matches } });
    if (r.status !== 200) rec.note(`feed-update HTTP ${r.status || r.err}`);
    return r;
  }
  const first = await pushFeed();
  let ids = [];
  try { const j = JSON.parse(first.text); ids = (j.results || []).map((m) => m.match_id).filter(Boolean); } catch (_) { /* রেসপন্সের আকার ভিন্ন হতে পারে */ }
  if (!ids.length) {
    const live = await api.request({ path: '/matches/api/live' });
    try { const j = JSON.parse(live.text); ids = (j.cricket || []).filter((m) => /^LT /.test(m.team_a || m.homeTeam || m.title || '') || m.league === 'LoadTest').map((m) => m.id).filter(Boolean); } catch (_) { /* ignore */ }
  }
  if (!ids.length) rec.note('টেস্ট ম্যাচের DB id পাওয়া যায়নি — শুধু "matches" রুমের ইভেন্ট গোনা হবে (matchListUpdate)।');
  const feedTimer = setInterval(() => { pushFeed().catch(() => {}); }, FEED_EVERY);

  // ---- সংযোগ ----
  const sockets = [];
  let ending = false; // টেস্ট শেষে ইচ্ছাকৃত close() যেন disconnect হিসেবে না গোনা হয়
  const gotEvent = new Set();
  const EVENTS = ['scoreUpdate', 'matchListUpdate', 'marketUpdate', 'oddsUpdate', 'liveUpdate'];
  const spawn = (i) => {
    w.attempted++;
    const s = io(target.url, { transports: ['websocket'], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10000, timeout: 20000, forceNew: true, extraHeaders: { 'user-agent': 'livo-loadtest/1.0' } });
    let everConnected = false;
    s.on('connect', () => {
      w.currentConnected++; w.peakConnected = Math.max(w.peakConnected, w.currentConnected);
      if (!everConnected) { everConnected = true; w.connected++; } else { w.reconnects++; }
      s.emit('join_matches');
      if (ids.length) s.emit('joinMatch', ids[i % ids.length]);
    });
    s.on('disconnect', () => { if (ending) return; w.currentConnected--; w.disconnects++; });
    const onErr = (e) => {
      const msg = String((e && e.message) || e || '');
      if (/session id unknown/i.test(msg)) w.sessionIdUnknown++;
      if (!everConnected) w.connectErrors++;
    };
    s.on('connect_error', onErr); s.on('error', onErr);
    for (const ev of EVENTS) s.on(ev, () => { w.eventsReceived++; gotEvent.add(i); });
    sockets.push(s);
  };

  rec.note(`ramp: 0 → ${TARGET} সংযোগ, ${RAMP}s; তারপর hold ${HOLD}s → ${target.host}`);
  const t0 = Date.now();
  const sampler = setInterval(() => rec.timeline.push({ t: Math.round((Date.now() - t0) / 1000), connected: w.currentConnected, events: w.eventsReceived, disconnects: w.disconnects, reconnects: w.reconnects }), 1000);
  const stepMs = (RAMP * 1000) / TARGET;
  for (let i = 0; i < TARGET; i++) { spawn(i); await sleep(stepMs); }
  rec.note(`ramp শেষ: connected=${w.currentConnected}/${TARGET}`);

  const holdStartDisc = w.disconnects;
  await sleep(HOLD * 1000);
  w.connectedAtEnd = w.currentConnected;
  w.neverGotEvent = TARGET - gotEvent.size;
  rec.note(`hold শেষ: connected=${w.currentConnected}, hold-কালীন disconnect=${w.disconnects - holdStartDisc}, ইভেন্ট পায়নি=${w.neverGotEvent}`);

  ending = true;
  clearInterval(feedTimer); clearInterval(sampler);
  sockets.forEach((s) => s.close());
  api.destroy();
  const base = rec.write();
  console.log(rec.markdown());
  console.log(`\nফলাফল ফাইল: ${base}.json / .md`);
  // acceptance 1: <1% disconnect, zero "Session ID unknown"
  const ok = (w.disconnects / Math.max(1, w.connected)) < 0.01 && w.sessionIdUnknown === 0;
  console.log(ok ? '✅ লক্ষ্য পূরণ (disconnect < 1%, Session ID unknown = 0)' : '⚠️ লক্ষ্য পূরণ হয়নি — ওপরের টেবিল দেখুন');
  process.exit(0);
}
main().catch((e) => { console.error('ws scenario error:', e.message); process.exit(1); });
