const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;
const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;

const sharedJs = read('public', 'js', 'ui-hooks.js');
const profileView = read('views', 'profile', 'index.ejs');
const profileJs = read('public', 'js', 'profile-index.js');

describe('সাধারণ hook — dismiss / reload / href', () => {
  test('তিনটেই শেয়ার করা ফাইলে আছে', () => {
    ['[data-dismiss]', '[data-reload]', '[data-href]']
      .forEach((sel) => expect(sharedJs).toContain(sel));
  });

  test('data-href শুধু সাইট-অভ্যন্তরীণ পাথ মানে', () => {
    // এটাই এই hook-এর একমাত্র নিরাপত্তা-প্রশ্ন: যেকোনো মান মেনে নিলে
    // `//evil.com` বা `javascript:` দিয়ে ওপেন রিডাইরেক্ট তৈরি হত।
    expect(sharedJs).toMatch(/href\.charAt\(0\) !== '\/' \|\| href\.charAt\(1\) === '\/'/);
  });

  test('কোনো টেমপ্লেটে বাইরের data-href নেই', () => {
    const views = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ejs')) views.push(full);
      }
    })(path.join(ROOT, 'views'));

    const bad = [];
    views.forEach((f) => {
      const src = fs.readFileSync(f, 'utf8');
      const matches = src.match(/data-href="([^"]*)"/g) || [];
      matches.forEach((m) => {
        const value = /data-href="([^"]*)"/.exec(m)[1];
        if (!value.startsWith('/') || value.startsWith('//')) {
          bad.push(path.relative(ROOT, f) + ' -> ' + value);
        }
      });
    });
    expect(bad).toEqual([]);
  });

  test('data-reload কোনো পেজ-স্ক্রিপ্টে আবার বাঁধা হয় না', () => {
    const withdrawJs = read('public', 'js', 'payment-withdraw.js');
    expect(withdrawJs).not.toContain('[data-reload]');
  });
});

describe('profile/index.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('টেমপ্লেটে কোনো ইনলাইন হ্যান্ডলার বা <script> ব্লক নেই', () => {
    expect(profileView).not.toMatch(HANDLER_RE);
    expect(profileView).not.toMatch(/<script>/);
    expect(profileView).toMatch(/<script src="\/js\/profile-index\.js"><\/script>/);
  });

  test('তিনটে সার্ভার-সাইড মান JSON ব্লকে গেছে', () => {
    // আগে UID, siteName আর locale সরাসরি স্ক্রিপ্টের ভেতরে ইনজেক্ট হত।
    expect(profileView).toMatch(/<script type="application\/json" id="profileConfig">/);
    expect(profileView).toMatch(/uid: 100000 \+ user\.id/);
    expect(profileView).toMatch(/locale: lang === "bn" \? "bn-BD" : "en-US"/);
    expect(profileJs).not.toMatch(/<%[=-]/);
    expect(profileJs).toContain("getElementById('profileConfig')");
  });

  test('সাতটা অ্যাকশনই hook পেয়েছে এবং JS-এ ম্যাপ করা', () => {
    expect(count(profileView, /data-profile-action=/g)).toBe(8); // avatar-open দুবার
    ['avatar-open', 'avatar-close', 'copy-username', 'copy-uid',
     'copy-profile-url', 'share-profile-url', 'refresh-balance'].forEach((a) => {
      expect(profileView).toContain('data-profile-action="' + a + '"');
      expect(profileJs).toContain("'" + a + "'");
    });
  });

  test('অ্যাভাটার গ্রিড আর img.onclick বসায় না', () => {
    // রানটাইমে DOM প্রপার্টি সেট করা CSP ব্লক করত না, কিন্তু পুরো ফাইলে
    // একটাই প্যাটার্ন রাখতে addEventListener-এ নেওয়া হয়েছে।
    expect(profileJs).not.toMatch(/img\.onclick\s*=/);
    expect(profileJs).toMatch(/img\.addEventListener\('click'/);
  });

  test('কপি ও শেয়ারের ফলব্যাক আচরণ ধরে রাখা হয়েছে', () => {
    expect(profileJs).toMatch(/navigator\.clipboard/);
    expect(profileJs).toMatch(/document\.execCommand\('copy'\)/);
    expect(profileJs).toMatch(/navigator\.share/);
  });

  test('eval / new Function নেই', () => {
    expect(profileJs).not.toMatch(/\beval\(/);
    expect(profileJs).not.toMatch(/new Function\(/);
  });
});
