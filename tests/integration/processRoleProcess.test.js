// tests/integration/processRoleProcess.test.js
// ---------------------------------------------------------------------------
// Task 2 — PROCESS_ROLE (all | web | worker) বাস্তব child process-এ যাচাই।
// `node server.js` আসল PostgreSQL-এর বিপরীতে বুট হয় (test DB — প্রোডাকশন নয়),
// তারপর সত্যিকার SIGTERM পাঠানো হয়। Redis-নির্ভর অংশ চলে শুধু TEST_REDIS_URL সেট থাকলে;
// না থাকলে সেই test স্পষ্টভাবে skip দেখায় (fake pass নয়)।
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const BASE_DB = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/bet420_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL || '';

function boot(role, port, extraEnv = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DATABASE_URL: BASE_DB,
    DATABASE_SSL: 'false',
    SESSION_SECRET: 'process_role_test_secret_key_long_enough',
    REDIS_ENABLED: 'false',
    REDIS_URL: '',
    SSLCZ_IS_LIVE: 'false',
    VAPID_SUBJECT: 'mailto:test@example.com',
    FRONTEND_URL: 'http://localhost:4123',
    // কোনো জব/হিটবিট টেস্ট চলাকালীন আসল কাজ ধরে না (প্রথম poll ১০ মিনিট পরে)
    QUEUE_POLL_INTERVAL_MS: '600000',
    ...extraEnv,
  };
  if (role !== null) env.PROCESS_ROLE = role; else delete env.PROCESS_ROLE;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => out, stderr: () => err, exited };
}

function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function get(port, p, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const count = (s, re) => (s.match(re) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKGROUND_MARKERS = /Scheduler চালু হয়েছে|\[queue\] worker started|Syncing real matches|Background Queue System চালু হয়েছে|\[worker\]/;

async function terminate(proc, signal = 'SIGTERM', limitMs = 20000) {
  const t0 = Date.now();
  proc.child.kill(signal);
  const res = await Promise.race([
    proc.exited,
    sleep(limitMs).then(() => { proc.child.kill('SIGKILL'); throw new Error('process did not exit in time'); }),
  ]);
  return { ...res, elapsed: Date.now() - t0 };
}

describe('Test D — অবৈধ PROCESS_ROLE', () => {
  test.each(['bogus', ''])('PROCESS_ROLE=%p → exit 1, পরিষ্কার error, কোনো service চালু হয় না', async (bad) => {
    const p = boot(bad, 14820);
    const { code } = await Promise.race([p.exited, sleep(15000).then(() => { p.child.kill('SIGKILL'); throw new Error('hung'); })]);
    expect(code).toBe(1);
    expect(p.stderr()).toMatch(/অবৈধ PROCESS_ROLE/);
    expect(p.stdout()).not.toMatch(/PostgreSQL connected/);
    expect(p.stdout() + p.stderr()).not.toMatch(BACKGROUND_MARKERS);
    await expect(get(14820, '/health')).rejects.toBeDefined();
  }, 30000);
});

describe('Test A — PROCESS_ROLE=web', () => {
  test('HTTP + Express + Socket.IO চালু; কোনো scheduler/queue consumer/match sync/backup timer নয়; SIGTERM-এ পরিষ্কার বন্ধ', async () => {
    const p = boot('web', 14821);
    try {
      await waitFor(() => /Server running on port/.test(p.stdout()), 40000, 'web listen');
      expect((await get(14821, '/health')).status).toBe(200);
      const io = await get(14821, '/socket.io/?EIO=4&transport=polling');
      expect(io.status).toBe(200);
      expect(io.body).toMatch(/^0\{.*"sid"/); // Socket.IO handshake
      await sleep(4500); // all role-এর পুরোনো ৩s বিলম্বের পরেও কিছু চালু হওয়া চলবে না
      expect(p.stdout()).toMatch(/PROCESS_ROLE=web/);
      expect(p.stdout() + p.stderr()).not.toMatch(BACKGROUND_MARKERS);

      const { code, elapsed } = await terminate(p, 'SIGTERM', 10000);
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(9500);
      expect(p.stdout()).toMatch(/গ্রেসফুল শাটডাউন সম্পন্ন/);
      expect(p.stderr()).not.toMatch(/শাটডাউন সময়সীমা পেরিয়েছে/);
    } finally { p.child.kill('SIGKILL'); }
  }, 90000);
});

describe('Test B + E — PROCESS_ROLE=worker', () => {
  test('background runtime চালু; কোনো HTTP listener নেই; SIGTERM+SIGINT-এ একবারই পরিষ্কার shutdown', async () => {
    const p = boot('worker', 14822);
    try {
      await waitFor(() => /Worker process running/.test(p.stdout()), 40000, 'worker start');
      const out = p.stdout();
      expect(out).toMatch(/PROCESS_ROLE=worker/);
      for (const name of ['pgQueueConsumer', 'bullmqConsumers', 'scheduler', 'matchSync', 'casinoBootSync', 'dailyBackup', 'autoBackup']) {
        expect(out).toContain(`[worker] ✅ ${name} চালু`);
      }
      expect(out).toMatch(/Scheduler চালু হয়েছে/);
      expect(out).toMatch(/\[queue\] worker started/);
      expect(out).not.toMatch(/Server running on port/);
      expect(out).not.toMatch(/PostgreSQL migration|DB migration done/); // worker migration চালায় না
      await expect(get(14822, '/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' }); // HTTP/Socket.IO নেই

      p.child.kill('SIGTERM');
      p.child.kill('SIGINT'); // ডুপ্লিকেট সিগন্যাল
      const t0 = Date.now();
      const { code } = await Promise.race([p.exited, sleep(25000).then(() => { throw new Error('no exit'); })]);
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(20000);
      const after = p.stdout();
      expect(count(after, /গ্রেসফুল শাটডাউন শুরু/g)).toBe(1);
      expect(count(after, /Scheduler বন্ধ করা হয়েছে/g)).toBe(1); // duplicate cleanup নেই
      expect(after).toMatch(/গ্রেসফুল শাটডাউন সম্পন্ন/);
      expect(p.stderr()).not.toMatch(/শাটডাউন সময়সীমা পেরিয়েছে/);
    } finally { p.child.kill('SIGKILL'); }
  }, 90000);

  describe('worker startup failure', () => {
    const adminUrl = BASE_DB.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
    const emptyName = `bet420_worker_empty_${process.pid}`;
    const emptyUrl = BASE_DB.replace(/\/[^/?]+(\?|$)/, `/${emptyName}$1`);
    let admin;

    beforeAll(async () => {
      admin = new Pool({ connectionString: adminUrl });
      await admin.query(`CREATE DATABASE ${emptyName}`);
    });
    afterAll(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${emptyName} WITH (FORCE)`);
      await admin.end();
    });

    test('schema প্রস্তুত না থাকলে fail-closed (exit 1), runtime চালু হয় না, কোনো migration চলে না', async () => {
      const p = boot('worker', 14823, { DATABASE_URL: emptyUrl, WORKER_SCHEMA_WAIT_MS: '1500' });
      const { code } = await Promise.race([p.exited, sleep(30000).then(() => { p.child.kill('SIGKILL'); throw new Error('hung'); })]);
      expect(code).toBe(1);
      expect(p.stderr()).toMatch(/worker schema প্রস্তুত নয়/);
      expect(p.stdout()).not.toMatch(/Worker process running/);
      expect(p.stdout() + p.stderr()).not.toMatch(/Scheduler চালু হয়েছে|\[queue\] worker started|Background Queue System চালু হয়েছে|\[worker\] ✅/);
      const probe = new Pool({ connectionString: emptyUrl });
      try {
        const r = await probe.query("SELECT to_regclass('public.users') AS t");
        expect(r.rows[0].t).toBeNull(); // worker migration চালায়নি
      } finally { await probe.end(); }
    }, 60000);
  });
});

describe('Test C — PROCESS_ROLE=all (এবং সেট না থাকলে) পুরোনো আচরণ', () => {
  test.each([['all', 14824], [null, 14825]])('role=%p: HTTP + background দুটোই একই প্রসেসে; SIGTERM-এ exit 0', async (role, port) => {
    const p = boot(role, port);
    try {
      await waitFor(() => /Server running on port/.test(p.stdout()), 40000, 'listen');
      expect((await get(port, '/health')).status).toBe(200);
      await waitFor(() => /Scheduler চালু হয়েছে/.test(p.stdout()) && /\[queue\] worker started/.test(p.stdout()), 15000, 'background');
      expect(p.stdout()).toMatch(/PROCESS_ROLE=all/);
      expect(p.stdout()).not.toMatch(/\[worker\]/); // পুরোনো পথ, নতুন runtime নয়
      const { code } = await terminate(p, 'SIGTERM', 10000);
      expect(code).toBe(0);
      expect(count(p.stdout(), /Scheduler বন্ধ করা হয়েছে/g)).toBe(1);
      expect(p.stdout()).toMatch(/গ্রেসফুল শাটডাউন সম্পন্ন/);
    } finally { p.child.kill('SIGKILL'); }
  }, 90000);
});

(TEST_REDIS_URL ? describe : describe.skip)('Redis/BullMQ role ভাগ (TEST_REDIS_URL প্রয়োজন)', () => {
  test('web: শুধু producer সংযোগ, কোনো BullMQ consumer নয়', async () => {
    const p = boot('web', 14826, { REDIS_URL: TEST_REDIS_URL });
    try {
      await waitFor(() => /Redis \(Queue System\) connected/.test(p.stdout()), 40000, 'web redis');
      await sleep(4500);
      expect(p.stdout()).not.toMatch(/Background Queue System চালু হয়েছে/);
      const { code } = await terminate(p, 'SIGTERM', 10000);
      expect(code).toBe(0);
      expect(p.stderr()).not.toMatch(/শাটডাউন সময়সীমা পেরিয়েছে/);
    } finally { p.child.kill('SIGKILL'); }
  }, 90000);

  test('worker: BullMQ consumers চালু হয়; SIGTERM-এ workers ও Redis বন্ধ হয়ে exit 0', async () => {
    const p = boot('worker', 14827, { REDIS_URL: TEST_REDIS_URL });
    try {
      await waitFor(() => /Worker process running/.test(p.stdout()), 40000, 'worker start');
      expect(p.stdout()).toMatch(/Background Queue System চালু হয়েছে/);
      const { code, elapsed } = await terminate(p, 'SIGTERM', 25000);
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(20000);
      expect(p.stderr()).not.toMatch(/শাটডাউন সময়সীমা পেরিয়েছে/);
    } finally { p.child.kill('SIGKILL'); }
  }, 90000);
});
