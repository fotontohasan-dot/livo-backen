const fs = require('fs');
const path = require('path');

// docs/CSP.md ধাপ ২-এর তৃতীয় ও চতুর্থ স্লাইস:
//   views/profile/chat.ejs  — ১৫টা হ্যান্ডলার (১০টা টেমপ্লেটে, ৫টা রানটাইমে)
//   views/admin/games.ejs   — ১১টা হ্যান্ডলার
//
// দুটো ফাইলেই আসল ঝুঁকি ছিল রানটাইমে HTML স্ট্রিং জোড়া দিয়ে হ্যান্ডলার
// তৈরি করা — টেমপ্লেট গ্রেপ করলে ওগুলোর কিছু ধরা পড়ে, কিছু পড়ে না।
// তাই এখানে টেমপ্লেট আর JS দুই দিকেই যাচাই।

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const chatView = read('views', 'profile', 'chat.ejs');
const chatJs = read('public', 'js', 'profile-chat.js');
const gamesView = read('views', 'admin', 'games.ejs');
const gamesJs = read('public', 'js', 'admin-games.js');

const count = (src, re) => (src.match(re) || []).length;
const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;

describe('profile/chat.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('টেমপ্লেটে কোনো ইনলাইন হ্যান্ডলার বা <script> ব্লক নেই', () => {
    expect(chatView).not.toMatch(HANDLER_RE);
    expect(chatView).not.toMatch(/<script>/);
  });

  test('config JSON ব্লক ও বাইরের স্ক্রিপ্ট আছে', () => {
    expect(chatView).toMatch(/<script type="application\/json" id="chatConfig">/);
    expect(chatView).toMatch(/<script src="\/js\/profile-chat\.js"><\/script>/);
  });

  test('কুইক-মেসেজ চিপগুলো data-quick-msg পেয়েছে', () => {
    expect(count(chatView, /data-quick-msg=/g)).toBe(7);
    expect(chatJs).toContain('[data-quick-msg]');
  });

  test('মোড টগল ও ফাইল-বাতিল hook আছে', () => {
    expect(count(chatView, /data-chat-mode=/g)).toBe(2);
    expect(chatView).toContain('data-chat-mode="bot"');
    expect(chatView).toContain('data-chat-mode="agent"');
    expect(count(chatView, /data-clear-file/g)).toBe(1);
    expect(chatJs).toContain('[data-chat-mode]');
    expect(chatJs).toContain('[data-clear-file]');
  });

  test('welcome কার্ডের বাটনগুলো আর innerHTML স্ট্রিং থেকে আসে না', () => {
    // আগে পাঁচটা বাটন `onclick="sendQuickMessage('...')"` সহ একটা টেমপ্লেট
    // লিটারেলে জোড়া দেওয়া হত — রানটাইমে তৈরি ইনলাইন হ্যান্ডলার।
    expect(chatJs).not.toMatch(/onclick=/);
    expect(chatJs).toMatch(/createElement\('button'\)/);
    expect(chatJs).toMatch(/btn\.addEventListener\('click'/);
  });

  test('সার্ভার-সাইড মান JSON ব্লক থেকে পড়া হয়, স্ক্রিপ্টে ইনজেক্ট হয় না', () => {
    expect(chatJs).toContain("getElementById('chatConfig')");
    expect(chatJs).not.toMatch(/<%[=-]/);
  });

  test('কনটেন্ট ফিল্টার ও সকেট আচরণ ধরে রাখা হয়েছে', () => {
    expect(chatJs).toMatch(/contentFilterIsBad/);
    expect(chatJs).toMatch(/attachContentFilter/);
    expect(chatJs).toMatch(/socket\.on\('message_blocked'/);
    expect(chatJs).toMatch(/socket\.on\('new_message'/);
    expect(chatJs).toMatch(/socket\.emit\('send_message'/);
  });
});

describe('admin/games.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('টেমপ্লেটে কোনো ইনলাইন হ্যান্ডলার বা <script> ব্লক নেই', () => {
    expect(gamesView).not.toMatch(HANDLER_RE);
    expect(gamesView).not.toMatch(/<script>/);
  });

  test('গেম ডেটা JSON ব্লকে, বাইরের স্ক্রিপ্ট লোড হয়', () => {
    expect(gamesView).toMatch(/<script type="application\/json" id="gamesData">/);
    expect(gamesView).toMatch(/<script src="\/js\/admin-games\.js"><\/script>/);
  });

  test('ভঙ্গুর safeEdit স্ট্রিং-জোড়া প্যাটার্নটা আর নেই', () => {
    // আগে সাতটা ফিল্ড `','` দিয়ে জুড়ে onclick-এ বসত; নামে একটা apostrophe
    // থাকলেই আর্গুমেন্ট তালিকা ভেঙে যেত।
    expect(gamesView).not.toMatch(/safeEdit/);
    expect(gamesView).not.toMatch(/openEdit\(/);
    expect(gamesView).toContain('data-edit-game=');
    expect(gamesJs).toContain('[data-edit-game]');
  });

  test('মডাল, বাল্ক, সিলেক্ট-অল ও ডিলিট hook আছে', () => {
    expect(count(gamesView, /data-modal-open=/g)).toBe(1);
    expect(count(gamesView, /data-modal-close=/g)).toBe(4);
    expect(count(gamesView, /data-bulk-action=/g)).toBe(2);
    expect(count(gamesView, /data-toggle-all/g)).toBe(1);
    expect(gamesView).toMatch(/data-confirm=/);
    // গেম-নির্দিষ্ট hook গুলো পেজের নিজস্ব স্ক্রিপ্টে
    ['[data-bulk-action]', '[data-toggle-all]'].forEach(function (sel) {
      expect(gamesJs).toContain(sel);
    });
    // সাধারণ hook গুলো শেয়ার করা ফাইলে (admin-layout থেকে লোড হয়)।
    // পেজ-স্ক্রিপ্টে আবারও থাকলে হ্যান্ডলার দুবার চলত — confirm দুবার
    // দেখাত, ফর্ম দুবার সাবমিট হত। তাই দুই দিক থেকেই যাচাই।
    const sharedJs = read('public', 'js', 'ui-hooks.js');
    ['[data-modal-open]', '[data-modal-close]', '[data-auto-submit]', 'form[data-confirm]']
      .forEach(function (sel) {
        expect(sharedJs).toContain(sel);
        expect(gamesJs).not.toContain(sel);
      });
  });

  test('বাল্ক অ্যাকশনের নিরাপত্তা-প্রশ্ন দুটো টিকে আছে', () => {
    // নির্বাচন খালি হলে থামা, আর নিশ্চিতকরণ — দুটোই আগে ছিল
    expect(gamesJs).toMatch(/if \(!checked\.length\)/);
    expect(gamesJs).toMatch(/window\.confirm\(/);
  });
});

describe('নতুন স্ক্রিপ্টগুলো ইনলাইন-নির্ভরতা ফিরিয়ে আনে না', () => {
  test.each([
    ['public/js/profile-chat.js', chatJs],
    ['public/js/admin-games.js', gamesJs]
  ])('%s — eval / new Function / ইনলাইন হ্যান্ডলার স্ট্রিং নেই', (_name, src) => {
    expect(src).not.toMatch(/\beval\(/);
    expect(src).not.toMatch(/new Function\(/);
    expect(src).not.toMatch(/\son(?:click|change|submit|error|load)\s*=\s*["']/);
  });
});
