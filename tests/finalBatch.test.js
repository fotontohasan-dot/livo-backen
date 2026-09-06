const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('#37/#38 কিউ ডুপ্লিকেট ও রিট্রাই', () => {
  const queue = codeOnly(read('services', 'queue.js'));

  test('ম্যানুয়াল রিট্রাই attempts শূন্যে নামায়', () => {
    // আগে attempts আগের মতোই থাকত, আর জব failed হয় attempts >= max_attempts
    // হলে — তাই রিট্রাই করা জব পরের রানেই আবার সঙ্গে সঙ্গে ব্যর্থ হতো।
    expect(queue).toMatch(/status = 'pending'[\s\S]{0,160}attempts = 0/);
  });

  test('retryAllFailed-ও attempts রিসেট করে', () => {
    expect(queue).toMatch(/retryAllFailed[\s\S]{0,600}attempts = 0/);
  });

  test('জব ধরার সময় worker_id বসে', () => {
    expect(queue).toMatch(/worker_id = \$2/);
    expect(queue).toMatch(/const WORKER_ID/);
  });

  test('চলমান জব heartbeat দিয়ে started_at তাজা রাখে', () => {
    expect(queue).toMatch(/function startHeartbeat/);
    expect(queue).toMatch(/clearInterval\(heartbeat\)/);
  });

  test('worker_id কলাম মাইগ্রেশনে আছে', () => {
    expect(read('migrations.js')).toMatch(/job_queue ADD COLUMN IF NOT EXISTS worker_id/);
  });

  test('দুই কিউ সিস্টেমের সীমানা ডকুমেন্টেড', () => {
    const doc = read('docs', 'QUEUES.md');
    expect(doc).toMatch(/services\/queue\.js/);
    expect(doc).toMatch(/BullMQ/);
  });
});

describe('#29/#30 রিস্টোরে আর্থিক সারি হারানো চলে না', () => {
  const manager = codeOnly(read('services', 'backupManager.js'));

  test('আর্থিক টেবিলে সারি বাদ পড়লে রিস্টোর ব্যর্থ হয়', () => {
    expect(manager).toMatch(/FINANCIAL_TABLES/);
    expect(manager).toMatch(/coin_transactions/);
    expect(manager).toMatch(/throw err/);
  });

  test('আংশিক রিস্টোর সচেতন অপ্ট-ইন লাগে', () => {
    expect(manager).toMatch(/BACKUP_ALLOW_PARTIAL_RESTORE/);
  });

  test('ব্যর্থ রিস্টোর restored_at সেট করে না', () => {
    const idx = manager.indexOf('FINANCIAL_TABLES');
    const after = manager.slice(idx);
    // throw আগে, restored_at আপডেট পরে
    expect(after.indexOf('throw err')).toBeLessThan(after.indexOf('restored_at = NOW()'));
  });
});

describe('#33 অ্যাডমিনের মিশন কনফিগ স্টার্টআপে মুছে যায় না', () => {
  const migrations = codeOnly(read('migrations.js'));

  test('mission_defs আর DELETE করা হয় না', () => {
    expect(migrations).not.toMatch(/DELETE FROM mission_defs/);
  });

  test('টেবিল খালি থাকলেই কেবল সিড হয়', () => {
    expect(migrations).toMatch(/dailyCount[\s\S]{0,200}=== 0/);
  });
});

describe('#3 KYC ডকুমেন্ট প্রমাণীকৃত প্রক্সি দিয়ে আসে', () => {
  const admin = codeOnly(read('routes', 'admin.js'));

  test('প্রক্সি রুট আছে ও পারমিশন লাগে', () => {
    expect(admin).toMatch(/router\.get\('\/kyc\/:id\/document', rbac\.requirePermission\('kyc_view'\)/);
  });

  test('SSRF ঠেকাতে URL যাচাই হয়', () => {
    expect(admin).toMatch(/res\.cloudinary\.com/);
    expect(admin).toMatch(/CLOUDINARY_CLOUD_NAME/);
  });

  test('প্রতিটা দেখা অডিট লগে যায়', () => {
    expect(admin).toMatch(/KYC_DOCUMENT_VIEWED/);
  });

  test('ব্যক্তিগত ডকুমেন্ট ক্যাশ হয় না', () => {
    expect(admin).toMatch(/no-store, private/);
    expect(admin).toMatch(/Referrer-Policy/);
  });

  test('অ্যাডমিন ভিউ আসল Cloudinary URL বসায় না', () => {
    const view = read('views', 'admin', 'kyc.ejs');
    // CSP মাইগ্রেশনে স্ক্রিপ্টটা public/js/admin-kyc.js-এ সরানো হয়েছে,
    // তাই docProxyUrl এখন ওখানে। সম্পত্তিটা একই: ডকুমেন্ট প্রমাণীকৃত
    // প্রক্সি রুট দিয়েই আসে।
    const js = read('public', 'js', 'admin-kyc.js');
    expect(js).toMatch(/docProxyUrl/);
    expect(js).toMatch(/'\/admin\/kyc\/' \+ encodeURIComponent\(k\.id\) \+ '\/document'/);
    expect(view).not.toMatch(/hostname !== 'res\.cloudinary\.com'/);
  });

  test('আসল document_url ব্রাউজারে পাঠানোই হয় না', () => {
    const view = read('views', 'admin', 'kyc.ejs');
    // আগে `onclick='viewKyc(<%- jsonScriptSafe(k) %>)'` গোটা সারিটা পাঠাত —
    // SELECT k.* মানে document_url সহ, অর্থাৎ Cloudinary ঠিকানা প্রতিটা
    // অ্যাডমিন পেজলোডে HTML-এ বসত। এখন শুধু has_document boolean যায়।
    expect(view).toMatch(/has_document: !!k\.document_url/);
    expect(view).not.toMatch(/jsonScriptSafe\(kycList/);
    const js = read('public', 'js', 'admin-kyc.js');
    expect(js).toMatch(/k\.has_document/);
    expect(js).not.toMatch(/k\.document_url/);
  });

  test('অবশিষ্ট ঝুঁকি ডকুমেন্টেড', () => {
    const doc = read('docs', 'KYC_STORAGE.md');
    expect(doc).toMatch(/এখনো পাবলিক/);
    expect(doc).toMatch(/authenticated/);
  });
});

describe('#45 CSP কড়াকড়ির পথ', () => {
  const app = codeOnly(read('app.js'));

  test('Report-Only নীতিতে unsafe-inline নেই', () => {
    expect(app).toMatch(/reportOnlyDirectives/);
    expect(app).toMatch(/reportOnly: true/);
    expect(app).toMatch(/scriptSrcAttr: \["'none'"\]/);
  });

  test('লঙ্ঘন রিপোর্ট গ্রহণের রুট আছে', () => {
    expect(app).toMatch(/\/csp-report/);
  });

  test('প্রয়োগ করা নীতি অক্ষত (সাইট ভাঙেনি)', () => {
    expect(app).toMatch(/contentSecurityPolicy: \{ directives: cspDirectives \}/);
  });

  test('ধাপগুলো ডকুমেন্টেড', () => {
    expect(read('docs', 'CSP.md')).toMatch(/nonce/);
  });
});

describe('#41 টুর্নামেন্ট জয়েনের নিয়ম সার্ভারে যাচাই হয়', () => {
  const t = codeOnly(read('routes', 'tournaments.js'));

  test('শেষ/বাতিল টুর্নামেন্টে জয়েন করা যায় না', () => {
    expect(t).toMatch(/status === 'completed'/);
    expect(t).toMatch(/status === 'cancelled'/);
  });

  test('সময়সীমা যাচাই হয়', () => {
    expect(t).toMatch(/end_date/);
    expect(t).toMatch(/start_date/);
  });

  test('অংশগ্রহণকারীর সীমা লক নিয়ে যাচাই হয়', () => {
    expect(t).toMatch(/FOR UPDATE/);
    expect(t).toMatch(/max_participants/);
  });

  test('বার্তাগুলো দুই ভাষাতেই আছে', () => {
    for (const f of ['bn.json', 'en.json']) {
      const d = JSON.parse(read('locales', f));
      expect(d.tournaments_closed).toBeTruthy();
      expect(d.tournaments_already_started).toBeTruthy();
      expect(d.tournaments_full).toBeTruthy();
    }
  });
});

describe('#7 Telegram বট সরাসরি প্রোডাকশনে লিখতে পারে না', () => {
  const bot = codeOnly(read('telegram-bot.js'));

  test('লেখা আলাদা ব্রাঞ্চে যায়', () => {
    expect(bot).toMatch(/GITHUB_BOT_BRANCH/);
    expect(bot).toMatch(/branch: BOT_BRANCH/);
  });

  test('সুরক্ষিত ব্রাঞ্চে লেখা আটকানো', () => {
    expect(bot).toMatch(/PROTECTED_BRANCHES/);
    expect(bot).toMatch(/'main', 'master', 'production'/);
  });

  test('PR ছাড়া লাইভ হয় না — বার্তায় স্পষ্ট', () => {
    expect(bot).toMatch(/prUrl/);
    expect(bot).not.toMatch(/Render এ deploy হচ্ছে/);
  });
});

describe('#47 ফ্রি বেট ডুপ্লিকেট DB-তেই আটকানো', () => {
  test('partial unique index আছে', () => {
    expect(read('migrations.js')).toMatch(/uniq_free_bet_user_reason/);
  });

  test('conflict হলে দ্বিতীয় নোটিফিকেশন যায় না', () => {
    const fb = codeOnly(read('services', 'freebet.js'));
    expect(fb).toMatch(/ON CONFLICT DO NOTHING RETURNING id/);
    expect(fb).toMatch(/rowCount === 0\) return/);
  });
});

describe('#46/#48 সোশ্যাল রিওয়ার্ড সৎভাবে উপস্থাপিত', () => {
  const social = read('services', 'social.js');

  test('শেয়ার যাচাইয়ের দাবি করা হয় না', () => {
    expect(social).toMatch(/শেয়ার যাচাই করা হয় না|যাচাই করা হয় না/);
  });

  test('দিনের সংজ্ঞা কেন্দ্রীয় টাইমজোন থেকে', () => {
    expect(codeOnly(social)).toMatch(/businessToday/);
    expect(codeOnly(social)).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
  });
});
