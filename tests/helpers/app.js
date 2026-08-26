const request = require('supertest');
const app = require('../../app.js');

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

// পুরো টেস্ট ফাইলে (একই process-এ, maxWorkers:1) নিশ্চিতভাবে ইউনিক ফোন নাম্বার দরকার —
// আগে প্রতিটা টেস্ট ফাইলে আলাদাভাবে `'01' + String(Date.now()).slice(-9)` লেখা হতো, যা
// একই মিলিসেকেন্ডে দুইবার কল হলে (যেমন দুইটা registerUser() পরপর) হুবহু একই ফোন নাম্বার
// তৈরি করত এবং DB-এর UNIQUE constraint-এ ভেঙে টেস্ট ফ্লেকি করে দিত (একটা টেস্ট ফাইলে এমনকি
// randomness যোগ করার চেষ্টা হয়েছিল কিন্তু .slice(0, 11) সেই র‍্যান্ডম অংশটাই কেটে ফেলত)।
// একটা module-level monotonic counter ব্যবহার করে এই ফাংশন প্রতিটা কলে সম্পূর্ণ ইউনিক
// (কখনো কলিশন না হওয়া) ১১-ডিজিট ফোন নাম্বার দেয়।
// গুরুত্বপূর্ণ: কাউন্টারটা globalThis-এ রাখা হয়েছে, module-scope ভ্যারিয়েবলে নয়। Jest প্রতিটা
// টেস্ট ফাইলের জন্য আলাদা module registry তৈরি করে, তাই module-level কাউন্টার প্রতি ফাইলে
// ০ থেকে শুরু হতো — ফলে দুইটা ভিন্ন ফাইল একই মিলিসেকেন্ডে কল করলে হুবহু একই ফোন নাম্বার
// তৈরি হতে পারত, দ্বিতীয় রেজিস্ট্রেশন UNIQUE constraint-এ ব্যর্থ হতো এবং টেস্ট অর্ডার-নির্ভরভাবে
// ফেল করত। globalThis পুরো Jest প্রসেসে শেয়ার্ড, তাই কাউন্টার সব ফাইল জুড়ে monotonic থাকে।
function uniquePhone() {
  globalThis.__livoPhoneSeq = (globalThis.__livoPhoneSeq || 0) + 1;
  const base = String(Date.now() % 1e6).padStart(6, '0'); // সময়ভিত্তিক ৬ ডিজিট
  const seq = String(globalThis.__livoPhoneSeq % 1000).padStart(3, '0'); // প্রতি কলে বাড়ে — সব ফাইল জুড়ে কলিশন-প্রুফ
  return `01${base}${seq}`;
}

module.exports = { app, extractCsrfToken, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, fakeIp, wrapAgentWithIp, freshRequest };
