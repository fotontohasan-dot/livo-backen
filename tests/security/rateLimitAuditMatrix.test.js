const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../helpers/app');

// ==================== রেট-লিমিট অডিট ম্যাট্রিক্স ====================
//
// Phase 1 item 7। এতদিন রেট-লিমিটিং ছড়ানো টেস্টে পরোক্ষভাবে যাচাই হত,
// কিন্তু "কোন সংবেদনশীল পথে কোন limiter, আর তার সীমা কত" — এই প্রশ্নের
// একটাও সরাসরি উত্তর ছিল না। কেউ একটা limiter সরিয়ে দিলে বা সীমা ১০ গুণ
// বাড়িয়ে দিলে কোনো টেস্ট ফেল করত না।
//
// এই ফাইলটা দুই স্তরে কাজ করে:
//   ১. কনফিগ স্তর — প্রতিটা limiter-এর max/windowMs সোর্স থেকে পড়ে
//      সীমার ছাদ যাচাই করে। ছাদ ছাড়িয়ে গেলে ফেল।
//   ২. রানটাইম স্তর — সত্যিই ৪২৯ আসে কি না দেখে। কনফিগ ঠিক থাকলেও
//      middleware ভুল ক্রমে বসলে limiter কার্যত নিষ্ক্রিয় থাকতে পারে।

const ROOT = path.join(__dirname, '..', '..');

function sourceFiles() {
  const out = ['app.js'];
  for (const dir of ['routes', 'middleware']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

// সোর্স থেকে limiter-এর নাম, max ও windowMs বের করা
function collectLimiters() {
  const found = {};
  const re = /(?:const|let)\s+(\w*[Ll]imiter)\s*=\s*(?:createLimiter\(\s*'[^']*'\s*,\s*)?(?:rateLimit\()?\{([\s\S]{0,400}?)\n\}\)/g;
  for (const rel of sourceFiles()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(re)) {
      const body = m[2];
      const max = /max:\s*([^,\n]+)/.exec(body);
      const win = /windowMs:\s*([^,\n]+)/.exec(body);
      if (!max || !win) continue;
      // eslint-disable-next-line no-eval
      const evalNum = (s) => { try { return eval(s.trim()); } catch (e) { return NaN; } };
      found[m[1]] = { file: rel, max: evalNum(max[1]), windowMs: evalNum(win[1]) };
    }
  }
  return found;
}

const LIMITERS = collectLimiters();

// প্রতিটা সংবেদনশীল শ্রেণির জন্য সর্বোচ্চ অনুমোদিত সীমা।
// সংখ্যাগুলো বর্তমান কনফিগ থেকে নেওয়া — উদ্দেশ্য "আরো কড়া করা" নয়,
// বরং কেউ যেন নীরবে ঢিলা করে দিতে না পারে।
const CEILINGS = {
  adminLoginLimiter:        { maxAtMost: 10,  windowAtLeast: 15 * 60 * 1000 },
  strict2FALimiter:         { maxAtMost: 10,  windowAtLeast: 15 * 60 * 1000 },
  resetLimiter:             { maxAtMost: 10,  windowAtLeast: 15 * 60 * 1000 },
  verifyResendLimiter:      { maxAtMost: 10,  windowAtLeast: 15 * 60 * 1000 },
  accountSecurityLimiter:   { maxAtMost: 10,  windowAtLeast: 15 * 60 * 1000 },
  kycLimiter:               { maxAtMost: 10,  windowAtLeast: 60 * 60 * 1000 },
  paymentLimiter:           { maxAtMost: 30,  windowAtLeast: 15 * 60 * 1000 },
  financialLimiter:         { maxAtMost: 30,  windowAtLeast: 15 * 60 * 1000 },
  adminFinancialLimiter:    { maxAtMost: 60,  windowAtLeast: 15 * 60 * 1000 },
  googleAuthLimiter:        { maxAtMost: 30,  windowAtLeast: 15 * 60 * 1000 },
  claimLimiter:             { maxAtMost: 20,  windowAtLeast: 60 * 1000 },
  helpChatLimiter:          { maxAtMost: 20,  windowAtLeast: 60 * 1000 },
  generalLimiter:           { maxAtMost: 500, windowAtLeast: 15 * 60 * 1000 }
};

describe('রেট-লিমিট অডিট — সংবেদনশীল limiter গুলো আছে', () => {
  test('প্রত্যাশিত প্রতিটা limiter সোর্সে পাওয়া যায়', () => {
    const missing = Object.keys(CEILINGS).filter((n) => !LIMITERS[n]);
    expect(missing).toEqual([]);
  });

  test('মোট limiter সংখ্যা কমে যায়নি', () => {
    // কেউ একগাদা limiter সরিয়ে দিলে এখানেই ধরা পড়বে।
    expect(Object.keys(LIMITERS).length).toBeGreaterThanOrEqual(15);
  });
});

describe('রেট-লিমিট অডিট — সীমা ঢিলা করা যাবে না', () => {
  test.each(Object.entries(CEILINGS))('%s', (name, rule) => {
    const cfg = LIMITERS[name];
    expect(cfg).toBeDefined();
    expect(Number.isFinite(cfg.max)).toBe(true);
    expect(Number.isFinite(cfg.windowMs)).toBe(true);

    // max বাড়ানো বা window ছোট করা — দুটোই limiter দুর্বল করে।
    expect({ name, max: cfg.max }).toEqual({ name, max: expect.any(Number) });
    expect(cfg.max).toBeLessThanOrEqual(rule.maxAtMost);
    expect(cfg.windowMs).toBeGreaterThanOrEqual(rule.windowAtLeast);
  });
});

describe('রেট-লিমিট অডিট — গ্লোবাল প্রয়োগ', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  test('generalLimiter সব রিকোয়েস্টে বসে', () => {
    expect(appSource).toMatch(/app\.use\(\s*generalLimiter\s*\)/);
  });

  test('লগইন ও রেজিস্ট্রেশন পথে আলাদা কড়া limiter', () => {
    expect(appSource).toMatch(/app\.use\(\s*'\/login',\s*loginLimiter\s*\)/);
    expect(appSource).toMatch(/app\.use\(\s*'\/register',\s*loginLimiter\s*\)/);
    expect(appSource).toMatch(/app\.use\(\s*'\/admin\/login',\s*loginLimiter\s*\)/);
  });

  test('আর্থিক পথগুলোতে financialLimiter', () => {
    ['/payment/deposit', '/payment/withdraw', '/profile/change-password']
      .forEach((p) => {
        expect(appSource).toContain(`app.use('${p}', financialLimiter)`);
      });
  });

  test('অ্যাডমিন রুটারে adminActionLimiter', () => {
    const adminSrc = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');
    expect(adminSrc).toMatch(/router\.use\(\s*adminActionLimiter\s*\)/);
  });
});

describe('রেট-লিমিট অডিট — রানটাইমে সত্যিই ৪২৯ আসে', () => {
  jest.setTimeout(60000);

  test('লগইনে বারবার চেষ্টা করলে ব্লক হয়', async () => {
    // কনফিগ ঠিক থাকলেও middleware ভুল ক্রমে বসলে limiter নিষ্ক্রিয় থাকত।
    // তাই সত্যিকারের রিকোয়েস্ট পাঠিয়ে যাচাই।
    const agent = request(app);
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const res = await agent.post('/login')
        .type('form')
        .send({ identifier: 'no-such-user-' + i, password: 'wrong-password' });
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });
});
