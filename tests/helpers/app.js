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

module.exports = { app, extractCsrfToken, getCsrfAgent, uniqueUsername, REALISTIC_UA, fakeIp, wrapAgentWithIp };
