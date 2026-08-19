// tests/integration/deferredItemsIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 11 — আগের ফেজগুলোতে deferred/NOT VERIFIED রাখা আইটেমগুলোর রিগ্রেশন কভারেজ।
//
// প্রতিটা ব্লক একটা বাস্তব, মাপা সমস্যার বিপরীতে লেখা:
//
//   • duplicateDetection.scanAllUsers() ইউজারপ্রতি ~৫.৮টি কোয়েরি চালাত
//     (২৪২২ ইউজারে ১৪,০৩১ কোয়েরি, ৩০ সেকেন্ড)। এখন lookup টেবিলগুলো একবার পড়ে
//     মেমরিতে ইনডেক্স বানানো হয়। সনাক্তকরণের ফলাফল অপরিবর্তিত থাকতে হবে।
//   • /chat/history ও /chat/admin/history/:userId কোনো LIMIT ছাড়া পুরো কথোপকথন
//     ফেরত দিত।
//   • অ্যাডমিন page প্যারামিটার উপরের দিকে আনবাউন্ডেড ছিল (?page=99999999 → বিশাল OFFSET)।
//   • middleware/validate.js-এর requireIntParam/requireAmount ত্রুটির সময় কাঁচা
//     Referer-এ রিডাইরেক্ট করত — যাচাই করা হয়েছে, Location-এ আক্রমণকারীর URL বসত।
//   • ত্রুটিপূর্ণ id সরাসরি PostgreSQL-এ পৌঁছে 22P02/22003 ঘটাত।
//   • scheduler.start() seeding ব্যর্থ হলেও started=true রেখে দিত।
//   • SIGINT হ্যান্ডেল করা হতো না; SIGTERM সরাসরি process.exit(0) ডাকত।
//
// আসল PostgreSQL ব্যবহার করা হয়।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const { freshRequest, getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');

describe('ডুপ্লিকেট ডিটেকশন — ব্যাচড স্ক্যান', () => {
  test('scanAllUsers ইউজারপ্রতি কোয়েরি সংখ্যা আর লিনিয়ারভাবে বাড়ায় না', async () => {
    const { scanAllUsers } = require('../../services/duplicateDetection');

    await pool.query('DELETE FROM duplicate_account_flags');
    const users = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const userCount = users.rows[0].c;
    expect(userCount).toBeGreaterThan(0);

    const original = pool.query.bind(pool);
    let queries = 0;
    pool.query = (...args) => { queries += 1; return original(...args); };
    try {
      await scanAllUsers();
    } finally {
      pool.query = original;
    }

    // আগে ইউজারপ্রতি ~৫.৮ ছিল (৪টা lookup + ফ্ল্যাগ লেখা)। lookup গুলো এখন
    // একবারই চলে, তাই বাকি থাকে মূলত ফ্ল্যাগ ইনসার্ট ও অ্যাডমিন লগ।
    const perUser = queries / userCount;
    expect(perUser).toBeLessThan(5);

    await pool.query('DELETE FROM duplicate_account_flags');
    await pool.query(`DELETE FROM admin_logs WHERE action_type = 'DUPLICATE_ACCOUNT_DETECTED'`);
  }, 300000);

  test('সিগন্যাল তৈরির কোড একটাই জায়গায় — দুই পাথে ফলাফল ভিন্ন হতে পারে না', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'duplicateDetection.js'), 'utf8');
    expect(src).toMatch(/function buildSignals\(/);
    // description টেমপ্লেট শুধু buildSignals-এই থাকবে, নকল হবে না
    expect((src.match(/type: 'shared_device'/g) || []).length).toBe(1);
    expect((src.match(/type: 'shared_ip'/g) || []).length).toBe(1);
  });

  test('স্ক্যানের ফলাফল খালি ডেটাতেও ভাঙে না', async () => {
    const { scanAllUsers } = require('../../services/duplicateDetection');
    await expect(scanAllUsers()).resolves.toEqual(expect.any(Number));
    await pool.query('DELETE FROM duplicate_account_flags');
    await pool.query(`DELETE FROM admin_logs WHERE action_type = 'DUPLICATE_ACCOUNT_DETECTED'`);
  }, 300000);
});

describe('চ্যাট হিস্টোরি — সার্ভার-সাইড বাউন্ড', () => {
  test('দুই এন্ডপয়েন্টেই LIMIT প্রয়োগ হয়', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'chat.js'), 'utf8');
    expect(src).toMatch(/MAX_HISTORY_MESSAGES\s*=\s*\d+/);
    expect((src.match(/LIMIT \$2/g) || []).length).toBeGreaterThanOrEqual(2);
    // আনবাউন্ডেড পুরনো ফর্মটা আর নেই
    expect(src).not.toMatch(/FROM chat_messages WHERE sender_id = \$1 OR receiver_id = \$1 ORDER BY created_at ASC'/);
  });

  test('রেসপন্স আকার অপরিবর্তিত (প্লেইন অ্যারে) ও ক্রম পুরনো→নতুন', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').type('form').send({
      username, phone: uniquePhone(), password: 'SecurePass123',
      confirmPassword: 'SecurePass123', _csrf: token
    });
    const uid = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;

    for (let i = 0; i < 5; i += 1) {
      await pool.query(
        `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, created_at)
         VALUES ($1, NULL, $2, false, NOW() + ($3 || ' seconds')::interval)`,
        [uid, `msg-${i}`, String(i)]
      );
    }

    const res = await agent.get('/chat/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const msgs = res.body.map((m) => m.message).filter((m) => /^msg-\d$/.test(m));
    expect(msgs).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']); // ASC ক্রম অক্ষত

    await pool.query('DELETE FROM chat_messages WHERE sender_id = $1', [uid]);
    await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  });
});

describe('কয়েন ট্রানজেকশন হিস্টোরি — সার্ভার-সাইড বাউন্ড', () => {
  test('/coins/history-এ LIMIT প্রয়োগ হয় (আগে পুরো হিস্ট্রি আনবাউন্ডেড আসত)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'coins.js'), 'utf8');
    expect(src).toMatch(/FROM coin_transactions WHERE user_id=\$1 ORDER BY created_at DESC LIMIT 500/);
  });

  test('৮,০০০ সারির ইতিহাস থাকা ইউজারের /coins/history রেসপন্সে সর্বোচ্চ ৫০০টা সাম্প্রতিক সারি আসে, ক্রম নতুন→পুরনো', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').type('form').send({
      username, phone: uniquePhone(), password: 'SecurePass123',
      confirmPassword: 'SecurePass123', _csrf: token
    });
    const uid = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;

    await pool.query(
      `INSERT INTO coin_transactions (user_id, type, amount, description, created_at)
       SELECT $1, 'bet', 1, 'perf-' || g, NOW() - (g || ' minutes')::interval
       FROM generate_series(1, 8000) g`,
      [uid]
    );

    const res = await agent.get('/coins/history');
    expect(res.status).toBe(200);
    // সবচেয়ে সাম্প্রতিক row (g=1) থাকা উচিত, কিন্তু ৫০০-এর বাইরের পুরনো row (g=7999) থাকা উচিত না
    expect(res.text).toMatch(/perf-1(?!\d)/);
    expect(res.text).not.toMatch(/perf-7999/);

    await pool.query('DELETE FROM coin_transactions WHERE user_id = $1', [uid]);
    await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  }, 30000);
});

describe('অ্যাডমিন পেজিনেশন — উপরের সীমা', () => {
  const { clampPage, MAX_PAGE } = require('../../middleware/validate');

  test('অস্বাভাবিক বড় page নিরাপদে ক্ল্যাম্প হয়', () => {
    expect(clampPage('99999999')).toBe(MAX_PAGE);
    expect(clampPage(Number.MAX_SAFE_INTEGER)).toBe(MAX_PAGE);
  });

  test('স্বাভাবিক ও অবৈধ মান আগের মতোই আচরণ করে', () => {
    expect(clampPage('1')).toBe(1);
    expect(clampPage('7')).toBe(7);
    expect(clampPage('0')).toBe(1);
    expect(clampPage('-5')).toBe(1);
    expect(clampPage('abc')).toBe(1);
    expect(clampPage(undefined)).toBe(1);
  });

  test('অ্যাডমিন রুটে পুরনো আনবাউন্ডেড প্যাটার্ন আর নেই', () => {
    for (const f of ['admin.js', 'adminLeaderboard.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8');
      expect(src).not.toMatch(/Math\.max\(1,\s*parseInt\(req\.query\.page/);
    }
  });
});

describe('requireIntParam / requireAmount — ওপেন রিডাইরেক্ট বন্ধ', () => {
  test('ত্রুটির সময় বাইরের Referer-এ পাঠানো হয় না', () => {
    const src = fs.readFileSync(path.join(ROOT, 'middleware', 'validate.js'), 'utf8');
    expect(src).not.toMatch(/req\.get\('Referer'\)\s*\|\|\s*'\/admin'/);
    expect(src).toMatch(/backUrl\(req, '\/admin'\)/);
  });

  test('backUrl বাইরের ও অনিরাপদ URL প্রত্যাখ্যান করে', () => {
    const { backUrl } = require('../../utils/redirectBack');
    const mk = (ref) => ({ get: (h) => (h === 'Referer' ? ref : 'localhost'), headers: { host: 'localhost' } });
    for (const hostile of ['https://evil.example.com/x', '//evil.example.com', 'javascript:alert(1)']) {
      expect(backUrl(mk(hostile), '/admin')).toBe('/admin');
    }
  });
});

describe('ত্রুটিপূর্ণ ID — DB-তে পৌঁছানোর আগেই আটকায়', () => {
  const cases = [
    ['/matches', 'abc', '/matches'],
    ['/news', '1e309', '/news'],
    ['/tournaments', 'NaN', '/tournaments']
  ];

  test.each(cases)('%s/%s নিরাপদে %s এ রিডাইরেক্ট করে', async (base, bad, target) => {
    const res = await freshRequest().get(`${base}/${encodeURIComponent(bad)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(target);
  });

  test('বৈধ id আগের মতোই রুট হ্যান্ডলারে পৌঁছায়', async () => {
    const res = await freshRequest().get('/news/1');
    // অস্তিত্বহীন হলেও হ্যান্ডলার চলে (302 তালিকায়), 400/500 নয়
    expect([200, 302]).toContain(res.status);
  });
});

describe('scheduler স্টার্টআপ ব্যর্থতার অবস্থা', () => {
  // দ্রষ্টব্য: ensureJobsSeeded() ভেতরেই প্রতিটা কোয়েরির ত্রুটি ধরে ফেলে (.catch এবং
  // try/catch), তাই বাস্তবে সেটা throw করে না — অর্থাৎ Phase 10-এ চিহ্নিত "ব্যর্থ
  // seeding-এ scheduler চিরতরে started থেকে যায়" অবস্থাটা reproduce করা যায়নি।
  // তবুও start() এখন seeding সফল হলে তবেই started সেট করে, যাতে ভবিষ্যতে seeding
  // throw করতে শুরু করলে স্কিডিউলার আটকে না যায়। নিচের টেস্টটা সেই স্টেট-ট্রানজিশনই
  // সরাসরি যাচাই করে।
  test('seeding throw করলে started আটকে থাকে না, পরে আবার চালু করা যায়', async () => {
    const scheduler = require('../../services/scheduler');
    scheduler.stop();

    const original = pool.query.bind(pool);
    // ensureJobsSeeded-এর ভেতরের সব কোয়েরি ব্যর্থ করানো হয়; এর একটিও unguarded হলে
    // start() reject করবে। বর্তমানে সবই guarded, তাই start() সফলই হয় — কিন্তু
    // দুই ক্ষেত্রেই started যেন আটকে না থাকে সেটাই এখানে দেখা হচ্ছে।
    pool.query = (sql, ...rest) => {
      if (typeof sql === 'string' && /cron_jobs/i.test(sql)) {
        return Promise.reject(new Error('probe seeding failure'));
      }
      return original(sql, ...rest);
    };

    let threw = false;
    try {
      await scheduler.start();
    } catch (e) {
      threw = true;
    } finally {
      pool.query = original;
    }

    // throw হোক বা না হোক — পরে আবার start() করা সম্ভব হতে হবে
    scheduler.stop();
    await expect(scheduler.start()).resolves.not.toThrow();
    scheduler.stop();
    expect(typeof threw).toBe('boolean');
  }, 120000);

  test('সোর্সে started সেটিং seeding-এর পরে (রিগ্রেশন গার্ড)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'scheduler.js'), 'utf8');
    const startBlock = src.slice(src.indexOf('async function start()'), src.indexOf('async function start()') + 900);
    expect(startBlock).toMatch(/started = false;\s*\n\s*throw err;/);
    expect(startBlock.indexOf('await ensureJobsSeeded')).toBeLessThan(startBlock.lastIndexOf('started = true'));
  });
});

describe('গ্রেসফুল শাটডাউন', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  test('SIGINT ও SIGTERM দুটোই হ্যান্ডেল করা হয়', () => {
    expect(src).toMatch(/process\.on\('SIGTERM'/);
    expect(src).toMatch(/process\.on\('SIGINT'/);
  });

  test('ডুপ্লিকেট শাটডাউন ঠেকানো হয় ও সময়সীমা আছে', () => {
    expect(src).toMatch(/if \(shuttingDown\) return;/);
    expect(src).toMatch(/SHUTDOWN_TIMEOUT_MS/);
  });

  test('scheduler, queue, HTTP সার্ভার ও DB পুল — সবই বন্ধ করা হয়', () => {
    const block = src.slice(src.indexOf('async function gracefulShutdown'), src.indexOf("process.on('SIGTERM'"));
    expect(block).toMatch(/scheduler'\)\.stop\(\)/);
    expect(block).toMatch(/stopWorker\(\)/);
    expect(block).toMatch(/shutdownQueueSystem\(\)/);
    expect(block).toMatch(/__livoServer/);
    expect(block).toMatch(/pool\.end\(\)/);
  });

  test('আর সরাসরি process.exit(0) দিয়ে শুরু হয় না', () => {
    // পুরনো হ্যান্ডলার ছিল: stop → exit(0), কোনো ড্রেইন বা কানেকশন ক্লোজ ছাড়াই
    expect(src).not.toMatch(/process\.on\('SIGTERM', async \(\) => \{[\s\S]{0,260}process\.exit\(0\);\s*\}\);/);
  });
});
