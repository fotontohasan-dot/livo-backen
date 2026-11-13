// scripts/loadtest/lib/env.js — ছোট ইউটিলিটি: env থেকে সংখ্যা, sleep, নিরাপদ লগিং।
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.5 + Math.random()));
module.exports = { num, sleep, jitter };
