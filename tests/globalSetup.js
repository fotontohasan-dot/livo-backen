// tests/globalSetup.js
// ---------------------------------------------------------------------------
// প্রতিটা টেস্ট ফাইল Jest-এ নিজস্ব sandboxed module registry পায় — তাই
// `require('../../app')` প্রতিটা ফাইলে আলাদা আলাদা app.js ইনস্ট্যান্স বুট করে
// ফেলত (নিজস্ব scheduler/timer/DB pool সহ), যেগুলো একে অপরের সাথে race করে
// মাঝেমধ্যে flaky ফেইলিওর তৈরি করছিল।
//
// সমাধান: পুরো টেস্ট রানের জন্য app.js ঠিক একবার, একটা সত্যিকার child process
// হিসেবে বুট করা হয় (globalSetup — সব টেস্ট ফাইলের আগে একবার চলে), আর প্রতিটা
// টেস্ট ফাইল সেই একই লাইভ সার্ভারে HTTP দিয়ে (supertest base-URL মোডে) রিকোয়েস্ট
// পাঠায়। এতে production কোডে (app.js নিজে কীভাবে বুট হয়) কোনো পরিবর্তন লাগে না।
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { PORT, BASE_URL, PID_FILE } = require('./helpers/testServerConfig');

function loadEnv() {
  dotenv.config({ path: path.join(__dirname, '..', '.env.test') });
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(PORT);
  process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-do-not-use-in-production';
  process.env.DB_SSL = process.env.DB_SSL || 'false';
  process.env.SSLCZ_IS_LIVE = 'false';
  process.env.SSLCZ_STORE_ID = process.env.SSLCZ_STORE_ID || 'test-store';
  process.env.SSLCZ_STORE_PASSWD = process.env.SSLCZ_STORE_PASSWD || 'test-pass';
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://livo_test:livo_test@127.0.0.1:5433/livo_test';
  }
  return process.env.DATABASE_URL;
}

function httpGetStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForHttpReady(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    const status = await httpGetStatus(`${BASE_URL}/ready`);
    if (status === 200) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('app.js (child process) did not respond on /ready in time');
}

async function waitForMigrations(databaseUrl, retries = 40, delayMs = 500) {
  const client = new Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    for (let i = 0; i < retries; i++) {
      const res = await client.query(
        `SELECT to_regclass('public.roles') AS roles, to_regclass('public.notification_templates') AS templates`
      );
      const row = res.rows[0];
      if (row && row.roles && row.templates) return true;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('Database migrations did not finish in time (globalSetup)');
  } finally {
    await client.end();
  }
}

module.exports = async function globalSetup() {
  const databaseUrl = loadEnv();

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'app.js')], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  child.stdout.on('data', (d) => process.stdout.write(`[test-server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[test-server:err] ${d}`));

  fs.writeFileSync(PID_FILE, String(child.pid));

  await waitForHttpReady();
  await waitForMigrations(databaseUrl);
};
