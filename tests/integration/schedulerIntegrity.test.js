// tests/integration/schedulerIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 07 — ব্যাকগ্রাউন্ড জব ও শিডিউলার নির্ভরযোগ্যতা।
//
// দুটো বাস্তব বাগ এখানে লক করা হচ্ছে, দুটোই ফিক্সের আগে বাস্তবে reproduce করা হয়েছে:
//
//   ১. services/scheduler.js start() প্রতিটা জব stagger করে রেজিস্টার করে
//      (setTimeout, ৫ সেকেন্ড ব্যবধানে)। ওই টাইমআউটগুলোর হ্যান্ডল কোথাও রাখা হতো না,
//      তাই stagger উইন্ডোর ভেতরে stop() ডাকলে পেন্ডিং টাইমআউটগুলো পরে ফায়ার করে
//      নতুন setInterval তৈরি করত — যেগুলো stop() আর কখনো clear করতে পারত না।
//      মাপা হয়েছিল: stop()-এর পরেও ২টা ইন্টারভাল তৈরি হয়েছিল।
//
//   ২. runJob()-এ কোনো ওভারল্যাপ গার্ড ছিল না। হ্যান্ডলার ইন্টারভালের চেয়ে বেশি সময়
//      নিলে, বা অ্যাডমিন ম্যানুয়ালি ট্রিগার করলে শিডিউলড রানের সাথে, একই জব একসাথে
//      দুইবার চলত। মাপা হয়েছিল: max concurrent = 2।
//
// আসল PostgreSQL ব্যবহার করা হয়, কোনো fake DB নয়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const scheduler = require('../../services/scheduler');

const JOB = 'system_health_check';

afterEach(() => {
  scheduler.stop();
});

describe('ডুপ্লিকেট শিডিউলার রেজিস্ট্রেশন', () => {
  test('stagger উইন্ডোর ভেতরে stop() করলে কোনো orphan ইন্টারভাল থাকে না', async () => {
    const realSetInterval = global.setInterval;
    let created = 0;
    global.setInterval = (...args) => { created += 1; return realSetInterval(...args); };

    try {
      await scheduler.start();
      scheduler.stop(); // stagger টাইমআউটগুলো তখনো পেন্ডিং
      await new Promise((r) => realSetInterval.constructor === Function
        ? setTimeout(r, 6000) : setTimeout(r, 6000));
    } finally {
      global.setInterval = realSetInterval;
    }

    expect(created).toBe(0);
  }, 30000);

  test('start() দুইবার ডাকলে জবপ্রতি একটাই ইন্টারভাল তৈরি হয়', async () => {
    // প্রথম start()-এর stagger টাইমআউটগুলো ৫ সেকেন্ড ব্যবধানে ফায়ার করে, তাই সব
    // রেজিস্ট্রেশন শেষ হতে (জব সংখ্যা × ৫ সেকেন্ড) সময় লাগে। পুরো উইন্ডোটা মেপে
    // নিশ্চিত করা হচ্ছে যে দুইবার start() ডাকলেও মোট ইন্টারভাল দ্বিগুণ হয় না।
    const jobCount = Object.keys(scheduler.JOB_DEFINITIONS).length;
    const realSetInterval = global.setInterval;
    let created = 0;
    global.setInterval = (...args) => { created += 1; return realSetInterval(...args); };

    try {
      await scheduler.start();
      await scheduler.start(); // started গার্ডে আটকানো উচিত
      await new Promise((r) => setTimeout(r, jobCount * 5000 + 4000));
    } finally {
      global.setInterval = realSetInterval;
    }

    expect(created).toBe(jobCount); // ২ × jobCount হলে ডুপ্লিকেট রেজিস্ট্রেশন
  }, 120000);

  test('stop() পরে আবার start() করা যায় (হ্যান্ডল আটকে থাকে না)', async () => {
    await scheduler.start();
    scheduler.stop();
    await expect(scheduler.start()).resolves.not.toThrow();
  }, 30000);
});

describe('একই জবের ওভারল্যাপিং রান', () => {
  let originalHandler;

  beforeAll(() => {
    originalHandler = scheduler.JOB_DEFINITIONS[JOB].handler;
  });

  afterAll(() => {
    scheduler.JOB_DEFINITIONS[JOB].handler = originalHandler;
  });

  test('চলমান জব থাকা অবস্থায় দ্বিতীয় ট্রিগার স্কিপ হয়', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    scheduler.JOB_DEFINITIONS[JOB].handler = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 700));
      concurrent -= 1;
      return 'probe';
    };

    const results = await Promise.all([
      scheduler.runJob(JOB, { triggeredBy: 'manual' }),
      scheduler.runJob(JOB, { triggeredBy: 'schedule' })
    ]);

    expect(maxConcurrent).toBe(1);
    expect(results.filter((r) => r && r.skipped).length).toBe(1);
  }, 30000);

  test('স্কিপ নীরবে হারিয়ে যায় না — cron_job_logs-এ রেকর্ড থাকে', async () => {
    scheduler.JOB_DEFINITIONS[JOB].handler = async () => {
      await new Promise((r) => setTimeout(r, 700));
      return 'probe';
    };

    const before = await pool.query(
      `SELECT COUNT(*)::int AS c FROM cron_job_logs WHERE job_key = $1 AND status = 'skipped'`, [JOB]
    );

    await Promise.all([
      scheduler.runJob(JOB, { triggeredBy: 'manual' }),
      scheduler.runJob(JOB, { triggeredBy: 'schedule' })
    ]);

    const after = await pool.query(
      `SELECT COUNT(*)::int AS c FROM cron_job_logs WHERE job_key = $1 AND status = 'skipped'`, [JOB]
    );
    expect(after.rows[0].c).toBe(before.rows[0].c + 1);
  }, 30000);

  test('জব শেষ হলে গার্ড ছেড়ে দেয় — পরের রান স্বাভাবিকভাবে চলে', async () => {
    scheduler.JOB_DEFINITIONS[JOB].handler = async () => 'probe';

    const first = await scheduler.runJob(JOB, { triggeredBy: 'manual' });
    const second = await scheduler.runJob(JOB, { triggeredBy: 'manual' });

    expect(first && first.skipped).toBeFalsy();
    expect(second && second.skipped).toBeFalsy();
  }, 30000);

  test('হ্যান্ডলার থ্রো করলেও গার্ড আটকে থাকে না', async () => {
    scheduler.JOB_DEFINITIONS[JOB].handler = async () => { throw new Error('probe failure'); };
    await scheduler.runJob(JOB, { triggeredBy: 'manual' });

    // ব্যর্থতার পরেও পরের রান স্কিপ হওয়া চলবে না
    scheduler.JOB_DEFINITIONS[JOB].handler = async () => 'recovered';
    const next = await scheduler.runJob(JOB, { triggeredBy: 'manual' });
    expect(next && next.skipped).toBeFalsy();
  }, 60000);

  test('ব্যর্থ জব cron_job_logs-এ error হিসেবে লেখা হয় (নীরবে গেলা হয় না)', async () => {
    scheduler.JOB_DEFINITIONS[JOB].handler = async () => { throw new Error('probe visible failure'); };
    await scheduler.runJob(JOB, { triggeredBy: 'manual' });

    const r = await pool.query(
      `SELECT status, message FROM cron_job_logs WHERE job_key = $1 ORDER BY id DESC LIMIT 1`, [JOB]
    );
    expect(r.rows[0].status).toBe('error');
    expect(r.rows[0].message).toMatch(/probe visible failure/);
  }, 60000);
});

describe('অন্যান্য শিডিউলারের গার্ড অক্ষত', () => {
  test('queue worker টাইমার সংরক্ষিত ও থামানো যায়', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'queue.js'), 'utf8');
    expect(src).toMatch(/if \(state\.running\) return/);
    expect(src).toMatch(/state\.timer = setInterval/);
    expect(src).toMatch(/function stopWorker/);
    // একাধিক ইনস্ট্যান্সে একই জব দুবার নেওয়া ঠেকাতে row lock
    expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  test('ব্যাকআপ শিডিউলার দুটোই গার্ডেড ও unref করা', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..');
    const backup = fs.readFileSync(path.join(root, 'services', 'backup.js'), 'utf8');
    const manager = fs.readFileSync(path.join(root, 'services', 'backupManager.js'), 'utf8');
    expect(backup).toMatch(/if \(dailyBackupHandle\) return/);
    expect(backup).toMatch(/dailyBackupHandle\.unref/);
    expect(manager).toMatch(/if \(scheduleHandle\) return/);
    expect(manager).toMatch(/scheduleHandle\.unref/);
  });

  // Phase 11-এ শাটডাউন লজিক ইনলাইন SIGTERM হ্যান্ডলার থেকে সরিয়ে gracefulShutdown()-এ
  // নেওয়া হয়েছে (SIGINT-ও যোগ হয়েছে), তাই এখন ওই ফাংশনের ভেতরটাই যাচাই করা হয়।
  test('শাটডাউন পাথ worker, queue ও scheduler থামায়', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
    const block = src.slice(src.indexOf('async function gracefulShutdown'), src.indexOf("process.on('SIGTERM'"));
    expect(block).toMatch(/stopWorker/);
    expect(block).toMatch(/shutdownQueueSystem/);
    expect(block).toMatch(/scheduler'\)\.stop\(\)/);
    expect(src).toMatch(/process\.on\('SIGTERM'/);
    expect(src).toMatch(/process\.on\('SIGINT'/);
  });
});
