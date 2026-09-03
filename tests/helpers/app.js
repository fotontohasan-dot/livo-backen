const http = require('http');
const request = require('supertest');
const expressApp = require('../../app.js');

// ---------------------------------------------------------------------------
// একটাই দীর্ঘস্থায়ী HTTP সার্ভার — পুরো টেস্ট ফাইলের জন্য।
//
// আগে টেস্টগুলো সরাসরি `request(expressApp)` ব্যবহার করত। supertest তখন প্রতিটা
// রিকোয়েস্টের জন্য নিজে সার্ভার ম্যানেজ করে (lib/test.js → serverAddress):
//     if (!app.address()) this._server = app.listen(0);
// এবং রেসপন্স শেষে `this._server.close()` ডাকে।
//
// সমান্তরাল রিকোয়েস্টে (যেমন games-cashout-timing.test.js-এর ১০টা একসাথে পাঠানো
// cashout) এটা রেস তৈরি করত: `listen()` অ্যাসিনক্রোনাস, তাই একাধিক রিকোয়েস্ট
// একই সময়ে `app.address()` কে null দেখে প্রত্যেকে নিজের `_server` রেফারেন্স ধরে
// রাখত; এরপর যেটা প্রথমে শেষ হতো সেটা `server.close()` ডেকে বাকিদের চলমান
// সকেট ভেঙে দিত → ক্লায়েন্ট পেত `read ECONNRESET`।
//
// লোকালি এটা কদাচিৎ ধরা পড়ত (৩০ রাউন্ডে ~১ বার), কিন্তু CI-এর ধীর/লোডেড
// রানারে টাইমিং উইন্ডো বড় হওয়ায় নিয়মিত ব্যর্থ হতো। এটা অ্যাপ্লিকেশনের বাগ নয় —
// cashout-এর DB-স্তরের atomic claim সবসময়ই ঠিক কাজ করেছে (টেস্টের DB assertion
// সেটাই প্রমাণ করে); এটা ছিল টেস্ট ইনফ্রাস্ট্রাকচারের লাইফসাইকেল রেস।
//
// ফিক্স: সার্ভার একবারই তৈরি ও listen করা হয় (beforeAll) এবং ফাইল শেষে বন্ধ হয়
// (afterAll)। যেহেতু supertest ইতিমধ্যে listening সার্ভার পায়, সে নিজে আর
// listen/close করে না — কোনো রিকোয়েস্ট আরেকটার সকেট ভাঙতে পারে না।
// ---------------------------------------------------------------------------
const server = http.createServer(expressApp);

// Jest-এর বাইরে (যেমন কোনো স্ক্রিপ্ট) require করা হলে হুকগুলো থাকবে না — তখন
// প্রথম ব্যবহারের সময় lazily listen করা হয়।
function ensureListening() {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve(server));
  });
}

if (typeof beforeAll === 'function' && typeof afterAll === 'function') {
  beforeAll(async () => { await ensureListening(); });
  afterAll(async () => {
    if (!server.listening) return;
    // keep-alive সকেট ঝুলে থাকলে close() কখনো কলব্যাক দেয় না — জোর করে বন্ধ করা হয়
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  });
}

// টেস্টগুলো `app` নামেই ব্যবহার করে; এখন সেটা listening http.Server —
// supertest দুটোই গ্রহণ করে, কিন্তু Server দিলে সে নিজে listen/close করে না।
const app = server;

const REALISTIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractCsrfToken(html) {
  const match = /<meta name="csrf-token" content="([^"]*)"/.exec(html || '');
  return match ? match[1] : '';
}

// app.js-এ trust proxy সেট করা আছে, তাই X-Forwarded-For-কে আসল client IP হিসেবে গণ্য করা
// হয়। এই টেস্ট হেল্পার দিয়ে তৈরি প্রতিটা agent-কে তার নিজস্ব র‍্যান্ডম fake IP দেওয়া হয় —
// নাহলে পুরো টেস্ট স্যুট (অনেক register/login) একই loopback IP + একই UA থেকে আসে বলে
// services/botDetection.js-এর velocity/fingerprint-ভিত্তিক সুরক্ষা সঠিক ক্রেডেনশিয়াল
// দিয়েও login-কে false-positive ব্লক করে ফেলতে পারে (flaky টেস্ট)।
function fakeIp() {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

function wrapAgentWithIp(rawAgent, ip) {
  const methods = ['get', 'post', 'put', 'delete', 'patch'];
  const wrapped = {};
  methods.forEach((m) => {
    wrapped[m] = (path) => rawAgent[m](path).set('X-Forwarded-For', ip).set('User-Agent', REALISTIC_UA);
  });
  return wrapped;
}

// সেশনবিহীন (agent ছাড়া) এককালীন রিকোয়েস্টের জন্য — প্রতিবার নতুন র‍্যান্ডম client IP দেয়।
// রেট-লিমিটার IP-ভিত্তিক, তাই সব টেস্ট একই loopback IP ব্যবহার করলে একটা টেস্টের ব্যবহার করা
// কোটা পরের টেস্টে লিক করে (যেমন login rate-limit টেস্ট চালানোর পর অন্য টেস্ট 403-এর বদলে
// 429 পেত — টেস্ট অর্ডারের উপর নির্ভরশীল ফলাফল)। এই হেল্পার দিয়ে প্রতিটা রিকোয়েস্ট নিজস্ব
// আলাদা IP বাকেট পায়, ফলে টেস্টগুলো একে অপরের থেকে স্বাধীন থাকে।
function freshRequest(ip) {
  return wrapAgentWithIp(request(app), ip || fakeIp());
}

async function getCsrfAgent(path = '/login') {
  // Jest-এ beforeAll হুকই সার্ভার চালু করে দেয়; এই await শুধু নিরাপত্তা-জাল
  // (হুকবিহীন কোনো স্ক্রিপ্ট থেকে ব্যবহার করলেও সার্ভার listening থাকবে,
  // ফলে supertest কখনোই নিজে listen/close করার সুযোগ পাবে না)।
  await ensureListening();
  const ip = fakeIp();
  const rawAgent = request.agent(app);
  const agent = wrapAgentWithIp(rawAgent, ip);
  const res = await agent.get(path);
  const token = extractCsrfToken(res.text);
  return { agent, token, ip };
}

function uniqueUsername(prefix = 'tu') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36).slice(-6)}${rand}`.slice(0, 20);
}

// ফোন-নাম্বার অ্যালোকেটর আলাদা মডিউলে (tests/helpers/uniquePhone.js) — কারণ ওটার
// রিগ্রেশন টেস্টকে একাধিক আলাদা প্রসেস থেকে কল করতে হয়, আর তখন পুরো express app
// লোড করার দরকার নেই। এই ফাইলের পাবলিক API আগের মতোই আছে।
const { uniquePhone, PHONE_SEQ_DIR, PHONE_SEQ_FILE, PHONE_SEQ_LOCK } = require('./uniquePhone');

module.exports = { app, server, expressApp, ensureListening, extractCsrfToken, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, fakeIp, wrapAgentWithIp, freshRequest };
// রিগ্রেশন টেস্টের জন্য — helper-এর পাবলিক API অপরিবর্তিত, শুধু অতিরিক্ত এক্সপোর্ট।
module.exports.__phoneSeqPaths = { dir: PHONE_SEQ_DIR, file: PHONE_SEQ_FILE, lock: PHONE_SEQ_LOCK };
