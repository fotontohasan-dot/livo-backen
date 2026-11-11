#!/usr/bin/env node
// scripts/loadtest/drills.js — Scenario 3: লোডের মধ্যে ব্যর্থতা-ড্রিল। Recovery time মাপা হয়।
//
//   node scripts/loadtest/drills.js redis      # Redis রিস্টার্ট (সেশন/কিউ Redis অথবা ক্যাশ Redis — আপনি ড্যাশবোর্ড থেকে চালান)
//   node scripts/loadtest/drills.js web        # একটা web ইন্সট্যান্স kill/restart (ড্যাশবোর্ড থেকে)
//   node scripts/loadtest/drills.js provider   # মক প্রোভাইডার ধীর/ব্যর্থ — এটা স্ক্রিপ্ট নিজেই নিয়ন্ত্রণ করে
//
// redis/web: স্ক্রিপ্ট ব্যাকগ্রাউন্ড HTTP লোড + প্রতি সেকেন্ডে probe (/health, /ready, /matches/api/live) চালায়।
// "ACTION NOW" ছাপলে (বা ENTER চাপলে — TTY হলে) আপনি Render ড্যাশবোর্ড থেকে অ্যাকশনটা করেন; স্ক্রিপ্ট সেই মুহূর্ত থেকে সময় মাপে।
// Render API দিয়ে স্বয়ংক্রিয় করা হয়নি — সার্ভিস ID/API key স্ক্রিপ্টে রাখতে হতো এবং production ভুল ঘটার ঝুঁকি।
//
// env: LOADTEST_STAGING_URL (আবশ্যক)  LOADTEST_PASSWORD  VUS=100  DRILL_WARMUP_SEC=60  DRILL_MAX_SEC=600  OK_STREAK=10
//      provider: MOCK_URL  MOCK_CONTROL_KEY  DRILL_DELAY_MS=15000  DRILL_PHASE_SEC=120   METRICS_TOKEN (ঐচ্ছিক — breaker অবস্থা পড়তে)
const readline = require('readline');
const { assertStagingTarget } = require('./lib/guard');
const { Recorder, percentile } = require('./lib/recorder');
const { makeClient } = require('./lib/client');
const { startHttpMix, parseMix } = require('./http');
const { num, sleep } = require('./lib/env');

const PROBES = [['/health', 'health'], ['/ready', 'ready'], ['/matches/api/live', 'live']];

async function probeOnce(client) {
  const out = {};
  await Promise.all(PROBES.map(async ([p, k]) => { const r = await client.request({ path: p }); out[k] = { status: r.status, ms: r.ms, rl: r.headers['ratelimit-remaining'] }; }));
  return out;
}
const allOk = (s) => PROBES.every(([, k]) => s[k].status === 200);

function waitForAction(label) {
  return new Promise((resolve) => {
    console.log(`\n>>> ACTION NOW: ${label}`);
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      console.log('    অ্যাকশন শুরু করার মুহূর্তে ENTER চাপুন (সময় এখান থেকে মাপা হবে)...');
      rl.once('line', () => { rl.close(); resolve(Date.now()); });
    } else {
      const sec = num('DRILL_ACTION_AFTER_SEC', 30);
      console.log(`    non-TTY: ${sec}s পরে অ্যাকশন ধরা হবে — এর মধ্যে করুন।`);
      setTimeout(() => resolve(Date.now()), sec * 1000);
    }
  });
}

async function infraDrill(kind, target) {
  const rec = new Recorder(`drill-${kind}`);
  const probeClient = makeClient(target.url, { maxSockets: 8 });
  const loadOn = !!process.env.LOADTEST_PASSWORD;
  let load = null;
  if (loadOn) {
    load = await startHttpMix({ target, rec, vus: num('VUS', 100), rampSec: 20, mix: parseMix(), thinkMs: 800, userPrefix: process.env.USER_PREFIX || 'loadtest_', userCount: num('USER_COUNT', 500), password: process.env.LOADTEST_PASSWORD, durationSec: 0 });
  } else rec.note('LOADTEST_PASSWORD নেই → ব্যাকগ্রাউন্ড লোড ছাড়া শুধু probe। (আসল ড্রিল লোডের মধ্যে করুন)');

  const series = []; // { t, ok, s }
  const t0 = Date.now();
  let actionAt = null;
  const label = kind === 'redis' ? 'Render ড্যাশবোর্ডে Key Value (Redis) রিস্টার্ট করুন' : 'Render ড্যাশবোর্ডে একটা web ইন্সট্যান্স kill/restart করুন';
  const warm = num('DRILL_WARMUP_SEC', 60);
  const actionP = sleep(warm * 1000).then(() => waitForAction(label)).then((t) => { actionAt = t; rec.note(`অ্যাকশন চিহ্নিত: t+${Math.round((t - t0) / 1000)}s`); });

  const maxSec = num('DRILL_MAX_SEC', 600), streakNeed = num('OK_STREAK', 10);
  let streak = 0, firstFailAt = null, recoveredAt = null, lastFailAt = null;
  while (Date.now() - t0 < maxSec * 1000) {
    const s = await probeOnce(probeClient);
    const ok = allOk(s);
    series.push({ t: Date.now(), ok, s });
    if (actionAt) {
      if (!ok) { if (!firstFailAt) { firstFailAt = Date.now(); rec.note(`প্রথম probe ব্যর্থ: ready=${s.ready.status} live=${s.live.status} health=${s.health.status}`); } lastFailAt = Date.now(); streak = 0; }
      else { streak++; if (firstFailAt && !recoveredAt && streak >= streakNeed) { recoveredAt = lastFailAt + 1; rec.note('recovery নিশ্চিত'); break; } }
      if (!firstFailAt && Date.now() - actionAt > num('DRILL_NOFAIL_SEC', 90)) { rec.note('অ্যাকশনের পর কোনো probe ব্যর্থ হয়নি — সাইট চালু ছিল'); break; }
    }
    await sleep(1000);
  }
  await actionP.catch(() => {});

  // লিমিটার কি আবার শেয়ার্ড (Redis) হয়েছে? ক্রমিক GET-এ ratelimit-remaining নন-ইনক্রিজিং হওয়া উচিত
  const rl = [];
  for (let i = 0; i < 20; i++) { const r = await probeClient.request({ path: '/matches/api/live' }); if (r.headers['ratelimit-remaining'] !== undefined) rl.push(Number(r.headers['ratelimit-remaining'])); }
  const nonIncreasing = rl.length > 1 && rl.every((v, i) => i === 0 || v <= rl[i - 1]);
  if (load) await load.stop();

  const post = series.filter((x) => actionAt && x.t >= actionAt);
  const failed = post.filter((x) => !x.ok).length;
  const result = {
    kind, actionAtOffsetSec: actionAt ? Math.round((actionAt - t0) / 1000) : null,
    firstFailAfterActionSec: firstFailAt ? Math.round((firstFailAt - actionAt) / 1000) : null,
    recoverySec: recoveredAt && actionAt ? Math.round((recoveredAt - actionAt) / 1000) : null,
    probesAfterAction: post.length, probesFailed: failed,
    siteStayedUp: failed === 0,
    limiterSharedAfterRecovery: rl.length > 1 ? nonIncreasing : 'n/a (RateLimit header নেই)',
    liveProbeP95Ms: percentile(post.map((x) => x.s.live.ms).sort((a, b) => a - b), 95)
  };
  rec.note(JSON.stringify(result));
  return { rec, result };
}

async function providerDrill(target) {
  const mockUrl = process.env.MOCK_URL, key = process.env.MOCK_CONTROL_KEY;
  if (!mockUrl || !key) { console.error('❌ MOCK_URL ও MOCK_CONTROL_KEY লাগবে (mockProvider.js-এর ঠিকানা ও কন্ট্রোল key)।'); process.exit(2); }
  // মক নিজেও আসল প্রোভাইডার নয় — তবু অজান্তে আসল API-তে নিয়ন্ত্রণ পাঠানো এড়াতে হোস্ট যাচাই
  if (/cricapi\.com|rapidapi\.com/i.test(mockUrl)) { console.error('❌ MOCK_URL আসল প্রোভাইডারের মতো দেখাচ্ছে — প্রত্যাখ্যাত।'); process.exit(2); }
  const mock = makeClient(mockUrl, { maxSockets: 2 });
  const setMode = (body) => mock.request({ method: 'POST', path: '/__control', headers: { 'x-mock-control-key': key }, body });
  const app = makeClient(target.url, { maxSockets: 32 });
  const rec = new Recorder('drill-provider');
  const phaseSec = num('DRILL_PHASE_SEC', 120);

  const load = process.env.LOADTEST_PASSWORD
    ? await startHttpMix({ target, rec, vus: num('VUS', 100), rampSec: 20, mix: parseMix(), thinkMs: 800, userPrefix: process.env.USER_PREFIX || 'loadtest_', userCount: num('USER_COUNT', 500), password: process.env.LOADTEST_PASSWORD, durationSec: 0 })
    : null;
  const phases = {};
  async function measure(name, sec) {
    const lat = { health: [], live: [], home: [] }; let errs = 0, n = 0;
    const end = Date.now() + sec * 1000;
    while (Date.now() < end) {
      const [a, b, c] = await Promise.all([app.request({ path: '/health' }), app.request({ path: '/matches/api/live' }), app.request({ path: '/' })]);
      lat.health.push(a.ms); lat.live.push(b.ms); lat.home.push(c.ms); n += 3; errs += [a, b, c].filter((r) => r.err || r.status >= 500).length;
      await sleep(500);
    }
    const p = (arr) => percentile([...arr].sort((x, y) => x - y), 95);
    phases[name] = { sec, samples: n, errors: errs, p95: { health: p(lat.health), live: p(lat.live), home: p(lat.home) } };
    rec.note(`${name}: ${JSON.stringify(phases[name])}`);
  }
  async function breakers() {
    if (!process.env.METRICS_TOKEN) return null;
    const r = await app.request({ path: '/metrics', headers: { 'x-metrics-token': process.env.METRICS_TOKEN } });
    return (r.text.match(/^bet420_circuit_breaker_state\{[^}]*\} \d+$/gm) || []);
  }
  await setMode({ mode: 'ok' }); await measure('baseline', phaseSec);
  await setMode({ mode: 'slow', delayMs: num('DRILL_DELAY_MS', 15000) }); rec.note('mock: SLOW'); await measure('provider_slow', phaseSec);
  rec.note(`breakers(slow): ${JSON.stringify(await breakers())}`);
  await setMode({ mode: 'fail', status: 503 }); rec.note('mock: FAIL 503'); await measure('provider_failing', phaseSec);
  rec.note(`breakers(fail): ${JSON.stringify(await breakers())}`);
  await setMode({ mode: 'ok' }); rec.note('mock: OK (recovery)'); await measure('after_recovery', phaseSec);
  rec.note(`breakers(recovered): ${JSON.stringify(await breakers())}`);
  if (load) await load.stop();

  const b = phases.baseline.p95, s = phases.provider_slow.p95;
  const ratio = (k) => (b[k] ? (s[k] / b[k]).toFixed(2) : 'n/a');
  rec.note(`অসংশ্লিষ্ট রুটে p95 অনুপাত (slow/baseline): health=${ratio('health')} live=${ratio('live')} home=${ratio('home')} — ~1 মানে ধীর প্রোভাইডার অন্য রিকোয়েস্ট ধীর করেনি`);
  return { rec, result: phases };
}

async function main() {
  const target = assertStagingTarget();
  const kind = process.argv[2];
  if (!['redis', 'web', 'provider'].includes(kind)) { console.error('ব্যবহার: drills.js redis|web|provider'); process.exit(2); }
  const { rec } = kind === 'provider' ? await providerDrill(target) : await infraDrill(kind, target);
  const base = rec.write();
  console.log(rec.markdown());
  console.log(`\nফলাফল ফাইল: ${base}.json / .md`);
  process.exit(0);
}
main().catch((e) => { console.error('drill error:', e.message); process.exit(1); });
