// tests/render/adminI18nCoverage.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন প্যানেলের দ্বিভাষিক (bn/en) কভারেজ রিগ্রেশন টেস্ট।
//
// যে বাস্তব সমস্যাগুলো ধরা পড়েছিল এবং এখানে লক করা হচ্ছে:
//   • views/admin/partials/sidebar.ejs-এ ৫৬টা নেভিগেশন লিংকের লেবেল হার্ডকোড
//     বাংলা ছিল। ২৪টা অ্যাডমিন পেজ এই সাইডবার ব্যবহার করে, তাই English মোডেও
//     ওই পেজগুলোর পুরো নেভিগেশন বাংলাতেই থাকত। উপরন্তু admin-layout.ejs-এর
//     ডেটা-চালিত নেভের সাথে এটা একটা দ্বিতীয় সমান্তরাল তালিকা ছিল —
//     utils/adminNav.js-এ লিংক যোগ করলে এখানে আসত না।
//   • অ্যাডমিন প্যানেলের ভেতরে ভাষা বদলানোর কোনো UI ছিল না; `/lang/:code`
//     সুইচার শুধু ইউজার-সাইড navbar-এ বসানো ছিল।
//   • নির্বাচিত ভাষা শুধু সেশনে থাকত, users টেবিলে কোনো কলাম ছিল না — সেশন
//     শেষ হলেই ভাষা ডিফল্টে ফিরে যেত।
//   • অ্যাডমিন ভিউগুলোতে ৬৩৩টা হার্ডকোড ইউজার-ভিজিবল স্ট্রিং ছিল।
//
// এই টেস্ট নতুন হার্ডকোড স্ট্রিং ঢুকলে ফেল করবে। কোনো স্ট্রিং ইচ্ছাকৃতভাবে
// অনুবাদ না করলে (ব্র্যান্ড নাম, টেকনিক্যাল আইডেন্টিফায়ার, ফরম্যাট মাস্ক)
// সেটা নিচের ALLOWED তালিকায় কারণসহ যোগ করতে হবে — চুপচাপ বাদ দেওয়া যাবে না।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN_VIEWS = path.join(ROOT, 'views', 'admin');
const bn = require('../../locales/bn.json');
const en = require('../../locales/en.json');

// ইচ্ছাকৃতভাবে অনুবাদ না করা মান — প্রতিটার কারণ পাশে লেখা।
const ALLOWED = new Set([
  'Livo',                                    // ব্র্যান্ড নাম
  'Livo Admin',                              // ব্র্যান্ড নাম
  'Livo Betting Platform • Admin Dashboard', // ব্র্যান্ড ট্যাগলাইন
  'বাংলা',                                    // ভাষা সুইচারের endonym — সবসময় নিজের ভাষাতেই দেখানো হয়
  'English',                                 // একই কারণ
  'Bangla (bn)',                             // locale ফাইলের কলাম শিরোনাম — ফাইলের নাম বোঝায়
  'English (en)',                            // একই কারণ
  'key_name (a-z, 0-9, _)',                  // ইনপুট ফরম্যাট মাস্ক
  'XXXXX-XXXXX',                             // ব্যাকআপ কোড ফরম্যাট মাস্ক
  '------ বা XXXXX-XXXXX',                   // একই ফরম্যাট মাস্ক
  '01XXXXXXXXX',                             // ফোন নম্বর ফরম্যাট মাস্ক
  'match_winner',                            // ডেটাবেস enum মান — অনুবাদ করলে ডেটা ভাঙবে
  'IP',                                      // টেকনিক্যাল সংক্ষেপ, দুই ভাষাতেই এক
  'Redis',                                   // পণ্যের নাম
  'Database',                                // টেকনিক্যাল টার্ম, স্ট্যাটাস কার্ডের লেবেল
  '&nbsp;'                                   // লেআউট স্পেসার, কোনো টেক্সট নয়
]);

// ---------------------------------------------------------------------------
// EJS ফাইলের কোন অংশ "HTML অঞ্চল" তা বের করা।
//
// <script>, <style>, EJS ট্যাগ ও HTML কমেন্টের ভেতরের টেক্সট ইউজারকে সরাসরি
// দেখানো হয় না (অথবা JS-জেনারেটেড, যেটা আলাদাভাবে হ্যান্ডল করতে হয়), তাই সেগুলো
// বাদ দেওয়া হয়। এই সীমানা না মানলে স্ক্যানার JS টেমপ্লেট লিটারালকেও HTML টেক্সট
// ভেবে ফেলে।
// ---------------------------------------------------------------------------
function blockedMask(s) {
  const mask = new Uint8Array(s.length);
  const patterns = [
    /<%[\s\S]*?%>/g,
    /<script\b[\s\S]*?<\/script\s*>/gi,
    /<style\b[\s\S]*?<\/style\s*>/gi,
    /<!--[\s\S]*?-->/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s))) {
      for (let i = m.index; i < m.index + m[0].length && i < s.length; i++) mask[i] = 1;
    }
  }
  return mask;
}
function isFree(mask, a, b) {
  for (let i = a; i < b; i++) if (mask[i]) return false;
  return true;
}

function adminViewFiles() {
  const out = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.ejs')) out.push(p);
    }
  })(ADMIN_VIEWS);
  return out;
}

function hardcodedIn(file) {
  const s = fs.readFileSync(file, 'utf8');
  const mask = blockedMask(s);
  const hits = [];
  const push = (t) => {
    const v = String(t).trim().replace(/\s+/g, ' ');
    if (!v || v.length < 2) return;
    if (!/[A-Za-z\u0980-\u09FF]/.test(v)) return;   // শুধু সংখ্যা/চিহ্ন হলে টেক্সট নয়
    if (ALLOWED.has(v)) return;
    hits.push(v);
  };
  let m, re;
  re = />([^<>]+)</g;
  while ((m = re.exec(s))) { if (isFree(mask, m.index, m.index + m[0].length)) push(m[1]); }
  re = /(placeholder|title|aria-label|alt)\s*=\s*"([^"]*)"/g;
  while ((m = re.exec(s))) { if (isFree(mask, m.index, m.index + m[0].length)) push(m[2]); }
  // value= শুধু submit/button-এর ক্ষেত্রে ইউজার-ভিজিবল লেবেল; বাকি সব ক্ষেত্রে
  // সেটা ফর্ম/ডেটাবেস মান, যেটা অনুবাদ করা যাবে না।
  re = /<input[^>]*type\s*=\s*"(?:submit|button)"[^>]*value\s*=\s*"([^"]*)"/gi;
  while ((m = re.exec(s))) { if (isFree(mask, m.index, m.index + m[0].length)) push(m[1]); }
  return hits;
}

describe('অ্যাডমিন প্যানেল — হার্ডকোড টেক্সট নেই', () => {
  test('কোনো অ্যাডমিন ভিউয়ের HTML অঞ্চলে অননুমোদিত হার্ডকোড স্ট্রিং নেই', () => {
    const offenders = {};
    for (const f of adminViewFiles()) {
      const hits = hardcodedIn(f);
      if (hits.length) offenders[path.relative(ROOT, f)] = [...new Set(hits)];
    }
    expect(offenders).toEqual({});
  });

  test('অনুমোদিত-তালিকার প্রতিটা এন্ট্রি এখনো সত্যিই ব্যবহার হচ্ছে (তালিকা ফুলে যায় না)', () => {
    // ALLOWED-এ এমন কিছু থেকে গেলে যেটা আর কোথাও নেই, পরের ডেভেলপার ভাববে
    // সেটা এখনো একটা সচেতন ব্যতিক্রম। মৃত এন্ট্রি সরিয়ে ফেলাই উদ্দেশ্য।
    const all = adminViewFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const dead = [...ALLOWED].filter((v) => v !== '&nbsp;' && !all.includes(v));
    expect(dead).toEqual([]);
  });
});

describe('অ্যাডমিন নেভিগেশন একটাই উৎস থেকে আসে', () => {
  test('sidebar.ejs আর নিজে লিংক তালিকা রাখে না — adminNav থেকে রেন্ডার করে', () => {
    const src = fs.readFileSync(path.join(ADMIN_VIEWS, 'partials', 'sidebar.ejs'), 'utf8');
    expect(src).toMatch(/adminNav/);
    // নেভিগেশন অংশে হাতে লেখা /admin/... লিংক ফিরে এলে ধরা পড়বে। '/' ও
    // '/logout' ইচ্ছাকৃত ব্যতিক্রম (সাধারণ গ্রুপ), তাই সেগুলো গোনা হয় না।
    const handWritten = (src.match(/href="\/(?:admin|payment|chat)\//g) || []).length;
    expect(handWritten).toBe(0);
  });

  test('দুই অ্যাডমিন লেআউটেই ভাষা সুইচার আছে', () => {
    for (const rel of ['partials/sidebar.ejs', 'partials/admin-layout.ejs']) {
      const src = fs.readFileSync(path.join(ADMIN_VIEWS, rel), 'utf8');
      expect(src).toMatch(/include\('\.\/lang-switch'\)/);
    }
  });

  test('ভাষা সুইচার দুটো ভাষাতেই লিংক দেয় এবং সক্রিয়টা চিহ্নিত করে', () => {
    const src = fs.readFileSync(path.join(ADMIN_VIEWS, 'partials', 'lang-switch.ejs'), 'utf8');
    expect(src).toContain('/lang/bn');
    expect(src).toContain('/lang/en');
    expect(src).toMatch(/aria-current/);
  });
});

describe('অনুবাদক `t` কোথাও shadow হয় না', () => {
  // বাস্তবে ধরা পড়া বাগ: views/admin/tournaments.ejs-এ
  // `tournaments.forEach(t => { ... })` লুপ ভ্যারিয়েবলটা res.locals.t-কে ঢেকে
  // দিত, ফলে ওই ব্লকের ভেতরে t('key') কল করলে "t is not a function" →
  // /admin/tournaments পুরো 500। আগে ধরা পড়েনি কারণ ব্লকটায় কোনো অনুবাদ কল
  // ছিল না; অনুবাদ যোগ করার মুহূর্তেই পেজটা ভেঙে যায়। activity.ejs ও
  // notification-template-form.ejs-এও একই shadowing ছিল।
  const SHADOW_PATTERNS = [
    /\(\s*t\s*\)\s*=>/,          // (t) =>
    /\bfunction\s*\(\s*t\s*[,)]/, // function (t)  /  function (t, i)
    /\.forEach\(\s*t\s*=>/,       // .forEach(t =>
    /\.map\(\s*t\s*=>/,           // .map(t =>
    /\b(?:const|let|var)\s+t\s*=/ // const t = ...
  ];

  test.each(adminViewFiles().map((f) => path.relative(ROOT, f)))(
    '%s — `t` নামে কোনো লোকাল ভ্যারিয়েবল/প্যারামিটার নেই',
    (rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const offenders = SHADOW_PATTERNS.filter((re) => re.test(src)).map((re) => String(re));
      expect(offenders).toEqual([]);
    }
  );
});

describe('অনুবাদ ফাইলের অখণ্ডতা', () => {
  test('অ্যাডমিন ভিউয়ে ব্যবহৃত প্রতিটা t() key দুই locale-এই আছে', () => {
    const missing = [];
    for (const f of adminViewFiles()) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /\bt\(\s*'([a-z0-9_]+)'\s*\)/g;
      let m;
      while ((m = re.exec(src))) {
        const k = m[1];
        if (!(k in bn) || !(k in en)) missing.push(path.relative(ROOT, f) + ' → ' + k);
      }
    }
    expect(missing).toEqual([]);
  });

  test('bn ও en-এ key সংখ্যা সমান এবং কোনো মান খালি নয়', () => {
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort());
    const empty = Object.keys(bn).filter((k) => !String(bn[k]).trim() || !String(en[k]).trim());
    expect(empty).toEqual([]);
  });

  test('নতুন admin_* key-এর বাংলা মান সত্যিই বাংলা (ইংরেজি কপি নয়)', () => {
    // app.js-এর Proxy অনুপস্থিত key-এর বদলে key-এর নামটাই ছাপে, আর bn=en হলে
    // বাংলা মোডেও ইংরেজি দেখা যায় — দুটোই আগে বাস্তবে ঘটেছে। ছোট মান
    // (সংক্ষেপ, পণ্যের নাম) দুই ভাষায় এক থাকা স্বাভাবিক, তাই দৈর্ঘ্যের সীমা।
    const suspicious = Object.keys(bn).filter(
      (k) => k.startsWith('admin_') && bn[k] === en[k] && String(bn[k]).length > 24
    );
    expect(suspicious).toEqual([]);
  });
});
