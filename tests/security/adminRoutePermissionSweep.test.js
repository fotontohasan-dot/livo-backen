const fs = require('fs');
const path = require('path');

// ==================== Phase 3: admin permission sweep ====================
//
// roadmap Phase 3-এর দাবি: প্রতিটা admin action-এ authorization থাকতে হবে,
// আর role গুলো least-privilege ভিত্তিতে যাচাই করতে হবে।
//
// tests/security/rbac.test.js ও adminAuthorizationMatrix.test.js নির্দিষ্ট
// রুট ধরে যাচাই করে, কিন্তু কোনো টেস্ট গোটা routes/admin.js স্ক্যান করে
// দেখত না "কোনো state-changing রুট গার্ড ছাড়া রয়ে গেছে কি না"। নতুন রুট
// যোগ করার সময় requirePermission ভুলে গেলে সেটা নীরবে ঢুকে পড়ত — আর
// admin রুটে সেটা মানে privilege escalation।
//
// এই sweep সেই ফাঁকটা বন্ধ করে: প্রতিটা POST/PUT/PATCH/DELETE-এ হয়
// permission গার্ড থাকতে হবে, নয় নিচের allowlist-এ থাকতে হবে।

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');

// গার্ড ছাড়া থাকা বৈধ রুট — সবগুলোই প্রমাণীকরণ প্রবাহের অংশ, যেখানে
// permission ধারণাটাই এখনো প্রযোজ্য নয় (ব্যবহারকারী তখনো লগইনই করেনি,
// বা নিজের 2FA সেটআপ করছে)। প্রতিটার কারণ আলাদা করে লেখা:
const ALLOWED_WITHOUT_PERMISSION = new Set([
  'POST /login',                        // লগইনের আগে permission থাকে না
  'POST /login/2fa',                    // লগইন প্রবাহের দ্বিতীয় ধাপ
  'POST /logout',                       // নিজের সেশন শেষ করা
  'POST /2fa/mandatory-setup/verify',   // বাধ্যতামূলক 2FA সেটআপ, লগইন সম্পূর্ণ হওয়ার আগে
  'POST /2fa/setup/verify',             // নিজের 2FA সেটআপ
  'POST /2fa/backup-codes/acknowledge', // নিজের backup code দেখা হয়েছে জানানো
  'POST /2fa/disable'                   // নিজের 2FA বন্ধ (isAdmin + নিজের অ্যাকাউন্ট)
]);

const GUARD_RE = /requirePermission|requireRole|requireSuperAdmin|stepUp/;

function stateChangingRoutes(src) {
  const out = [];
  const re = /router\.(post|put|patch|delete)\(\s*'([^']+)'([\s\S]{0,220}?)(?:async\s*)?\(req/g;
  for (const m of src.matchAll(re)) {
    out.push({
      name: m[1].toUpperCase() + ' ' + m[2],
      middleware: m[3],
      guarded: GUARD_RE.test(m[3])
    });
  }
  return out;
}

const ROUTES = stateChangingRoutes(SRC);

describe('Phase 3 — admin state-changing রুটে authorization', () => {
  test('রুট স্ক্যান কাজ করছে', () => {
    // regex ভেঙে গেলে ০টা রুট পাওয়া যেত আর নিচের sweep অর্থহীনভাবে পাস করত।
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  test('গার্ড ছাড়া কোনো নতুন রুট নেই', () => {
    const unguarded = ROUTES
      .filter((r) => !r.guarded)
      .map((r) => r.name)
      .filter((n) => !ALLOWED_WITHOUT_PERMISSION.has(n));

    expect(unguarded).toEqual([]);
  });

  test('allowlist-এর প্রতিটা এন্ট্রি এখনো বিদ্যমান', () => {
    // রুট মুছে গেলে allowlist-এ মৃত এন্ট্রি জমতে থাকত, আর একদিন সেই নামেই
    // নতুন একটা সংবেদনশীল রুট এসে নীরবে ছাড় পেয়ে যেত।
    const names = new Set(ROUTES.map((r) => r.name));
    const stale = [...ALLOWED_WITHOUT_PERMISSION].filter((n) => !names.has(n));
    expect(stale).toEqual([]);
  });

  test('allowlist-এর সবগুলোই প্রমাণীকরণ/2FA প্রবাহের', () => {
    // কেউ যেন সুবিধামতো একটা আর্থিক রুট allowlist-এ ঢুকিয়ে না দেয়।
    for (const name of ALLOWED_WITHOUT_PERMISSION) {
      expect(name).toMatch(/\/(login|logout|2fa)/);
    }
  });

  test('আর্থিক ও ব্যবহারকারী-ব্যবস্থাপনার রুটগুলো গার্ডেড', () => {
    const sensitive = ROUTES.filter((r) =>
      /(withdraw|deposit|payment|user|role|permission|kyc|balance|coin)/i.test(r.name));
    expect(sensitive.length).toBeGreaterThan(5);
    expect(sensitive.filter((r) => !r.guarded).map((r) => r.name)).toEqual([]);
  });
});

describe('Phase 3 — adminActionLimiter রুটারে বসানো', () => {
  test('router.use(adminActionLimiter) আছে', () => {
    // প্রতি-রুট rate limit না থাকলেও রুটার-স্তরের limiter সব admin
    // action-কে ঢাকে; সেটা সরে গেলে brute-force সুরক্ষা চলে যেত।
    expect(SRC).toMatch(/router\.use\(\s*adminActionLimiter\s*\)/);
  });
});
