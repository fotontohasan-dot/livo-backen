#!/usr/bin/env node
// scripts/loadtest/http.js — Scenario 2: বাস্তবসম্মত HTTP মিশ্রণ (বেশিরভাগ রিড, কিছু লগইন, কিছু বেট — শুধু টেস্ট ডেটা)।
// অনেক ইউজার একই কয়েকটা IP থেকে (মোবাইল CGNAT): এই স্ক্রিপ্ট X-Forwarded-For স্পুফ করে না — Render LB-র পেছনে স্পুফ আসলে কাজই করে না।
// তাই "অনেক ইউজার, কম IP" স্বাভাবিকভাবেই হয় যখন লোড-জেনারেটর ১–৩টা মেশিন থেকে চলে। কতগুলো IP ছিল তা REPORT-এ LOADTEST_GENERATOR_IPS লিখুন।
//
// আবশ্যক env:  LOADTEST_STAGING_URL, LOADTEST_PASSWORD (seedTestUsers.js যে পাসওয়ার্ড দিয়েছে)
// ঐচ্ছিক:       VUS=300 DURATION_SEC=600 RAMP_SEC=60 USER_PREFIX=loadtest_ USER_COUNT=500
//               MIX="read:80,login:5,bet:8,mylist:7"   THINK_MS=800
//
// রিড: GET /, /matches/api/live (ক্যাশড), /matches/:id, /matches/:id/markets
// লগইন: GET /login → CSRF → POST /login (VU-র নিজের টেস্ট অ্যাকাউন্ট; প্রতি-অ্যাকাউন্ট ১০/১৫মি লিমিট মানা হয়)
// বেট: POST /matches/:id/bet {demo:true, stake:min} — ডেমো ব্যালেন্স, আসল কয়েন/পেমেন্ট নয়; Idempotency-Key সহ
//
// ⚠️ বেটিং/ওয়ালেট/সেটলমেন্ট কোড অপরিবর্তিত; এখানে শুধু সার্বজনীন HTTP API ডাকা হয়।
const { assertStagingTarget } = require('./lib/guard');
const { Recorder } = require('./lib/recorder');
const { makeClient } = require('./lib/client');
const { num, sleep, jitter } = require('./lib/env');
const crypto = require('crypto');

function parseMix(s) {
  const out = []; let tot = 0;
  for (const part of String(s || 'read:80,login:5,bet:8,mylist:7').split(',')) {
    const [k, v] = part.split(':'); const n = Number(v);
    if (k && n > 0) { out.push([k.trim(), n]); tot += n; }
  }
  return { items: out, total: tot };
}
const pick = (mix) => { let r = Math.random() * mix.total; for (const [k, n] of mix.items) { if ((r -= n) <= 0) return k; } return mix.items[0][0]; };

function extractCsrf(html) {
  const m = /name="csrf-token"\s+content="([^"]+)"/i.exec(html) || /name="_csrf"\s+value="([^"]+)"/i.exec(html) || /content="([^"]+)"\s+name="csrf-token"/i.exec(html);
  return m ? m[1] : null;
}

/** http mix চালায়। drills.js এটাকে ব্যাকগ্রাউন্ড লোড হিসেবে ব্যবহার করে। @returns {{stop:()=>Promise<void>, rec:Recorder}} */
async function startHttpMix({ target, rec, vus, rampSec, mix, thinkMs, userPrefix, userCount, password, durationSec }) {
  const client = makeClient(target.url, { maxSockets: Math.max(64, vus) });
  let running = true;
  const timed = async (route, args) => { const r = await client.request(args); rec.http(route, r.status, r.ms, r.err); return r; };

  // ম্যাচ/মার্কেট আবিষ্কার (একবার)
  let matchIds = [], marketByMatch = {};
  const live = await client.request({ path: '/matches/api/live' });
  try { const j = JSON.parse(live.text); matchIds = ['cricket', 'football', 'tennis', 'other'].flatMap((k) => (j[k] || []).map((m) => m.id)).filter(Boolean).slice(0, 50); } catch (_) { /* ignore */ }
  for (const id of matchIds.slice(0, 20)) {
    const r = await client.request({ path: `/matches/${id}/markets` });
    try { const j = JSON.parse(r.text); const mk = (j.markets || []).find((m) => m && m.id && ((m.runners && m.runners.length) || m.odds)); if (mk) { const runner = mk.runners && mk.runners[0] ? String(mk.runners[0].key ?? mk.runners[0].id ?? '0') : '0'; marketByMatch[id] = { marketId: mk.id, runner }; } } catch (_) { /* ignore */ }
  }
  if (!matchIds.length) rec.note('কোনো টেস্ট ম্যাচ পাওয়া যায়নি — আগে ws.js-এর feed-driver বা মক প্রোভাইডার সিঙ্ক চালান।');
  const betTargets = Object.entries(marketByMatch);

  async function login(jar, username) {
    const page = await timed('GET /login', { path: '/login', jar });
    const csrf = extractCsrf(page.text);
    const form = new URLSearchParams({ identifier: username, password, ...(csrf ? { _csrf: csrf } : {}), form_rendered_at: String(Date.now() - 4000) }).toString();
    const r = await timed('POST /login', { method: 'POST', path: '/login', jar, body: form, headers: csrf ? { 'x-csrf-token': csrf } : {} });
    return r.status === 302 || r.status === 200;
  }

  async function vu(n) {
    await sleep((rampSec * 1000 * n) / vus); // ধাপে ধাপে শুরু
    const jar = new Map();
    const username = `${userPrefix}${String((n % userCount) + 1).padStart(4, '0')}`;
    let loggedIn = await login(jar, username);
    while (running) {
      const act = pick(mix);
      const mid = matchIds.length ? matchIds[Math.floor(Math.random() * matchIds.length)] : null;
      if (act === 'read') {
        const roll = Math.random();
        if (roll < 0.35) await timed('GET /matches/api/live', { path: '/matches/api/live', jar });
        else if (roll < 0.55) await timed('GET /', { path: '/', jar });
        else if (roll < 0.8 && mid) await timed('GET /matches/:id/markets', { path: `/matches/${mid}/markets`, jar });
        else if (mid) await timed('GET /matches/:id', { path: `/matches/${mid}`, jar });
      } else if (act === 'login') {
        loggedIn = await login(jar, username);
      } else if (act === 'mylist' && loggedIn) {
        await timed('GET /matches/api/my-bets', { path: '/matches/api/my-bets', jar });
      } else if (act === 'bet' && loggedIn && betTargets.length) {
        const [mId, mk] = betTargets[Math.floor(Math.random() * betTargets.length)];
        const csrfRes = await timed('GET /csrf-token', { path: '/csrf-token', jar });
        let tok = null; try { tok = JSON.parse(csrfRes.text).token; } catch (_) { /* ignore */ }
        await timed('POST /matches/:id/bet', { method: 'POST', path: `/matches/${mId}/bet`, jar,
          headers: { 'x-csrf-token': tok || '', 'idempotency-key': crypto.randomBytes(12).toString('hex') },
          body: { market_id: mk.marketId, runner: mk.runner, bet_type: 'back', stake: num('BET_STAKE', 10), demo: true } });
      }
      await sleep(jitter(thinkMs));
    }
  }

  const tasks = Array.from({ length: vus }, (_, i) => vu(i));
  const sampler = setInterval(() => rec.timeline.push({ t: Math.round((Date.now() - rec.startedAt) / 1000), requests: rec.seen, errors: (rec.byClass['5xx'] || 0) + (rec.byClass.net || 0), s429: rec.byStatus[429] || 0 }), 1000);
  return {
    rec,
    stop: async () => { running = false; clearInterval(sampler); await Promise.allSettled(tasks); client.destroy(); }
  };
}

async function main() {
  const target = assertStagingTarget();
  const password = process.env.LOADTEST_PASSWORD || '';
  if (!password) { console.error('❌ LOADTEST_PASSWORD নেই (seedTestUsers.js-এর পাসওয়ার্ড)। রিপোতে কোনো পাসওয়ার্ড রাখা হয় না।'); process.exit(2); }
  const vus = num('VUS', 300), dur = num('DURATION_SEC', 600), ramp = num('RAMP_SEC', 60);
  const rec = new Recorder('http-mix');
  rec.note(`VUS=${vus} duration=${dur}s ramp=${ramp}s mix=${process.env.MIX || 'default'} generator_ips=${process.env.LOADTEST_GENERATOR_IPS || 'unspecified'} → ${target.host}`);
  const run = await startHttpMix({ target, rec, vus, rampSec: ramp, mix: parseMix(process.env.MIX), thinkMs: num('THINK_MS', 800), userPrefix: process.env.USER_PREFIX || 'loadtest_', userCount: num('USER_COUNT', 500), password, durationSec: dur });
  await sleep(dur * 1000);
  await run.stop();
  const base = rec.write();
  console.log(rec.markdown());
  console.log(`\nফলাফল ফাইল: ${base}.json / .md`);
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error('http scenario error:', e.message); process.exit(1); });
module.exports = { startHttpMix, parseMix };
