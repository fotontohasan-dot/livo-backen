const fs = require('fs');
const path = require('path');

// docs/CSP.md ধাপ ২-এর সপ্তম স্লাইস:
//   views/admin/matches.ejs      — ৭টা হ্যান্ডলার
//   views/admin/localization.ejs — ৭টা হ্যান্ডলার

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;
const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;

const matchesView = read('views', 'admin', 'matches.ejs');
const matchesJs = read('public', 'js', 'admin-matches.js');
const locView = read('views', 'admin', 'localization.ejs');
const locJs = read('public', 'js', 'admin-localization.js');

describe('admin/matches.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('টেমপ্লেটে কোনো ইনলাইন হ্যান্ডলার বা <script> ব্লক নেই', () => {
    expect(matchesView).not.toMatch(HANDLER_RE);
    expect(matchesView).not.toMatch(/<script>/);
    expect(matchesView).toMatch(/<script src="\/js\/admin-matches\.js"><\/script>/);
  });

  test('অ্যাট্রিবিউটের ভেতরের DOM কলগুলো data-modal-* hook হয়েছে', () => {
    // আগে সরাসরি `document.getElementById(...).classList.remove('hidden')`
    // অ্যাট্রিবিউটের ভেতরে লেখা ছিল।
    expect(matchesView).not.toMatch(/document\.getElementById/);
    expect(count(matchesView, /data-modal-open=/g)).toBe(1);
    expect(count(matchesView, /data-modal-close=/g)).toBe(1);
  });

  test('তিনটে ফিল্টার কন্ট্রোল ও এক্সপোর্ট বাটন যুক্ত', () => {
    expect(count(matchesView, /data-match-filter/g)).toBe(3);
    expect(count(matchesView, /data-export-matches/g)).toBe(1);
    ['[data-match-filter]', '[data-export-matches]']
      .forEach((sel) => expect(matchesJs).toContain(sel));
    // মডাল hook শেয়ার করা ui-hooks.js-এ (partials/head.ejs থেকে লোড)
    const sharedJs = read('public', 'js', 'ui-hooks.js');
    ['[data-modal-open]', '[data-modal-close]'].forEach((sel) => {
      expect(sharedJs).toContain(sel);
      expect(matchesJs).not.toContain(sel);
    });
  });

  test('select-এ change, input-এ input ইভেন্ট বাঁধা হয়', () => {
    // আগে search বক্সে onkeyup ছিল, select দুটোতে onchange।
    expect(matchesJs).toMatch(/el\.tagName === 'SELECT' \? 'change' : 'input'/);
  });

  test('ডিলিট ফর্মের নিশ্চিতকরণ টিকে আছে', () => {
    expect(matchesView).toContain('data-confirm="Delete this match permanently?"');
    const sharedJs = read('public', 'js', 'ui-hooks.js');
    expect(sharedJs).toContain('form[data-confirm]');
    expect(sharedJs).toMatch(/preventDefault\(\)/);
    expect(matchesJs).not.toContain('form[data-confirm]');
  });

  test('CSV এক্সপোর্টের objectURL ছাড়া হয় (মেমরি লিক বন্ধ)', () => {
    // আগের কোড createObjectURL করত কিন্তু কখনো revoke করত না — প্রতিটা
    // এক্সপোর্টে একটা blob পেজ রিফ্রেশ পর্যন্ত মেমরিতে থেকে যেত।
    expect(matchesJs).toMatch(/URL\.revokeObjectURL\(url\)/);
  });
});

describe('admin/localization.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('টেমপ্লেটে কোনো ইনলাইন হ্যান্ডলার বা <script> ব্লক নেই', () => {
    expect(locView).not.toMatch(HANDLER_RE);
    expect(locView).not.toMatch(/<script>/);
    expect(locView).toMatch(/<script src="\/js\/admin-localization\.js"><\/script>/);
  });

  test('দুটো ভাষার ইমপোর্ট ফর্ম ও বাটন যুক্ত', () => {
    ['bn', 'en'].forEach((lang) => {
      expect(locView).toContain(`data-prep-import="${lang}"`);
      expect(locView).toContain(`data-submit-import="${lang}"`);
    });
    expect(locJs).toContain('form[data-prep-import]');
    expect(locJs).toContain('[data-submit-import]');
  });

  test('ফাইল লোড ও ক্যাশ-রিফ্রেশ hook আছে', () => {
    expect(count(locView, /data-load-file/g)).toBe(1);
    expect(count(locView, /data-loading-label=/g)).toBe(1);
    expect(locJs).toContain('[data-load-file]');
    // লোডিং লেবেল শেয়ার করা ফাইলে
    expect(read('public', 'js', 'ui-hooks.js')).toContain('[data-loading-label]');
    expect(locJs).not.toContain('[data-loading-label]');
  });

  test('prepImport ব্যর্থ হলে ফর্ম সাবমিট থামে', () => {
    // আগে `onsubmit="return prepImport('bn')"` — false ফিরলে সাবমিট থামত।
    expect(locJs).toMatch(/if \(!prepImport\(form\.getAttribute\('data-prep-import'\)\)\) e\.preventDefault\(\);/);
  });

  test('Key ডিলিটের নিশ্চিতকরণ টিকে আছে', () => {
    expect(locView).toMatch(/data-confirm="[^"]+"/);
    expect(read('public', 'js', 'ui-hooks.js')).toContain('form[data-confirm]');
    expect(locJs).not.toContain('form[data-confirm]');
  });
});

describe('নতুন স্ক্রিপ্টগুলো ইনলাইন-নির্ভরতা ফিরিয়ে আনে না', () => {
  test.each([
    ['public/js/admin-matches.js', matchesJs],
    ['public/js/admin-localization.js', locJs]
  ])('%s — eval / new Function / EJS / ইনলাইন হ্যান্ডলার নেই', (_name, src) => {
    expect(src).not.toMatch(/\beval\(/);
    expect(src).not.toMatch(/new Function\(/);
    expect(src).not.toMatch(/<%[=-]/);
    expect(src).not.toMatch(/\son(?:click|change|submit|error|load)\s*=\s*["']/);
  });
});
