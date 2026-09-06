const fs = require('fs');
const path = require('path');

// views/profile/security.ejs থেকে ১৭টা ইনলাইন হ্যান্ডলার আর একটা ইনলাইন
// <script> ব্লক সরিয়ে /js/profile-security.js-এ নেওয়া হয়েছে (docs/CSP.md ধাপ ২)।
//
// এই ধরনের মাইগ্রেশনের আসল ঝুঁকি নীরব ভাঙন: onclick সরানো হলো কিন্তু
// addEventListener-এর selector মিলল না — পেজ দেখতে ঠিকই থাকে, বাটন কাজ করে না।
// তাই টেমপ্লেটের প্রতিটা data-* hook আর JS-এর প্রতিটা selector দুই দিক থেকে
// মিলিয়ে দেখা হয়।

const ROOT = path.join(__dirname, '..', '..');
const template = fs.readFileSync(path.join(ROOT, 'views', 'profile', 'security.ejs'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'public', 'js', 'profile-security.js'), 'utf8');

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

describe('profile/security.ejs — প্রতিটা কন্ট্রোল এখনো যুক্ত', () => {
  test('চারটে ট্যাব বাটন + স্ট্যাটাস কার্ড data-switch-tab পেয়েছে', () => {
    ['personal', 'bank', 'security', 'devices'].forEach(function (tab) {
      expect(template).toContain(`data-switch-tab="${tab}"`);
      expect(template).toContain(`id="btn-${tab}"`);
    });
    // স্ট্যাটাস কার্ডটা ডাইনামিক ট্যাব নেয়
    expect(template).toContain('data-switch-tab="<%= it.tab %>"');
    expect(count(template, /data-switch-tab=/g)).toBe(5);
  });

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

  test('মোট hook সংখ্যা আগের ১৭টা হ্যান্ডলারের সমান', () => {
    const hooks =
      count(template, /data-switch-tab=/g) +
      count(template, /data-pin-form=/g) +
      count(template, /data-pin-submit/g) +
      count(template, /data-pin-cancel/g) +
      count(template, /data-confirm=/g);
    expect(hooks).toBe(17);
  });
});

describe('profile-security.js — টেমপ্লেটের প্রতিটা hook হ্যান্ডল করে', () => {
  test('প্রতিটা data-* selector JS-এ আছে', () => {
    // পেজ-নির্দিষ্ট hook পেজের স্ক্রিপ্টে
    ['[data-switch-tab]', '[data-pin-form]', '[data-pin-cancel]', '[data-pin-submit]']
      .forEach(function (sel) {
        expect(script).toContain(sel);
      });
    // data-confirm সাইটজুড়ে শেয়ার করা public/js/ui-hooks.js সামলায়
    // (partials/head.ejs থেকে লোড হয়)। পেজেও থাকলে confirm দুবার দেখাত।
    const sharedJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ui-hooks.js'), 'utf8');
    expect(sharedJs).toContain('form[data-confirm]');
    expect(script).not.toContain('form[data-confirm]');
  });

  test('আগের ফাংশনগুলোর আচরণ ধরে রাখা হয়েছে', () => {
    expect(script).toMatch(/function switchTab/);
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
