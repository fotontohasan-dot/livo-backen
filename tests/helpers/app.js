const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ইউনিক ফোন নাম্বার — টেস্ট ফাইল ও প্যারালাল ওয়ার্কার, সবকিছুর মধ্যে।
//
// আগের বাস্তবায়ন কাউন্টারটা globalThis-এ রাখত, এই ধারণায় যে "globalThis পুরো Jest
// প্রসেসে শেয়ার্ড"। সেটা ভুল — Jest প্রতিটা টেস্ট *ফাইলের* জন্য আলাদা sandbox global
// দেয়। পরীক্ষা করে দেখা গেছে: দুটো ফাইল একই প্রসেসে (pid অভিন্ন) চললেও দুজনেই
// কাউন্টার ১ পড়ে, ২ নয়। process.env-ও একইভাবে স্যান্ডবক্সড। ফলে দুটো ফাইল একই
// মিলিসেকেন্ডে কল করলে হুবহু একই নাম্বার তৈরি হতো, `phone TEXT UNIQUE`-এ রেজিস্ট্রেশন
// নীরবে ব্যর্থ হতো, আর টেস্ট ভাঙত এই চেহারায়:
//     TypeError: Cannot read properties of undefined (reading 'id')
//
// মেমরিতে থাকা কোনো কিছুই ফাইলগুলোর মধ্যে শেয়ার্ড নয়, তাই কাউন্টারটা ফাইল-সিস্টেমে।
// POSIX-এ O_APPEND-এ ছোট লেখা অ্যাটমিক, তাই ফাইলের আকারই একটা রেস-মুক্ত monotonic
// কাউন্টার — সব টেস্ট ফাইল ও সব প্যারালাল ওয়ার্কার মিলে ভাগ করে নেওয়া।
//
// ফরম্যাট আগের মতোই: '01' + ৯ ডিজিট (মোট ১১)। ৪ ডিজিট epoch-সেকেন্ড রান আলাদা করে
// (তাই কেউ tmp ফাইল মুছে ফেললেও পুরনো রানের নাম্বারের সাথে ধাক্কা লাগে না), আর
// ৫ ডিজিট ক্রম এক রানের ভেতরে অনন্যতা দেয় (১,০০,০০০ কল পর্যন্ত — পুরো সুইট এর
// ধারেকাছেও যায় না)।
const PHONE_SEQ_FILE = path.join(os.tmpdir(), 'livo-test-phone-seq');

function nextPhoneSeq() {
  fs.appendFileSync(PHONE_SEQ_FILE, '\0');
  return fs.statSync(PHONE_SEQ_FILE).size;
}

function uniquePhone() {
  const epoch = Math.floor(Date.now() / 1000) % 10000;
  const seq = nextPhoneSeq() % 100000;
  return `01${String(epoch).padStart(4, '0')}${String(seq).padStart(5, '0')}`;
}

module.exports = { app, server, expressApp, ensureListening, extractCsrfToken, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, fakeIp, wrapAgentWithIp, freshRequest };
