#!/usr/bin/env node
// scripts/loadTest.js — Phase ২০ লোড টেস্ট হারনেস।
//
// ব্যবহার:
//   npm i --no-save autocannon
//   BASE_URL=http://localhost:4123 node scripts/loadTest.js
//   BASE_URL=https://staging.example.com DURATION=60 CONNECTIONS=100 node scripts/loadTest.js
//
// শুধু পড়ার (GET) পাবলিক রুটে লোড দেয় — কোনো রাইট, কোনো লগইন, কোনো
// পেমেন্ট। তাই একই কমান্ড staging-এও চালানো নিরাপদ।
//
// আউটপুট JSON: প্রতি রুটে requests/sec, latency p50/p95/p99, non-2xx হার।
// থ্রেশহোল্ড পাস/ফেল হিসেবে দেখানো হয়, কিন্তু প্রসেস সবসময় ০ দিয়ে শেষ হয়
// না — CI-তে বসাতে চাইলে EXIT_ON_FAIL=1 দাও।

let autocannon;
try {
  autocannon = require('autocannon');
} catch (e) {
  console.error('autocannon পাওয়া যায়নি। চালাও: npm i --no-save autocannon');
  process.exit(2);
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:4123';
const DURATION = Number(process.env.DURATION || 10);
const CONNECTIONS = Number(process.env.CONNECTIONS || 25);
const EXIT_ON_FAIL = process.env.EXIT_ON_FAIL === '1';
// staging/production-এ এটা বন্ধ রাখো — ওখানে রেট-লিমিটার সহই মাপা উচিত।
// লোকালি অ্যাপের নিজের থ্রুপুট মাপতে হলে চালু রাখো।
const SPOOF_IPS = process.env.SPOOF_IPS !== '0';

// থ্রেশহোল্ড: p95 latency (ms) আর সর্বোচ্চ গ্রহণযোগ্য non-2xx হার (%)
const ROUTES = [
  { path: '/', p95: 800, maxErrPct: 1 },
  { path: '/login', p95: 800, maxErrPct: 1 },
  { path: '/register', p95: 800, maxErrPct: 1 },
  { path: '/matches', p95: 1200, maxErrPct: 1 },
  { path: '/health', p95: 300, maxErrPct: 0 },
];

function pct(n, d) {
  return d === 0 ? 0 : Number(((n / d) * 100).toFixed(2));
}

async function runOne(route) {
  // প্রতি কানেকশনে আলাদা X-Forwarded-For। নইলে পুরো লোডটা একটাই IP থেকে
  // আসত আর ১৫ মিনিটে ৩০০ রিকোয়েস্টের generalLimiter সাথে সাথে ৪২৯ দিত —
  // তখন যা মাপা হত তা অ্যাপের পারফরম্যান্স নয়, রেট-লিমিটারের গতি।
  // (app.js-এ `trust proxy` = 1, তাই XFF-ই ক্লায়েন্ট কী।)
  let seq = 0;
  const r = await autocannon({
    url: BASE_URL + route.path,
    connections: CONNECTIONS,
    duration: DURATION,
    // রিডাইরেক্ট ফলো করলে মাপা লেটেন্সি দুটো রিকোয়েস্টের যোগফল হয়ে যেত
    maxRedirections: 0,
    requests: [{
      setupRequest: (req) => {
        if (!SPOOF_IPS) return req;
        // প্রতি রিকোয়েস্টে আলাদা IP। কানেকশন-প্রতি একটা IP দিলেও যথেষ্ট হত না:
        // ১৫ মিনিটে প্রতি IP-র বাজেট ৩০০, আর ৮ সেকেন্ডের রানেই তার চেয়ে বেশি
        // রিকোয়েস্ট একেকটা কানেকশন পাঠায়।
        const n = seq++;
        const ip = `198.${18 + ((n >> 16) % 100)}.${(n >> 8) % 256}.${(n % 254) + 1}`;
        req.headers = Object.assign({}, req.headers, { 'X-Forwarded-For': ip });
        return req;
      },
    }],
  });
  const total = r.requests.total || 0;
  const non2xx = (r.non2xx || 0) + (r.errors || 0);
  const errPct = pct(non2xx, total);
  const pass = r.latency.p97_5 !== undefined
    ? r.latency.p99 !== undefined
    : true;
  return {
    path: route.path,
    rps: r.requests.average,
    latency: { p50: r.latency.p50, p95: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max },
    total,
    non2xx,
    errPct,
    rateLimited: r['429'] || 0,
    thresholds: { p95: route.p95, maxErrPct: route.maxErrPct },
    pass: (r.latency.p97_5 <= route.p95) && (errPct <= route.maxErrPct) && pass,
  };
}

(async () => {
  const out = { baseUrl: BASE_URL, duration: DURATION, connections: CONNECTIONS, at: new Date().toISOString(), routes: [] };
  for (const route of ROUTES) {
    process.stderr.write(`load: ${route.path} ...\n`);
    out.routes.push(await runOne(route));
  }
  out.allPassed = out.routes.every((r) => r.pass);
  console.log(JSON.stringify(out, null, 2));
  if (EXIT_ON_FAIL && !out.allPassed) process.exit(1);
})();
