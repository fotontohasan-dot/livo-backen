const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;
const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

const VIEWS = walk(path.join(ROOT, 'views'));

// ==================== CSRF ইনজেক্টর ====================
// একই CSRF-ইনজেকশন কোড হুবহু ১০টা টেমপ্লেটে কপি করা ছিল। একটা কপিতে বাগ
// ঠিক করে বাকি ন'টা ভুলে যাওয়ার ঝুঁকি ছিল — CSRF-এ সেটা নীরব ছিদ্র।
// এখন public/js/csrf-inject.js একটাই উৎস।

describe('CSRF ইনজেক্টর — একটাই কপি', () => {
  test('কোনো টেমপ্লেটে ইনলাইন কপি ফিরে আসেনি', () => {
    const offenders = VIEWS
      .filter((f) => /injectIntoForms/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  test('১০টা টেমপ্লেটই শেয়ার করা ফাইলটা লোড করে', () => {
    const users = VIEWS.filter((f) => /\/js\/csrf-inject\.js/.test(fs.readFileSync(f, 'utf8')));
    expect(users.length).toBe(10);
  });

  test('দুর্বল সংস্করণটা নয় — শক্তিশালীটাই রাখা হয়েছে', () => {
    // ১০ কপির ন'টায় same-origin যাচাই ছিল না; শুধু head.ejs-এ ছিল।
    // যেকোনো একটাকে "canonical" ধরে নিলে টোকেন ক্রস-অরিজিনে ফাঁস হত।
    const js = read('public', 'js', 'csrf-inject.js');
    expect(js).toMatch(/function isSameOrigin/);
    expect(js).toMatch(/isSameOrigin\(url\)/);
    expect(js).toMatch(/_csrfSameOrigin/);
  });

  test('শেয়ার করা ফাইলটার আচরণ অক্ষত', () => {
    const js = read('public', 'js', 'csrf-inject.js');
    // ফর্মে hidden ইনপুট
    expect(js).toMatch(/input\.name = '_csrf'/);
    // fetch ও XHR দুটোতেই হেডার
    expect(js).toMatch(/X-CSRF-Token/);
    expect(js).toMatch(/window\.fetch = function/);
    expect(js).toMatch(/XMLHttpRequest\.prototype\.send/);
    // ডাইনামিকভাবে যোগ হওয়া ফর্মও ধরা পড়ে
    expect(js).toMatch(/MutationObserver/);
    // টোকেন meta ট্যাগ থেকেই আসে — কোনো সার্ভার-সাইড ইন্টারপোলেশন নেই
    expect(js).toMatch(/meta\[name="csrf-token"\]/);
    expect(js).not.toMatch(/<%[=-]/);
  });
});

// ==================== payment/admin.ejs ====================

describe('payment/admin.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  const view = read('views', 'payment', 'admin.ejs');
  const js = read('public', 'js', 'payment-admin.js');

  test('টেমপ্লেটে কোনো ইনলাইন হ্যান্ডলার বা <script> ব্লক নেই', () => {
    expect(view).not.toMatch(HANDLER_RE);
    expect(view).not.toMatch(/<script>/);
  });

  test('ডেটা JSON ব্লকে, স্ক্রিপ্ট বাইরের ফাইলে', () => {
    expect(view).toMatch(/<script type="application\/json" id="paymentRequests">/);
    expect(view).toMatch(/<script src="\/js\/payment-admin\.js"><\/script>/);
    expect(js).toContain("readJsonBlock('paymentRequests')");
    expect(js).not.toMatch(/<%[=-]/);
  });

  test('ট্যাব, বাল্ক ও সিলেক্ট-অল hook আছে', () => {
    expect(count(view, /data-pay-tab=/g)).toBe(2);
    expect(count(view, /data-pay-bulk=/g)).toBe(2);
    expect(count(view, /data-pay-clear/g)).toBe(1);
    expect(count(view, /pay-select-all/g)).toBe(2);
    ['[data-pay-tab]', '[data-pay-bulk]', '[data-pay-clear]', '.pay-select-all']
      .forEach((sel) => expect(js).toContain(sel));
  });

  test('রানটাইমে তৈরি সারির কন্ট্রোল ডেলিগেশনে ধরা হয়', () => {
    // renderRows() প্রতিবার নতুন করে সারি বানায়। আগে ওখানেই
    // ইনলাইন হ্যান্ডলার স্ট্রিং জোড়া দেওয়া হত; এখন ডকুমেন্ট-লেভেল লিসেনার।
    expect(js).not.toMatch(/\son(?:click|change|submit)=\\?["']/);
    expect(js).toMatch(/document\.addEventListener\('change'/);
    expect(js).toMatch(/document\.addEventListener\('submit'/);
    expect(js).toMatch(/classList\.contains\('pay-row-check'\)/);
    expect(js).toMatch(/form\[data-confirm\]/);
  });

  test('বাল্ক অ্যাকশনের নিশ্চিতকরণ ও খালি-নির্বাচন গার্ড টিকে আছে', () => {
    expect(js).toMatch(/if \(ids\.length === 0\) return;/);
    expect(js).toMatch(/window\.confirm\(|confirm\(/);
  });

  test('eval / new Function নেই', () => {
    expect(js).not.toMatch(/\beval\(/);
    expect(js).not.toMatch(/new Function\(/);
  });
});
