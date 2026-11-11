#!/usr/bin/env node
// scripts/migrate.js
// ---------------------------------------------------------------------------
// Standalone migration runner (Task 2.6).
//
// `node scripts/migrate.js` চালায় একই `runMigrations()` (migrations.js — কোনো SQL ডুপ্লিকেট নেই,
// Task 2.4-এর advisory lock সহ), তারপর pool বন্ধ করে বেরিয়ে যায়।
//
//   exit 0 → migration সফল
//   exit 1 → migration/কনফিগ ব্যর্থ
//
// ডাটাবেস URL: `MIGRATION_DATABASE_URL` থাকলে সেটা, না থাকলে `DATABASE_URL`। (ওভাররাইড শুধু এই
// প্রসেসের env বদলায় — db.js/web/worker-এর আচরণ অপরিবর্তিত; db.js প্রথম require-এর সময় env পড়ে,
// তাই ওভাররাইড অবশ্যই ../db লোড হওয়ার আগে বসানো হয়।) সরাসরি/session-mode কানেকশন দিতে এটা কাজে লাগে।
//
// URL, পাসওয়ার্ড বা টোকেন কখনো লগে যায় না: শুধু কোন ভ্যারিয়েবল ব্যবহৃত হলো তার নাম লেখা হয় এবং
// error বার্তা থেকে URL/পাসওয়ার্ড মুছে (redact) দেওয়া হয়।
//
// এটা এখনো কোনো deploy কনফিগে যুক্ত নয়; boot-time migration আগের মতোই চলে।
// ---------------------------------------------------------------------------

const process = require('node:process');

function collectSecrets(env) {
  const secrets = new Set();
  for (const key of ['MIGRATION_DATABASE_URL', 'DATABASE_URL']) {
    const value = (env[key] || '').trim();
    if (!value) continue;
    secrets.add(value);
    try {
      const u = new URL(value);
      if (u.password) { secrets.add(u.password); secrets.add(decodeURIComponent(u.password)); }
    } catch (e) { /* অবৈধ URL — পুরো মানটাই secret হিসেবে ধরা আছে */ }
  }
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
}

function redact(text, env = process.env) {
  let out = String(text == null ? '' : text);
  for (const s of collectSecrets(env)) out = out.split(s).join('<redacted>');
  return out.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://<redacted>');
}

// MIGRATION_DATABASE_URL থাকলে DATABASE_URL-কে (এই প্রসেসে) সেটা দিয়ে বদলে দেয়। ব্যবহৃত হলে true।
function applyOverride(env = process.env) {
  const override = (env.MIGRATION_DATABASE_URL || '').trim();
  if (!override) return false;
  env.DATABASE_URL = override;
  return true;
}

function defaultLoad() {
  return { runMigrations: require('../migrations'), pool: require('../db').pool };
}

async function run({ env = process.env, log = console, load = defaultLoad } = {}) {
  // ওভাররাইডের আগের URL-গুলো (দুটোই) redact-এর জন্য ধরে রাখা — নইলে DATABASE_URL বদলে গেলে পুরোনো secret হারিয়ে যেত
  const secretsEnv = { DATABASE_URL: env.DATABASE_URL, MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL };
  const overridden = applyOverride(env);
  if (!(env.DATABASE_URL || '').trim()) {
    log.error('❌ migrate: DATABASE_URL (বা MIGRATION_DATABASE_URL) সেট করা নেই');
    return 1;
  }
  // এই প্রসেস শুধু একটা কানেকশন (লক + migration) ব্যবহার করে; ছোট pool যথেষ্ট। স্পষ্ট মান থাকলে সেটাই।
  if (!env.DB_POOL_MAX) env.DB_POOL_MAX = '2';

  log.log(`🗄️ migrate: ${overridden ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL'} ব্যবহার করা হচ্ছে`);

  let deps = null;
  let code = 0;
  try {
    deps = load();
    await deps.runMigrations();
    log.log('✅ migrate: সব migration সম্পন্ন');
  } catch (err) {
    log.error('❌ migrate: ব্যর্থ —', redact(err && err.message ? err.message : err, secretsEnv));
    code = 1;
  } finally {
    if (deps && deps.pool && typeof deps.pool.end === 'function') {
      try {
        await deps.pool.end();
      } catch (err) {
        log.warn('⚠️ migrate: pool বন্ধ করতে সমস্যা —', redact(err && err.message ? err.message : err, secretsEnv));
      }
    }
  }
  return code;
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  run().then((code) => {
    process.exitCode = code;
    // কোনো বাকি হ্যান্ডল প্রসেস আটকে রাখলেও যেন ঝুলে না থাকে (unref — স্বাভাবিক বেরোনো আটকায় না)
    setTimeout(() => process.exit(code), 5000).unref();
  });
}

module.exports = { run, redact, applyOverride };
