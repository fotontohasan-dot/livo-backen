// tests/integration/gracefulShutdownProcess.test.js
// ---------------------------------------------------------------------------
// PHASE 12 — গ্রেসফুল শাটডাউন বাস্তব প্রসেসে যাচাই (Docker daemon এই এনভায়রনমেন্টে
// উপলব্ধ নয়, তাই সরাসরি `node app.js`-কে একটা real child process হিসেবে বুট করে,
// আসল PostgreSQL-এর বিপরীতে, তারপর সত্যিকার SIGTERM/SIGINT পাঠিয়ে exit code ও
// সময়সীমা যাচাই করা হয়। এটা tests/integration/deferredItemsIntegrity.test.js-এর
// সোর্স-লেভেল assertion-গুলোর চেয়ে শক্তিশালী — কারণ এখানে সত্যিই server.listen(),
// scheduler.start() ও queue worker চালু হয়ে থাকা অবস্থায় শাটডাউন হচ্ছে।
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');

function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: 'localhost', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('server did not become healthy in time'));
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

function bootApp(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'app.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/livo_test',
      DATABASE_SSL: 'false',
      SESSION_SECRET: 'graceful_shutdown_test_secret_key_long_enough',
      REDIS_ENABLED: 'false',
      SSLCZ_IS_LIVE: 'false',
      VAPID_SUBJECT: 'mailto:test@example.com',
      FRONTEND_URL: 'http://localhost:4123'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit within ' + timeoutMs + 'ms')), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('গ্রেসফুল শাটডাউন — বাস্তব child process', () => {
  test('SIGTERM: সার্ভার দ্রুত (১০ সেকেন্ড ব্যাকস্টপের অনেক আগে) exit code 0 দিয়ে বন্ধ হয়', async () => {
    const port = 14801;
    const { child, getStdout, getStderr } = bootApp(port);
    try {
      await waitForHealth(port);

      const t0 = Date.now();
      child.kill('SIGTERM');
      const { code, signal } = await waitForExit(child, 10000); // ১০.৫s ব্যাকস্টপের নিচে হওয়া উচিত
      const elapsed = Date.now() - t0;

      expect(code).toBe(0);
      expect(signal).toBeNull();
      expect(elapsed).toBeLessThan(9500); // ব্যাকস্টপের (১০s) আগেই স্বাভাবিকভাবে শেষ হওয়া উচিত
      expect(getStdout()).toMatch(/গ্রেসফুল শাটডাউন সম্পন্ন/);
      expect(getStderr()).not.toMatch(/শাটডাউন সময়সীমা পেরিয়েছে/); // ব্যাকস্টপ ট্রিগার হয়নি
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  }, 40000);

  test('SIGINT: একইভাবে exit code 0 দিয়ে বন্ধ হয়', async () => {
    const port = 14802;
    const { child, getStdout } = bootApp(port);
    try {
      await waitForHealth(port);
      child.kill('SIGINT');
      const { code, signal } = await waitForExit(child, 10000);
      expect(code).toBe(0);
      expect(signal).toBeNull();
      expect(getStdout()).toMatch(/গ্রেসফুল শাটডাউন সম্পন্ন/);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  }, 40000);

  test('একই প্রসেসে দুইবার সিগন্যাল (SIGTERM + SIGINT) পাঠালেও একবারই শাটডাউন চলে, ক্র্যাশ করে না', async () => {
    const port = 14803;
    const { child, getStdout } = bootApp(port);
    try {
      await waitForHealth(port);
      child.kill('SIGTERM');
      child.kill('SIGINT'); // প্রায় সাথে সাথেই দ্বিতীয় সিগন্যাল — ডুপ্লিকেট শাটডাউন গার্ড পরীক্ষা
      const { code } = await waitForExit(child, 10000);
      expect(code).toBe(0);
      // "গ্রেসফুল শাটডাউন শুরু" লগ ঠিক একবারই আসা উচিত (দ্বিতীয় সিগন্যাল নীরবে উপেক্ষিত)
      const startCount = (getStdout().match(/গ্রেসফুল শাটডাউন শুরু/g) || []).length;
      expect(startCount).toBe(1);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  }, 40000);
});
