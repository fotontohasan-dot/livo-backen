const fs = require('fs');
const path = require('path');
const { freshRequest } = require('../helpers/app');

// ==================== Phase 22: রিলিজ গেট ====================
//
// roadmap-এর চূড়ান্ত গেটটা এতদিন কেবল একটা ডকুমেন্ট ছিল। কোনো একক কমান্ড
// ছিল না যা বলতে পারে "এই কমিট রিলিজযোগ্য কি না" — রিলিজের আগে ৬০+ সুট
// পড়ে মিলিয়ে দেখতে হত, আর মানুষ সেটা করে না।
//
// এই ফাইলটা সেই একক গেট:
//
//     npx cross-env NODE_ENV=test npx jest tests/security/releaseGate
//
// এটা **ডুপ্লিকেট নয়**। প্রতিটা দাবির বিস্তারিত যাচাই (edge case, mutation,
// একাধিক মোড) নিজের নিজের সুটে আছে — এখানে শুধু ফলাফলটা এক জায়গায় দেখা
// হয়। প্রতিটা assertion-এর পাশে কোথায় বিস্তারিত আছে তা লেখা।
//
// দুটো নিয়ম মানা হয়েছে:
//   ১. যেখানে রানটাইমে দেখা সম্ভব, সেখানে সোর্স-grep নয় — আসল রেসপন্স।
//      সোর্সে গার্ড থাকা আর গার্ড কাজ করা এক জিনিস নয়।
//   ২. প্রতিটা sweep-এর আগে "স্ক্যান কাজ করছে" assertion। ফাইল তালিকা
//      খালি হয়ে গেলে sweep নিরর্থকভাবে সবুজ থাকত — এই ফাঁদে আগে পড়া
//      হয়েছে।

const ROOT = path.join(__dirname, '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function walkTemplates(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTemplates(full, out);
    else if (['.ejs', '.html'].includes(path.extname(e.name))) out.push(full);
  }
  return out;
}

const JS_SOURCES = ['routes', 'services', 'middleware', 'utils', 'queues']
  .filter((d) => fs.existsSync(path.join(ROOT, d)))
  .flatMap((d) => walkJs(path.join(ROOT, d)))
  .concat(['app.js', 'server.js', 'telegram-bot.js']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f)));

const TEMPLATES = ['views', 'public'].flatMap((d) => walkTemplates(path.join(ROOT, d)));

const rel = (f) => path.relative(ROOT, f);

// ---------------------------------------------------------------------------

describe('রিলিজ গেট — স্ক্যানের ভিত্তি', () => {
  // এই describe-টা বাকি সবগুলোর পূর্বশর্ত। এখানে ফেল করলে নিচের ফলাফল
  // পড়ার কোনো মানে নেই — sweep গুলো তখন খালি সেটের উপর চলছে।
  test('JS সোর্স তালিকা তৈরি হয়েছে', () => {
    expect(JS_SOURCES.length).toBeGreaterThan(20);
  });

  test('টেমপ্লেট তালিকা তৈরি হয়েছে', () => {
    expect(TEMPLATES.length).toBeGreaterThan(20);
  });
});

describe('রিলিজ গেট ১ — CSP: script-src ও script-src-attr কড়া', () => {
  // বিস্তারিত: tests/security/cspInlineRatchet.test.js (nonce অবকাঠামো,
  // র‍্যাচেটের ইতিহাস), tests/security/uiIntegrity.test.js
  let csp;

  beforeAll(async () => {
    const res = await freshRequest().get('/');
    // পেজটা সত্যিই রেন্ডার হয়েছে কি না — নাহলে হেডার কোন নীতির তা অজানা
    expect(res.status).toBeLessThan(400);
    csp = res.headers['content-security-policy'];
  });

  const directive = (name) =>
    (csp.split(';').find((d) => d.trim().startsWith(name + ' ')) || '').trim();

  test('CSP হেডার আসলেই পাঠানো হচ্ছে', () => {
    expect(csp).toBeTruthy();
  });

  test("script-src-এ 'unsafe-inline' নেই", () => {
    expect(directive('script-src')).toBeTruthy();
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });

  test("script-src-attr 'none'", () => {
    expect(directive('script-src-attr')).toBe("script-src-attr 'none'");
  });

  test("style-src-elem-এ 'unsafe-inline' নেই, nonce আছে", () => {
    // বিস্তারিত: tests/security/cspInlineStyleRatchet.test.js
    // style-src-attr এখনো শিথিল (১৮৩২টা ইনলাইন style বাকি), তাই সেটা
    // ইচ্ছাকৃতভাবে এই গেটে নেই — নইলে গেটটা প্রথম দিনেই লাল থাকত।
    const elem = directive('style-src-elem');
    expect(elem).toBeTruthy();
    expect(elem).not.toContain("'unsafe-inline'");
    expect(elem).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });
});

describe('রিলিজ গেট ২ — টেমপ্লেটে ইনলাইন কোড শূন্য', () => {
  // বিস্তারিত ও র‍্যাচেটের পূর্ণ ইতিহাস: tests/security/cspInlineRatchet.test.js
  // এখানে শুধু বর্তমান সংখ্যা ০ কি না।
  const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;
  const SCRIPT_RE = /<script>/g;

  const count = (re) => {
    const perFile = [];
    let total = 0;
    for (const file of TEMPLATES) {
      const m = fs.readFileSync(file, 'utf8').match(re);
      if (m) { perFile.push(`${rel(file)}: ${m.length}`); total += m.length; }
    }
    return { total, perFile };
  };

  test('ইনলাইন ইভেন্ট হ্যান্ডলার ০', () => {
    const { total, perFile } = count(HANDLER_RE);
    expect({ total, files: perFile }).toEqual({ total: 0, files: [] });
  });

  test('nonce ছাড়া ইনলাইন <script> ব্লক ০', () => {
    const { total, perFile } = count(SCRIPT_RE);
    expect({ total, files: perFile }).toEqual({ total: 0, files: [] });
  });
});

describe('রিলিজ গেট ৩ — /api/docs অননুমোদিত অবস্থায় ২০০ দেয় না', () => {
  // বিস্তারিত: tests/security/swaggerDocsAccess.test.js (off/admin/public
  // তিন মোড), tests/security/apiDocsExposure.test.js,
  // tests/security/swaggerDocsCsp.test.js (scoped CSP)
  test('/api/docs.json — spec ফাঁস হয় না', async () => {
    const res = await freshRequest().get('/api/docs.json');
    expect(res.status).not.toBe(200);
    expect(res.text || '').not.toMatch(/"openapi"/);
  });

  test('/api/docs — UI ফাঁস হয় না', async () => {
    const res = await freshRequest().get('/api/docs/');
    expect(res.status).not.toBe(200);
    expect(res.text || '').not.toMatch(/swagger-ui/i);
  });
});

describe('রিলিজ গেট ৪ — production-এ HSTS', () => {
  // বিস্তারিত: tests/security/auditBackupProdConfig.test.js
  //
  // রানটাইমে যাচাই করা যায় না: helmet-এ hsts শাখাটা NODE_ENV দেখে, আর
  // টেস্ট প্রক্রিয়ায় NODE_ENV=test। তাই এখানে app.js-এর isProdEnv শাখাটাই
  // পড়া হচ্ছে — এবং শাখাটা যে সত্যিই production-শর্তে বাঁধা তাও।
  test('isProdEnv সংজ্ঞা production-এর সাথেই বাঁধা', () => {
    expect(APP_SRC).toMatch(/const isProdEnv = process\.env\.NODE_ENV === 'production'/);
  });

  test('helmet-এ hsts production-এ চালু, maxAge ≥ ১ বছর', () => {
    const line = /hsts:\s*isProdEnv \?\s*\{[^}]*\}\s*:\s*false/.exec(APP_SRC);
    expect(line).not.toBeNull();
    const maxAge = /maxAge:\s*(\d+)/.exec(line[0]);
    expect(maxAge).not.toBeNull();
    expect(Number(maxAge[1])).toBeGreaterThanOrEqual(31536000);
    expect(line[0]).toMatch(/includeSubDomains:\s*true/);
  });
});

describe('রিলিজ গেট ৫ — admin state-changing রুটে permission গার্ড', () => {
  // বিস্তারিত: tests/security/adminRoutePermissionSweep.test.js (allowlist-এর
  // প্রতিটা ব্যতিক্রমের কারণসহ), rbac.test.js, adminAuthorizationMatrix.test.js
  const SRC = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');
  const GUARD_RE = /requirePermission|requireRole|requireSuperAdmin|stepUp/;
  // প্রমাণীকরণ প্রবাহের অংশ — তখনো permission ধারণাটাই প্রযোজ্য নয়।
  const ALLOWED = new Set([
    'POST /login', 'POST /login/2fa', 'POST /logout',
    'POST /2fa/mandatory-setup/verify', 'POST /2fa/setup/verify',
    'POST /2fa/backup-codes/acknowledge', 'POST /2fa/disable'
  ]);

  const routes = [...SRC.matchAll(
    /router\.(post|put|patch|delete)\(\s*'([^']+)'([\s\S]{0,220}?)(?:async\s*)?\(req/g
  )].map((m) => ({
    name: `${m[1].toUpperCase()} ${m[2]}`,
    guarded: GUARD_RE.test(m[3])
  }));

  test('রুট স্ক্যান কাজ করছে', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  test('গার্ড ছাড়া কোনো রুট নেই', () => {
    const unguarded = routes.filter((r) => !r.guarded && !ALLOWED.has(r.name)).map((r) => r.name);
    expect(unguarded).toEqual([]);
  });
});

describe('রিলিজ গেট ৬ — সব external fetch টাইমআউটসহ', () => {
  // বিস্তারিত: tests/security/externalFetchTimeout.test.js (হেল্পারের
  // ভেতরের গঠন), tests/security/sportsApiTimeout.test.js
  test('টাইমআউট ছাড়া কোনো await fetch( নেই', () => {
    const offenders = [];
    for (const file of JS_SOURCES) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/await fetch\(/.test(line) && !/signal/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('হেল্পারটা আসলেই আছে ও AbortController ব্যবহার করে', () => {
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'httpClient.js'), 'utf8');
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/signal: controller\.signal/);
  });
});

describe('রিলিজ গেট ৭ — reward claim-এ শর্তসাপেক্ষ UPDATE', () => {
  // বিস্তারিত (প্রতিটাতেই সমান্তরাল claim চালিয়ে ledger মিলিয়ে দেখা হয়):
  //   services/cashback.js    → tests/integration/cashbackDuplicateClaim.test.js
  //   services/dailyReward.js → tests/integration/dailyRewardDuplicateClaim.test.js
  //   services/freebet.js     → tests/integration/freeBetDuplicateClaim.test.js
  //   services/missions.js    → tests/integration/missionDuplicateClaim.test.js
  //
  // এখানে শুধু দেখা হয় শর্তটা কোড থেকে সরে যায়নি। লক একা যথেষ্ট নয় —
  // লক শুধু একই প্রসেসে ক্রম ঠিক রাখে; শর্তসাপেক্ষ UPDATE ডাটাবেস স্তরে
  // দ্বিতীয় claim-কে ০ সারিতে নামিয়ে দেয়।
  const CASES = [
    ['cashback.js', /cashback_claimed = true WHERE id = \$1 AND cashback_claimed = false/],
    ['dailyReward.js', /WHERE id = \$2 AND claimed = false/],
    ['freebet.js', /status = 'used', used_at = NOW\(\) WHERE id = \$1 AND status = 'active'/],
    ['missions.js', /NOT \(\$1 = ANY\(COALESCE\(claimed_ids/]
  ];

  test.each(CASES)('services/%s-এ শর্তসাপেক্ষ UPDATE বহাল', (file, re) => {
    const src = fs.readFileSync(path.join(ROOT, 'services', file), 'utf8');
    expect(src).toMatch(re);
    // শর্তের পাশাপাশি সারি-লকও থাকতে হবে — দুটোই, একটা নয়
    expect(src).toMatch(/FOR UPDATE/);
  });
});

describe('রিলিজ গেট ৮ — লগে secret যায় না', () => {
  // বিস্তারিত: tests/security/sensitiveDataInLogs.test.js (প্রতিটা
  // প্যাটার্নের ব্যাখ্যা ও অনুমোদিত ব্যতিক্রম), errorLeakSweep.test.js
  const BODY_DUMP = /console\.\w+\([^)]*(req\.body|JSON\.stringify\(\s*req\.body)/;
  const SECRET_VALUE = /console\.\w+\([^)]*\b(?:password|passwordHash|withdraw_pin|withdrawPin|otp|totpSecret|sessionSecret|apiKey|accessToken|refreshToken)\b\s*[,)]/;

  test('কোথাও পুরো req.body লগ হয় না', () => {
    const offenders = JS_SOURCES.filter((f) => BODY_DUMP.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });

  test('কোনো secret ভেরিয়েবল সরাসরি লগ হয় না', () => {
    const offenders = [];
    for (const file of JS_SOURCES) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (SECRET_VALUE.test(line)) offenders.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
