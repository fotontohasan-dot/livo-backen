const fs = require('fs');
const path = require('path');

// views/profile/security.ejs থেকে ১৭টা ইনলাইন হ্যান্ডলার আর একটা ইনলাইন
// <script> ব্লক সরিয়ে /js/profile-security.js-এ নেওয়া হয়েছে (docs/CSP.md ধাপ ২)।
//
// পরে ট্যাব-সুইচিং (data-switch-tab + JS-চালিত show/hide) সরিয়ে আসল
// সার্ভার-রেন্ডারড পেজ নেভিগেশন (/profile/security/:tab) দিয়ে বদলানো হয়েছে —
// প্রতিটা ট্যাব/চেকলিস্ট আইটেম এখন আসল <a href> লিংক, ক্লিক করলে পুরো পেজ
// রিলোড হয়ে সার্ভার থেকে activeTab অনুযায়ী সঠিক সেকশন খোলা অবস্থায় আসে।
// রাউটার routes/profile.js-এ।
//
// এই ধরনের মাইগ্রেশনের আসল ঝুঁকি নীরব ভাঙন: hook সরানো হলো কিন্তু বাকি
// রেফারেন্স (JS selector, redirect টার্গেট) মিলল না — পেজ দেখতে ঠিকই থাকে,
// বাটন কাজ করে না। তাই টেমপ্লেটের প্রতিটা data-* hook আর JS-এর প্রতিটা
// selector দুই দিক থেকে মিলিয়ে দেখা হয়।

const ROOT = path.join(__dirname, '..', '..');
const template = fs.readFileSync(path.join(ROOT, 'views', 'profile', 'security.ejs'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'public', 'js', 'profile-security.js'), 'utf8');
const routes = fs.readFileSync(path.join(ROOT, 'routes', 'profile.js'), 'utf8');

const count = (src, re) => (src.match(re) || []).length;

describe('profile/security.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('কোনো ইনলাইন ইভেন্ট হ্যান্ডলার নেই', () => {
    expect(template).not.toMatch(/\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/);
  });

  test('কোনো ইনলাইন <script> ব্লক নেই', () => {
    expect(template).not.toMatch(/<script>/);
  });

  test('বাইরের স্ক্রিপ্ট ফাইলটা লোড হয়', () => {
    expect(template).toMatch(/<script src="\/js\/profile-security\.js"><\/script>/);
  });
});

describe('profile/security.ejs — ট্যাব এখন আসল পেজ লিংক (data-switch-tab নয়)', () => {
  test('data-switch-tab আর টেমপ্লেটে নেই — সব বাদ দেওয়া হয়েছে', () => {
    expect(template).not.toMatch(/data-switch-tab=/);
  });

  test('চারটে ট্যাব বাটন /profile/security/:tab এ লিংক করে', () => {
    ['personal', 'bank', 'security', 'devices'].forEach(function (tab) {
      expect(template).toContain(`href="/profile/security/${tab}"`);
      expect(template).toContain(`id="btn-${tab}"`);
    });
  });

  test('অ্যাক্টিভ ট্যাব সার্ভার-সাইড activeTab ভেরিয়েবল থেকে ঠিক হয়', () => {
    expect(template).toContain("activeTab === 'personal'");
    expect(template).toContain("activeTab === 'bank'");
    expect(template).toContain("activeTab === 'security'");
    expect(template).toContain("activeTab === 'devices'");
  });

  test('চেকলিস্ট আইটেমগুলো (tab kind) আসল href দিয়ে সংশ্লিষ্ট পেজে যায়', () => {
    expect(template).toContain('href="/profile/security/<%= it.target %>"');
  });
});

describe('routes/profile.js — /security/:tab রাউট ও রিডাইরেক্ট টার্গেট', () => {
  test('GET /security/:tab? রাউট আছে, বৈধ ট্যাব লিস্ট আছে', () => {
    expect(routes).toMatch(/router\.get\('\/security\/:tab\?'/);
    expect(routes).toContain("SECURITY_TABS");
  });

  test('personal/bank/security/devices — প্রতিটা POST হ্যান্ডলার নিজের ট্যাবে redirect করে', () => {
    expect(routes).toContain("res.redirect('/profile/security/personal')");
    expect(routes).toContain("res.redirect('/profile/security/bank')");
    expect(routes).toContain("res.redirect('/profile/security/login-password')");
    expect(routes).toContain("res.redirect('/profile/security/devices')");
  });

  test('কোনো হ্যান্ডলার আর /profile/security (ট্যাব ছাড়া) এ redirect করে না', () => {
    expect(routes).not.toMatch(/redirect\('\/profile\/security'\)/);
  });
});

describe('profile/security.ejs — বাকি প্রতিটা কন্ট্রোল এখনো যুক্ত', () => {
  test('তিনটে PIN ফর্ম খোলার বাটন data-pin-form পেয়েছে', () => {
    ['create', 'change', 'reset'].forEach(function (type) {
      expect(template).toContain(`data-pin-form="${type}"`);
      // JS `pinForm` + type দিয়ে element খোঁজে, তাই id গুলো থাকতেই হবে
      expect(template).toContain(`id="pinForm${type}"`);
    });
    expect(count(template, /data-pin-form=/g)).toBe(3);
  });

  test('তিনটে PIN ফর্মেই সাবমিট hook আছে, তিনটে বাতিল বাটনেই cancel hook', () => {
    expect(count(template, /data-pin-submit/g)).toBe(3);
    expect(count(template, /data-pin-cancel/g)).toBe(3);
  });

  test('নিশ্চিতকরণ ফর্মগুলো data-confirm পেয়েছে — বার্তা হারায়নি', () => {
    expect(template).toContain('data-confirm="<%= t.delete_card_confirm %>"');
    expect(template).toContain('data-confirm="<%= t.logout_device_confirm %>"');
    expect(template).toContain('data-confirm="<%= t.logout_all_confirm %>"');
    expect(count(template, /data-confirm=/g)).toBe(3);
  });

  test('মোট JS-hook সংখ্যা (ট্যাব-সুইচ বাদে) আগের মতোই ধরে রাখা হয়েছে', () => {
    const hooks =
      count(template, /data-pin-form=/g) +
      count(template, /data-pin-submit/g) +
      count(template, /data-pin-cancel/g) +
      count(template, /data-confirm=/g);
    expect(hooks).toBe(12);
  });
});

describe('profile-security.js — টেমপ্লেটের প্রতিটা hook হ্যান্ডল করে', () => {
  test('প্রতিটা data-* selector JS-এ আছে', () => {
    // পেজ-নির্দিষ্ট hook পেজের স্ক্রিপ্টে
    ['[data-pin-form]', '[data-pin-cancel]', '[data-pin-submit]']
      .forEach(function (sel) {
        expect(script).toContain(sel);
      });
    // data-confirm সাইটজুড়ে শেয়ার করা public/js/ui-hooks.js সামলায়
    // (partials/head.ejs থেকে লোড হয়)। পেজেও থাকলে confirm দুবার দেখাত।
    const sharedJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ui-hooks.js'), 'utf8');
    expect(sharedJs).toContain('form[data-confirm]');
    expect(script).not.toContain('form[data-confirm]');
  });

  test('switchTab আর নেই — ট্যাব এখন সার্ভার নেভিগেশন দিয়ে হয়', () => {
    expect(script).not.toMatch(/function switchTab/);
  });

  test('PIN ফর্মের ফাংশনগুলোর আচরণ ধরে রাখা হয়েছে', () => {
    expect(script).toMatch(/function showPinForm/);
    expect(script).toMatch(/function hidePinForms/);
    expect(script).toMatch(/function handlePinSubmit/);
    // confirm বাতিল করলে সাবমিট থামতে হবে — আগের `return confirm(...)`-এর
    // সমতুল্য। যুক্তিটা এখন শেয়ার করা ui-hooks.js-এ।
    const shared = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ui-hooks.js'), 'utf8');
    expect(shared).toMatch(/preventDefault\(\)/);
  });

  test('DOM প্রস্তুত হওয়ার আগে চললেও init হয়', () => {
    expect(script).toMatch(/DOMContentLoaded/);
    expect(script).toMatch(/document\.readyState/);
  });

  test('স্ক্রিপ্টে নতুন করে ইনলাইন-নির্ভরতা ঢোকেনি', () => {
    expect(script).not.toMatch(/\beval\(/);
    expect(script).not.toMatch(/new Function\(/);
    expect(script).not.toMatch(/\.innerHTML\s*=/);
  });
});
