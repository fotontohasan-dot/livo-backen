// tests/render/adminTableResponsive.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন টেবিলের রেসপন্সিভ র‍্যাপার রিগ্রেশন টেস্ট।
//
// কেন দরকার: অ্যাডমিন প্যানেলের ডেটা টেবিলগুলো `overflow-hidden` কার্ডের ভেতরে বসানো ছিল।
// ডেস্কটপে সমস্যা হতো না, কিন্তু ৩৬০–৩৯০px মোবাইল স্ক্রিনে টেবিল কার্ডের চেয়ে চওড়া হয়ে
// যেত এবং ডান দিকের কলামগুলো (স্ট্যাটাস/অ্যাকশন বাটন) সম্পূর্ণ ক্লিপ হয়ে যেত — স্ক্রলও
// করা যেত না, ফলে সেগুলোতে পৌঁছানোর কোনো উপায় থাকত না।
//
// সঠিক প্যাটার্ন views/admin/backups.ejs-এ আগে থেকেই ছিল: টেবিলের নিকটতম র‍্যাপারে
// `overflow-x-auto` (বা কাস্টম CSS-এ `overflow-x: auto`)।
//
// এই টেস্ট স্ট্যাটিকভাবে (DB/ব্রাউজার ছাড়া) নিশ্চিত করে যে —
//   ১) কোনো <table>-এর নিকটতম র‍্যাপার আবার `overflow-hidden` দিয়ে ক্লিপ করে না;
//   ২) যে পেজগুলো ঠিক করা হয়েছে সেখানে প্রতিটা টেবিলের হরাইজন্টাল-স্ক্রল র‍্যাপার আছে।
//
// দ্রষ্টব্য: বাইরের কার্ডে `overflow-hidden` থাকা দোষের নয় যদি টেবিলের ঠিক ওপরে একটা
// `overflow-x-auto` ইনার র‍্যাপার থাকে (যেমন user-detail.ejs) — তাই "নিকটতম র‍্যাপার"
// দেখা হয়, সব পূর্বপুরুষ নয়।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ADMIN_VIEWS_DIR = path.join(__dirname, '..', '..', 'views', 'admin');

// কত লাইন পিছনে গিয়ে নিকটতম র‍্যাপার খোঁজা হবে (হেডার/টাইটেল ব্লকসহ কার্ডের জন্য যথেষ্ট)
const WRAPPER_LOOKBACK = 8;

// যে ভিউগুলোর টেবিল-ক্লিপিং এই কাজে ঠিক করা হয়েছে — এগুলো রিগ্রেস করলে টেস্ট ফেল করবে
const FIXED_VIEWS = [
  'analytics.ejs',
  'announcements.ejs',
  'backups.ejs',
  'bets.ejs',
  'bot-ip-rules.ejs',
  'bot-logs.ejs',
  'bot-monitoring.ejs',
  'cache.ejs',
  'deposits.ejs',
  'duplicate-accounts.ejs',
  'fraud-logs.ejs',
  'fraud-monitoring.ejs',
  'games.ejs',
  'localization.ejs',
  'login-history.ejs',
  'markets.ejs',
  'matches.ejs',
  'security-overview.ejs',
  'settings.ejs',
  'transactions.ejs',
  'user-detail.ejs',
  'user-roles.ejs',
  'users.ejs',
  'withdrawals.ejs',
];

function listEjsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listEjsFiles(full));
    else if (entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

// ইনলাইন <style> ব্লক থেকে সেই ক্লাসগুলো বের করে যাদের overflow-x স্ক্রলযোগ্য।
// যেমন: `.ann-table-wrap { overflow-x: auto; ... }`
function scrollableCustomClasses(source) {
  const classes = new Set();
  const ruleRe = /\.([A-Za-z0-9_-]+)[^{}]*\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(source)) !== null) {
    if (/overflow(-x)?\s*:\s*(auto|scroll)/i.test(match[2])) classes.add(match[1]);
  }
  return classes;
}

function classListOf(divTag) {
  const match = /class\s*=\s*"([^"]*)"/.exec(divTag);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

function isScrollable(classes, customScrollClasses) {
  return classes.some(
    (c) =>
      c === 'overflow-x-auto' ||
      c === 'overflow-x-scroll' ||
      c === 'overflow-auto' ||
      c === 'overflow-scroll' ||
      customScrollClasses.has(c)
  );
}

// টেবিলের নিকটতম <div> র‍্যাপার খুঁজে রায় দেয়: 'scrollable' | 'clipping' | 'none'
function nearestWrapperVerdict(lines, tableLineIndex, customScrollClasses) {
  for (let back = 0; back <= WRAPPER_LOOKBACK && tableLineIndex - back >= 0; back += 1) {
    const divTags = (lines[tableLineIndex - back].match(/<div\b[^>]*>/g) || []).reverse();
    for (const tag of divTags) {
      const classes = classListOf(tag);
      if (isScrollable(classes, customScrollClasses)) return 'scrollable';
      if (classes.includes('overflow-hidden')) return 'clipping';
    }
  }
  return 'none';
}

function auditFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const customScrollClasses = scrollableCustomClasses(source);
  const lines = source.split('\n');
  const results = [];

  lines.forEach((line, idx) => {
    if (!/<table\b/.test(line)) return;
    results.push({
      location: `${path.relative(ADMIN_VIEWS_DIR, file)}:${idx + 1}`,
      verdict: nearestWrapperVerdict(lines, idx, customScrollClasses),
    });
  });

  return results;
}

const adminViewFiles = listEjsFiles(ADMIN_VIEWS_DIR);

describe('অ্যাডমিন টেবিল মোবাইল-রেসপন্সিভ র‍্যাপার', () => {
  test('views/admin-এ টেমপ্লেট ও টেবিল পাওয়া গেছে', () => {
    expect(adminViewFiles.length).toBeGreaterThan(0);
    const totalTables = adminViewFiles.reduce((n, f) => n + auditFile(f).length, 0);
    expect(totalTables).toBeGreaterThan(20);
  });

  test('রেফারেন্স প্যাটার্ন (backups.ejs) অক্ষত আছে', () => {
    const src = fs.readFileSync(path.join(ADMIN_VIEWS_DIR, 'backups.ejs'), 'utf8');
    expect(src).toMatch(/overflow-x-auto/);
    expect(src).not.toMatch(/overflow-hidden/);
  });

  test('কোনো টেবিলের নিকটতম র‍্যাপার overflow-hidden দিয়ে ক্লিপ করে না', () => {
    const clipped = adminViewFiles
      .flatMap(auditFile)
      .filter((r) => r.verdict === 'clipping')
      .map((r) => r.location);

    expect(clipped).toEqual([]);
  });

  test('ঠিক করা ভিউগুলোর প্রতিটা টেবিলে হরাইজন্টাল-স্ক্রল র‍্যাপার আছে', () => {
    const unscrollable = [];

    for (const name of FIXED_VIEWS) {
      const file = path.join(ADMIN_VIEWS_DIR, name);
      expect(fs.existsSync(file)).toBe(true);

      const results = auditFile(file);
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        if (r.verdict !== 'scrollable') unscrollable.push(`${r.location} (${r.verdict})`);
      }
    }

    expect(unscrollable).toEqual([]);
  });
});
