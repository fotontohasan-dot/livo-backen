// tests/render/backendLocalizationIntegrity.test.js
// ---------------------------------------------------------------------------
// ব্যাকএন্ড লোকালাইজেশন রিগ্রেশন টেস্ট।
//
// আগে যে সমস্যাগুলো ছিল এবং এখানে লক করা হচ্ছে:
//   • routes/*, middleware/*, services/* এর req.flash()/res.json()/res.send()
//     মেসেজে বাংলা হার্ডকোড করা ছিল — English মোডেও ইউজার বাংলা ফ্ল্যাশ/এরর দেখত।
//   • services/* (wheel, missions, cashback, ...) req পায় না, তাই ওখানকার
//     message বাংলাতেই আটকে ছিল। এখন রুট থেকে req.lang পাঠানো হয় এবং
//     utils/i18n-এর t(lang, key) ব্যবহার হয়।
//   • bn.json / en.json parity ভেঙে গেলে অথবা কোনো key শুধু এক ফাইলে থাকলে
//     app.js-এর Proxy ইউজারকে কাঁচা key-এর নাম দেখিয়ে দেয়।
//
// এই টেস্ট একই শ্রেণির সমস্যা ফিরে এলে ধরে ফেলবে।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const bn = require('../../locales/bn.json');
const en = require('../../locales/en.json');
const BENGALI = /[\u0980-\u09FF]/;

// লোকালাইজ করা ব্যাকএন্ড ফাইল — এই তালিকার কোনো ফাইলে নতুন হার্ডকোড বাংলা
// ইউজার-ফেসিং মেসেজ ঢুকলে টেস্ট ফেল করবে। নতুন ফাইল লোকালাইজ করার পরে
// এখানে যোগ করলেই সেটাও গার্ডেড হবে।
const LOCALIZED_BACKEND = [
  'routes/accumulator.js', 'routes/api.js', 'routes/auth.js', 'routes/chat.js',
  'routes/coins.js', 'routes/extra.js', 'routes/games.js', 'routes/help-center.js',
  'routes/leaderboard.js', 'routes/matches.js', 'routes/payment.js', 'routes/profile.js',
  'routes/tournaments.js',
  'routes/admin.js', 'routes/adminGames.js', 'routes/adminTelegram.js',
  'routes/adminLeaderboard.js', 'routes/adminHealthFix.js',
  'middleware/apiKeyAuth.js', 'middleware/auth.js', 'middleware/filterMiddleware.js',
  'middleware/gateway.js', 'middleware/validate.js',
  'services/wheel.js', 'services/missions.js', 'services/cashback.js',
  'services/dailyReward.js', 'services/periodicReward.js', 'services/loyalty.js',
  'services/freebet.js', 'services/redpacket.js', 'services/social.js',
  'services/accumulator.js', 'services/rbac.js'
];

// ইচ্ছাকৃতভাবে বাদ দেওয়া প্যাটার্ন — এগুলো ইউজারকে দেখানো হয় না, তাই
// লোকালাইজ করা হয়নি (কারণ AUDIT_FULL/রিপোর্টে নথিবদ্ধ):
//   • logAdminAction()/logAudit() — admin_logs টেবিলের অডিট রেকর্ড। লেখার সময়
//     অনুবাদ করলে যে অ্যাডমিন অ্যাকশনটা নিয়েছে তার ভাষায় রেকর্ড জমা হতো,
//     ফলে একই টেবিলে দুই ভাষা মিশে যেত।
//   • INSERT INTO notifications — মেসেজ ডেটাবেসে persist হয়; প্রাপক ইউজারের
//     ভাষা লেখার সময় জানা যায় না (users টেবিলে lang কলাম নেই)।
//   • console.log/error — সার্ভার লগ, ইউজার দেখে না।
// `audit(req, { details: '...' })` — adminTelegram/adminLeaderboard-এর অডিট পেলোড।
// এটাও audit_logs-এ persist হয়, তাই logAdminAction-এর মতোই বাদ।
const EXEMPT_LINE = /logAdminAction|logAudit|details\s*:|INSERT INTO notifications|console\.(log|error|warn|info|debug)|^\s*\/\/|^\s*\*/;

// ইউজার-ফেসিং আউটপুট প্যাটার্ন
const USER_FACING = /req\.flash\s*\(|res\.json\s*\(|res\.send\s*\(|\.status\s*\(\s*\d+\s*\)\s*\.(json|send)|errors\.push\s*\(|encodeURIComponent\s*\(|message\s*:|error\s*:/;

function hardcodedBengali(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const hits = [];
  src.split('\n').forEach((line, i) => {
    if (!BENGALI.test(line)) return;
    if (EXEMPT_LINE.test(line)) return;
    if (!USER_FACING.test(line)) return;
    // শুধু স্ট্রিং লিটারেলের ভেতরের বাংলাই গোনা হয় — লাইনের কমেন্ট অংশ নয়।
    const withoutComment = line.replace(/\/\/.*$/, '');
    const literals = withoutComment.match(/'[^']*'|"[^"]*"|`[^`]*`/g) || [];
    for (const lit of literals) {
      if (BENGALI.test(lit)) hits.push(`${rel}:${i + 1} ${lit.slice(0, 70)}`);
    }
  });
  return hits;
}

describe('ব্যাকএন্ডে হার্ডকোড বাংলা ফিরে আসেনি', () => {
  test.each(LOCALIZED_BACKEND)('%s — ইউজার-ফেসিং বাংলা লিটারেল নেই', (rel) => {
    expect(hardcodedBengali(rel)).toEqual([]);
  });
});

describe('locale parity ও অনুবাদের গুণ', () => {
  test('bn ও en-এ একই key সেট', () => {
    expect(Object.keys(bn).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in bn))).toEqual([]);
  });

  test('কোনো key খালি নয়', () => {
    expect(Object.keys(bn).filter((k) => !String(bn[k]).trim() || !String(en[k]).trim())).toEqual([]);
  });

  test('en.json-এ বাংলা লিক করেনি (৳ বাদে)', () => {
    const leaked = Object.keys(en).filter((k) => BENGALI.test(String(en[k]).replace(/৳/g, '')));
    expect(leaked).toEqual([]);
  });

  test('bn.json-এ প্রতিটা মান সত্যিই বাংলা বা টেকনিক্যাল টার্ম', () => {
    // অনুবাদ না করে en-এর মান কপি করা হলে দুই ফাইলে হুবহু এক থাকত। শুধু
    // টেকনিক্যাল টার্ম/কোড-জাতীয় ছোট মানই দুই ভাষায় এক থাকা স্বাভাবিক।
    const identical = Object.keys(bn).filter((k) => bn[k] === en[k] && String(bn[k]).length > 24);
    expect(identical).toEqual([]);
  });
});

describe('interpolation placeholder দুই ভাষাতেই অটুট', () => {
  test('bn ও en-এ একই {valueN} placeholder সেট', () => {
    const mismatched = [];
    for (const k of Object.keys(bn)) {
      const pb = (String(bn[k]).match(/\{value\d*\}/g) || []).sort().join(',');
      const pe = (String(en[k]).match(/\{value\d*\}/g) || []).sort().join(',');
      if (pb !== pe) mismatched.push(`${k}: bn=[${pb}] en=[${pe}]`);
    }
    expect(mismatched).toEqual([]);
  });

  test('কোনো locale মানে কাঁচা ${...} টেমপ্লেট এক্সপ্রেশন থাকেনি', () => {
    const raw = Object.keys(bn).filter((k) => /\$\{/.test(String(bn[k])) || /\$\{/.test(String(en[k])));
    expect(raw).toEqual([]);
  });
});

describe('utils/i18n হেল্পার', () => {
  const { t, tr, langOf } = require('../../utils/i18n');

  test('t() নির্বাচিত ভাষার মান ফেরত দেয়', () => {
    expect(t('bn', 'common_server_error')).toBe(bn.common_server_error);
    expect(t('en', 'common_server_error')).toBe(en.common_server_error);
  });

  test('অজানা key হলে key-টাই ফেরত (app.js Proxy-র মতোই)', () => {
    expect(t('en', '__no_such_key__')).toBe('__no_such_key__');
  });

  test('অজানা/অনুপস্থিত ভাষা বাংলায় ফলব্যাক করে', () => {
    expect(t('fr', 'common_server_error')).toBe(bn.common_server_error);
    expect(t(undefined, 'common_server_error')).toBe(bn.common_server_error);
  });

  test('tr() req.lang, তারপর session.lang থেকে ভাষা নেয়', () => {
    expect(tr({ lang: 'en' }, 'common_server_error')).toBe(en.common_server_error);
    expect(tr({ session: { lang: 'en' } }, 'common_server_error')).toBe(en.common_server_error);
    expect(tr({}, 'common_server_error')).toBe(bn.common_server_error);
    expect(tr(undefined, 'common_server_error')).toBe(bn.common_server_error);
  });

  test('langOf() সবসময় bn অথবা en দেয়', () => {
    expect(langOf({ lang: 'en' })).toBe('en');
    expect(langOf({ lang: 'zz' })).toBe('bn');
    expect(langOf(undefined)).toBe('bn');
  });
});

describe('service মেসেজ দুই ভাষাতেই আসে', () => {
  // services/* req পায় না — রুট req.lang পাঠায়। lang প্যারামিটার সত্যিই
  // কাজ করছে কি না সেটা DB ছাড়াই যাচাই: lang ভুলে না পাঠালে 'bn' ফলব্যাক।
  const { t } = require('../../utils/i18n');

  test.each([
    ['wheel_already_spun_today'],
    ['missions_already_claimed'],
    ['cashback_already_claimed'],
    ['daily_reward_already_claimed'],
    ['loyalty_insufficient_points'],
    ['freebet_not_found_or_used'],
    ['redpacket_already_claimed'],
    ['social_share_bonus_claimed'],
    ['accumulator_min_selections'],
    ['common_insufficient_coins']
  ])('%s — bn বাংলা, en ইংরেজি', (key) => {
    expect(bn[key]).toBeDefined();
    expect(en[key]).toBeDefined();
    expect(BENGALI.test(t('bn', key))).toBe(true);
    expect(BENGALI.test(String(t('en', key)).replace(/৳/g, ''))).toBe(false);
  });

  test('লোকালাইজ করা service ফাংশনগুলো lang প্যারামিটার নেয়', () => {
    const expected = {
      'services/wheel.js': ['spin', 'getTodayResult'],
      'services/missions.js': ['claimMission'],
      'services/cashback.js': ['claimCashback'],
      'services/dailyReward.js': ['claimDailyReward'],
      'services/periodicReward.js': ['claimWeekly', 'claimMonthly'],
      'services/loyalty.js': ['redeemPoints'],
      'services/freebet.js': ['claimFreeBet'],
      'services/redpacket.js': ['claimRedPacket', 'claimGoldenEgg'],
      'services/social.js': ['claimShare'],
      'services/accumulator.js': ['placeAccumulator']
    };
    const missing = [];
    for (const [rel, fns] of Object.entries(expected)) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const fn of fns) {
        const re = new RegExp(`function ${fn}\\s*\\(([^)]*)\\)`);
        const m = re.exec(src);
        if (!m || !/\blang\b/.test(m[1])) missing.push(`${rel}:${fn}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('রুটগুলো service-এ req.lang পাঠায়', () => {
    const calls = [
      ['routes/profile.js', 'spin(req.session.user.id, req.lang)'],
      ['routes/profile.js', 'claimMission(req.session.user.id, parseInt(req.params.id), req.lang)'],
      ['routes/profile.js', 'claimDailyReward(req.session.user.id, req.lang)'],
      ['routes/profile.js', 'claimRedPacket(req.session.user.id, req.lang)'],
      ['routes/profile.js', 'claimShare(req.session.user.id, req.lang)'],
      ['routes/accumulator.js', 'req.lang)']
    ];
    const missing = calls.filter(([rel, snippet]) =>
      !fs.readFileSync(path.join(ROOT, rel), 'utf8').includes(snippet));
    expect(missing).toEqual([]);
  });
});

describe('rate-limiter মেসেজ module scope-এ req ছোঁয় না', () => {
  // rateLimit({ message: req.t(...) }) module scope-এ req নেই — লোড করলেই
  // ReferenceError হতো। limiter কনফিগে অনুবাদ সবসময় ফাংশনের ভেতরে হতে হবে।
  const FILES = ['app.js', 'routes/api.js', 'routes/auth.js', 'routes/extra.js',
    'routes/payment.js', 'routes/profile.js', 'routes/admin.js', 'routes/adminTelegram.js'];

  test.each(FILES)('%s — limiter কনফিগে বেয়ার req.t/tr(req) নেই', (rel) => {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    const bad = [];
    lines.forEach((line, i) => {
      // `message: req.t('x')` — ফাংশন র‍্যাপার ছাড়া সরাসরি কল
      if (/^\s*message:\s*(req\.t|tr)\s*\(/.test(line)) bad.push(`${rel}:${i + 1} ${line.trim()}`);
    });
    expect(bad).toEqual([]);
  });

  test('লোকালাইজ করা মডিউল require করা যায় (module scope-এ req নেই)', () => {
    expect(() => {
      require('../../middleware/apiKeyAuth');
      require('../../middleware/auth');
      require('../../middleware/gateway');
      require('../../middleware/validate');
      require('../../middleware/filterMiddleware');
      require('../../services/rbac');
    }).not.toThrow();
  });
});
