const fs = require('fs');
const path = require('path');

// views/admin/kyc.ejs থেকে ১৪টা ইনলাইন হ্যান্ডলার ও একটা ইনলাইন <script>
// ব্লক সরিয়ে /js/admin-kyc.js-এ নেওয়া হয়েছে (docs/CSP.md ধাপ ২)।
//
// এই পেজে দুটো আলাদা ঝুঁকি ছিল, তাই আলাদা করে যাচাই করা হয়:
//
// ১. আগে গোটা KYC অবজেক্টটা `onclick='viewKyc(<%- jsonScriptSafe(k) %>)'`
//    হিসেবে HTML অ্যাট্রিবিউটের ভেতরে বসত। jsonScriptSafe() `<`, `>`, `&`
//    escape করে কিন্তু উদ্ধৃতিচিহ্ন নয় — নাম বা ঠিকানায় একটা apostrophe
//    থাকলেই অ্যাট্রিবিউট ভেঙে যেত। ডেটা এখন অ্যাট্রিবিউটে নেই।
//
// ২. viewKyc() innerHTML দিয়ে `onerror="..."` সহ <img> বসাত — রানটাইমে
//    তৈরি হওয়া ইনলাইন হ্যান্ডলার, যা script-src-attr 'none' এ ব্লক হত।

const ROOT = path.join(__dirname, '..', '..');
const template = fs.readFileSync(path.join(ROOT, 'views', 'admin', 'kyc.ejs'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin-kyc.js'), 'utf8');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;

describe('admin/kyc.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('কোনো ইনলাইন ইভেন্ট হ্যান্ডলার নেই', () => {
    expect(template).not.toMatch(/\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/);
  });

  test('কোনো executable ইনলাইন <script> ব্লক নেই', () => {
    expect(template).not.toMatch(/<script>/);
  });

  test('বাইরের স্ক্রিপ্ট ফাইলটা লোড হয়', () => {
    expect(template).toMatch(/<script src="\/js\/admin-kyc\.js"><\/script>/);
  });
});

describe('admin/kyc.ejs — ডেটা আর অ্যাট্রিবিউটে যায় না', () => {
  test('KYC অবজেক্ট JSON ডেটা ব্লকে আছে, onclick-এ নয়', () => {
    expect(template).toMatch(/<script type="application\/json" id="kycData">/);
    expect(template).toMatch(/<script type="application\/json" id="kycConfig">/);
    // পুরনো প্যাটার্নটা ফিরে আসেনি
    expect(template).not.toMatch(/onclick=['"]viewKyc\(/);
  });

  test('বিস্তারিত বাটন শুধু id বহন করে', () => {
    expect(template).toContain('data-kyc-view="<%= k.id %>"');
    // অ্যাট্রিবিউটের ভেতরে jsonScriptSafe আর ব্যবহার হয় না
    const attrJson = /data-[a-z-]+=['"]<%- jsonScriptSafe/.test(template);
    expect(attrJson).toBe(false);
  });

  test('JS ডেটা ব্লক থেকে পড়ে, id দিয়ে লুকআপ করে', () => {
    expect(script).toMatch(/getElementById\(id\)/);
    expect(script).toContain("readJsonBlock('kycData')");
    expect(script).toContain("readJsonBlock('kycConfig')");
    expect(script).toMatch(/kycById\[/);
  });
});

describe('admin/kyc.ejs — প্রতিটা কন্ট্রোল এখনো যুক্ত', () => {
  test('সারি-প্রতি অ্যাকশনের hook আছে', () => {
    expect(template).toContain('data-kyc-view="<%= k.id %>"');
    expect(template).toContain('data-kyc-approve="<%= k.id %>"');
    expect(template).toContain('data-kyc-reject="<%= k.id %>"');
  });

  test('বাল্ক অ্যাকশন ও ফিল্টারের hook আছে', () => {
    ['data-kyc-bulk-approve', 'data-kyc-bulk-reject', 'data-kyc-clear-selection', 'data-auto-submit']
      .forEach(function (hook) { expect(template).toContain(hook); });
  });

  test('পাঁচটা মডাল-বন্ধ বাটনই data-close-modal পেয়েছে', () => {
    expect(count(template, /data-modal-close=/g)).toBe(5);
    ['viewModal', 'rejectModal', 'bulkRejectModal'].forEach(function (id) {
      expect(template).toContain(`data-modal-close="${id}"`);
    });
  });

  test('চেকবক্স দুটো class/id দিয়েই ধরা হয়', () => {
    expect(template).toContain('class="kyc-row-check"');
    expect(template).toContain('id="kycSelectAll"');
    expect(script).toContain('.kyc-row-check');
    expect(script).toContain("getElementById('kycSelectAll')");
  });

  test('টেমপ্লেটের প্রতিটা data-* hook JS-এ হ্যান্ডল হয়', () => {
    // পেজ-নির্দিষ্ট hook পেজের স্ক্রিপ্টে
    ['[data-kyc-view]', '[data-kyc-approve]', '[data-kyc-reject]',
     '[data-kyc-bulk-approve]', '[data-kyc-bulk-reject]', '[data-kyc-clear-selection]']
      .forEach(function (sel) { expect(script).toContain(sel); });
    // সাধারণ hook শেয়ার করা ফাইলে, পেজে নয় (দ্বৈত হ্যান্ডলার এড়াতে)
    const sharedJs = read('public', 'js', 'ui-hooks.js');
    ['[data-auto-submit]', '[data-modal-close]'].forEach(function (sel) {
      expect(sharedJs).toContain(sel);
      expect(script).not.toContain(sel);
    });
  });

  test('দুটো নিশ্চিতকরণ বাটন এখনো যুক্ত', () => {
    expect(template).toContain('id="confirmRejectBtn"');
    expect(template).toContain('id="confirmBulkRejectBtn"');
    expect(script).toContain("getElementById('confirmRejectBtn')");
    expect(script).toContain("getElementById('confirmBulkRejectBtn')");
  });
});

describe('admin-kyc.js — রানটাইমে ইনলাইন হ্যান্ডলার তৈরি করে না', () => {
  test('innerHTML দিয়ে onerror বসানো হয় না', () => {
    expect(script).not.toMatch(/onerror\s*=\s*["']/);
    expect(script).not.toMatch(/onerror=\\?["']/);
  });

  test('ডকুমেন্ট প্রিভিউ DOM API দিয়ে বানানো হয়, error হ্যান্ডলার addEventListener-এ', () => {
    expect(script).toMatch(/createElement\('img'\)/);
    expect(script).toMatch(/img\.addEventListener\('error'/);
  });

  test('ডকুমেন্ট URL এখনো সার্ভার-প্রক্সি — Cloudinary URL সরাসরি নয়', () => {
    expect(script).toMatch(/'\/admin\/kyc\/' \+ encodeURIComponent\(k\.id\) \+ '\/document'/);
    expect(script).not.toMatch(/res\.cloudinary\.com/);
  });

  test('eval / new Function ব্যবহার হয় না', () => {
    expect(script).not.toMatch(/\beval\(/);
    expect(script).not.toMatch(/new Function\(/);
  });
});
