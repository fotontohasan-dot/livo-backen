// PROCESS_ROLE — বাস্তব `node server.js` child process দিয়ে web / worker / all / invalid যাচাই।
// (mock নয়: আসল প্রসেস, আসল test PostgreSQL, আসল SIGTERM।)
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const BASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/bet420_test';

jest.setTimeout(90000);

function boot(role, port, extraEnv = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DATABASE_URL: BASE_URL,
    DATABASE_SSL: 'false',
    SESSION_SECRET: 'process_role_test_secret_key_long_enough',
    REDIS_ENABLED: 'false',
    REDIS_URL: '',
    SSLCZ_IS_LIVE: 'false',
    VAPID_SUBJECT: 'mailto:test@example.com',
    FRONTEND_URL: 'http://localhost:4123',
    BACKUP_SCHEDULE_HOURS: '0',
    ...extraEnv
  };
  if (role === null) delete env.PROCESS_ROLE; else env.PROCESS_ROLE = role;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, logs: () => out, exited };
}

function waitForLog(proc, regex, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (regex.test(proc.logs())) return resolve();
      if (Date.now() > deadline) return reject(new Error(`log pattern ${regex} not seen.\n${proc.logs().slice(-1500)}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000, headers: { Origin: 'http://localhost:4123' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 40000;
  for (;;) {
    try { const r = await httpGet(port, '/health'); if (r.status === 200) return; } catch (e) { /* retry */ }
    if (Date.now() > deadline) throw new Error('web did not become healthy');
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function terminate(proc) {
  if (proc.child.exitCode === null) proc.child.kill('SIGTERM');
  return Promise.race([
    proc.exited,
    new Promise((_, rej) => setTimeout(() => { proc.child.kill('SIGKILL'); rej(new Error('did not exit on SIGTERM:\n' + proc.logs().slice(-1500))); }, 20000))
  ]);
}

const BG = {
  scheduler: /Scheduler চালু হয়েছে/,
  matchSync: /Syncing real matches/,
  queueWorker: /\[queue\] worker started/,
  queueSystem: /Queue System চালু হয়নি|Background Queue System চালু হয়েছে/,
  producers: /Queue producers চালু হয়নি|Queue producers প্রস্তুত/
};

describe('Test A — PROCESS_ROLE=web', () => {
  test('HTTP + Express + Socket.IO চালু; কোনো ব্যাকগ্রাউন্ড কাজ নয়', async () => {
    const port = 14911;
    const p = boot('web', port);
    try {
      await waitForHealth(port);
      await waitForLog(p, BG.producers);
      // Express route
      const login = await httpGet(port, '/login');
      expect([200, 302]).toContain(login.status);
      // Socket.IO handshake (polling)
      const sio = await httpGet(port, '/socket.io/?EIO=4&transport=polling');
      expect(sio.status).toBe(200);
      expect(sio.body).toMatch(/"sid"/);
      // ৫ সেকেন্ড অপেক্ষা: ৩ সেকেন্ডের বুট-টাইমার থাকলে তা এর মধ্যে ফায়ার হতো
      await new Promise((r) => setTimeout(r, 5000));
      const log = p.logs();
      expect(log).toMatch(/PROCESS_ROLE=web/);
      expect(log).toMatch(/Server running on port/);
      expect(log).not.toMatch(BG.scheduler);
      expect(log).not.toMatch(BG.matchSync);
      expect(log).not.toMatch(BG.queueWorker);
      expect(log).not.toMatch(/Background Queue System চালু হয়েছে/); // BullMQ consumer নেই
      expect(log).not.toMatch(/ব্যাকআপ|scheduled backup/i);
    } finally {
      const r = await terminate(p);
      expect(r.code).toBe(0);
    }
  });
});

describe('Test B — PROCESS_ROLE=worker', () => {
  test('ব্যাকগ্রাউন্ড চালু; HTTP পোর্ট/Socket.IO নেই; SIGTERM-এ পরিষ্কার exit 0', async () => {
    const port = 14912;
    const p = boot('worker', port);
    try {
      await waitForLog(p, BG.scheduler);
      await waitForLog(p, BG.matchSync);
      await waitForLog(p, BG.queueWorker);
      await waitForLog(p, BG.queueSystem);
      const log = p.logs();
      expect(log).toMatch(/PROCESS_ROLE=worker/);
      expect(log).toMatch(/Worker চালু/);
      expect(log).not.toMatch(/Server running on port/);
      expect(log).not.toMatch(/DB migration done/); // worker মাইগ্রেশন চালায় না
      expect(await canConnect(port)).toBe(false);   // কোনো listening socket নেই
      expect(p.child.exitCode).toBeNull();          // keep-alive: প্রসেস বেঁচে আছে
    } finally {
      const r = await terminate(p);
      expect(r.code).toBe(0);
    }
    expect(p.logs()).toMatch(/গ্রেসফুল শাটডাউন সম্পন্ন/);
  });

  test('schema প্রস্তুত না থাকলে worker স্পষ্ট এরর দিয়ে exit(1), কোনো ব্যাকগ্রাউন্ড কাজ শুরু হয় না', async () => {
    const admin = new Pool({ connectionString: BASE_URL, ssl: false });
    const dbName = `role_empty_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const emptyUrl = BASE_URL.replace(/\/[^/?]+(\?.*)?$/, `/${dbName}`);
    const p = boot('worker', 14913, { DATABASE_URL: emptyUrl, WORKER_SCHEMA_WAIT_ATTEMPTS: '1', WORKER_SCHEMA_WAIT_MS: '10' });
    try {
      const r = await Promise.race([p.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('no exit\n' + p.logs())), 30000))]);
      expect(r.code).toBe(1);
      const log = p.logs();
      expect(log).toMatch(/Worker schema not ready/);
      expect(log).not.toMatch(BG.scheduler);
      expect(log).not.toMatch(BG.queueWorker);
    } finally {
      if (p.child.exitCode === null) p.child.kill('SIGKILL');
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
});

describe('Test C — PROCESS_ROLE=all (এবং অনুপস্থিত = পুরনো আচরণ)', () => {
  test.each([['all', 14914], [null, 14915]])('role=%s: HTTP ও ব্যাকগ্রাউন্ড দুটোই চালু', async (role, port) => {
    const p = boot(role, port);
    try {
      await waitForHealth(port);
      await waitForLog(p, BG.scheduler);
      await waitForLog(p, BG.matchSync);
      await waitForLog(p, BG.queueWorker);
      expect(p.logs()).toMatch(/PROCESS_ROLE=all/);
      expect(p.logs()).toMatch(/Server running on port/);
      expect(p.logs()).toMatch(/DB migration done/);
    } finally {
      const r = await terminate(p);
      expect(r.code).toBe(0);
    }
  });
});

describe('Test D — অবৈধ role', () => {
  test('exit(1), স্পষ্ট বার্তা, DB/ব্যাকগ্রাউন্ড কিছুই initialize হয় না', async () => {
    const p = boot('workers', 14916);
    const r = await Promise.race([p.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('no exit')), 20000))]);
    expect(r.code).toBe(1);
    const log = p.logs();
    expect(log).toMatch(/Invalid PROCESS_ROLE "workers"/);
    expect(log).not.toMatch(/PostgreSQL connected/);
    expect(log).not.toMatch(/Server running on port/);
    expect(log).not.toMatch(BG.scheduler);
    expect(await canConnect(14916)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redis/BullMQ — শুধু REDIS_TEST_URL সেট থাকলে চলে (Redis না থাকলে fake success নয়, স্পষ্টভাবে skip)।
// ---------------------------------------------------------------------------
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
(REDIS_TEST_URL ? describe : describe.skip)('Test E — BullMQ producer/consumer বিভাজন ও Redis cleanup (বাস্তব Redis)', () => {
  const IORedis = require('ioredis');
  const redisEnv = { REDIS_ENABLED: 'true', REDIS_URL: REDIS_TEST_URL };

  async function clientCount() {
    const r = new IORedis(REDIS_TEST_URL, { maxRetriesPerRequest: 1 });
    try { return (await r.client('LIST')).split('\n').filter(Boolean).length - 1; } finally { r.disconnect(); }
  }

  test('web: শুধু producer; worker: consumer; দুটোই SIGTERM-এ সব Redis কানেকশন বন্ধ করে', async () => {
    const before = await clientCount();

    const web = boot('web', 14917, redisEnv);
    try {
      await waitForHealth(14917);
      await waitForLog(web, /Queue producers প্রস্তুত/);
      expect(web.logs()).not.toMatch(/Background Queue System চালু হয়েছে/);
    } finally {
      expect((await terminate(web)).code).toBe(0);
    }

    const worker = boot('worker', 14918, redisEnv);
    try {
      await waitForLog(worker, /Background Queue System চালু হয়েছে/);
      expect(worker.logs()).not.toMatch(/Server running on port/);
    } finally {
      expect((await terminate(worker)).code).toBe(0);
    }

    await new Promise((r) => setTimeout(r, 500));
    expect(await clientCount()).toBe(before); // কোনো লিক হওয়া Redis কানেকশন নেই
  });
});
