const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;
const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;

const sharedJs = read('public', 'js', 'ui-hooks.js');
const layout = read('views', 'admin', 'partials', 'admin-layout.ejs');
const withdrawView = read('views', 'payment', 'withdraw.ejs');
const withdrawJs = read('public', 'js', 'payment-withdraw.js');
const userDetail = read('views', 'admin', 'user-detail.ejs');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ==================== শেয়ার করা অ্যাডমিন hook ====================
// একই চারটে প্যাটার্ন (মডাল খোলা/বন্ধ, auto-submit, confirm) পেজে পেজে
// বারবার লেখা হচ্ছিল। CSRF ইনজেক্টরের অভিজ্ঞতা বলছে কপিগুলো সময়ের সাথে
// আলাদা হয়ে যায়, তাই একটাই বাস্তবায়ন — admin-layout থেকে লোড।

describe('শেয়ার করা অ্যাডমিন UI hook', () => {
  test('admin-layout থেকে লোড হয়', () => {
    expect(layout).toMatch(/<script src="\/js\/ui-hooks\.js"><\/script>/);
  });

  test('চারটে সাধারণ hook-ই সামলায়', () => {
    ['[data-modal-open]', '[data-modal-close]', '[data-auto-submit]', 'form[data-confirm]']
      .forEach((sel) => expect(sharedJs).toContain(sel));
  });

  test('দুই মডাল কনভেনশনই সামলায় (hidden ও show)', () => {
    // কোডবেসে দুটোই আছে: কিছু মডাল `hidden` ক্লাসে লুকায়, কিছু `show`-তে দেখায়।
    expect(sharedJs).toMatch(/classList\.remove\('hidden'\)/);
    expect(sharedJs).toMatch(/classList\.add\('show'\)/);
    expect(sharedJs).toMatch(/classList\.add\('hidden'\)/);
    expect(sharedJs).toMatch(/classList\.remove\('show'\)/);
  });

  test('confirm ডেলিগেশনে — রানটাইমে বানানো সারির ফর্মও ধরা পড়ে', () => {
    expect(sharedJs).toMatch(/document\.addEventListener\('submit'/);
  });

  test('কোনো পেজ-স্ক্রিপ্ট এই চারটে আবার বাঁধে না (দ্বৈত হ্যান্ডলার নয়)', () => {
    // দুবার বাঁধলে confirm দুবার দেখাত এবং ফর্ম দুবার সাবমিট হত।
    const offenders = walk(path.join(ROOT, 'public', 'js'))
      .filter((f) => path.basename(f) !== 'ui-hooks.js')
      .filter((f) => {
        const src = fs.readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
        return /querySelectorAll\('\[data-modal-(open|close)\]'\)/.test(src)
          || /querySelectorAll\('\[data-auto-submit\]'\)/.test(src)
          || /querySelectorAll\('form\[data-confirm\]'\)/.test(src);
      })
      .map((f) => path.relative(ROOT, f));

    // এখন public/js/ui-hooks.js দুটো লেআউট (partials/head.ejs ও
    // admin-layout.ejs) থেকেই লোড হয়, তাই কার্যত প্রতিটা পেজ এগুলো পায়।
    // ফলে কোনো পেজ-স্ক্রিপ্টেরই আর নিজে বাঁধার দরকার নেই — বাঁধলে
    // হ্যান্ডলার দুবার চলত।
    expect(offenders).toEqual([]);
  });

  test('দুই লেআউটই শেয়ার করা ফাইলটা লোড করে', () => {
    expect(layout).toMatch(/<script src="\/js\/ui-hooks\.js"><\/script>/);
    const head = read('views', 'partials', 'head.ejs');
    expect(head).toMatch(/<script src="\/js\/ui-hooks\.js" defer><\/script>/);
  });

  test('প্রতিটা data-confirm ব্যবহারকারী টেমপ্লেট ui-hooks.js পায়', () => {
    // লেআউট না পেলে confirm চুপচাপ কাজ করত না — ধ্বংসাত্মক ফর্ম
    // নিশ্চিতকরণ ছাড়াই সাবমিট হয়ে যেত। তাই এটাই আসল গার্ড।
    const views = [];
    (function walkViews(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkViews(full);
        else if (e.name.endsWith('.ejs')) views.push(full);
      }
    })(path.join(ROOT, 'views'));

    const orphans = views
      .filter((f) => /data-confirm=/.test(fs.readFileSync(f, 'utf8')))
      .filter((f) => {
        const src = fs.readFileSync(f, 'utf8');
        // দুই লেআউটের যেকোনোটা, অথবা সরাসরি স্ক্রিপ্ট ট্যাগ — তিনটেই বৈধ।
        // কয়েকটা স্ট্যান্ডঅ্যালোন অ্যাডমিন পেজ (2fa-*, login) কোনো লেআউট
        // ব্যবহার করে না, তাই ওরা ui-hooks.js সরাসরি লোড করে।
        return !/partials\/head/.test(src)
          && !/partials\/admin-layout/.test(src)
          && !/\/js\/ui-hooks\.js/.test(src);
      })
      .map((f) => path.relative(ROOT, f));

    expect(orphans).toEqual([]);
  });

});

// ==================== payment/withdraw.ejs ====================

describe('payment/withdraw.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('টেমপ্লেটে কোনো ইনলাইন হ্যান্ডলার বা <script> ব্লক নেই', () => {
    expect(withdrawView).not.toMatch(HANDLER_RE);
    expect(withdrawView).not.toMatch(/<script>/);
    expect(withdrawView).toMatch(/<script src="\/js\/payment-withdraw\.js"><\/script>/);
  });

  test('দুটো reveal টগলই লক্ষ্য এলিমেন্ট data-* থেকে নেয়', () => {
    expect(withdrawView).toContain('data-reveal-field="secPassword"');
    expect(withdrawView).toContain('data-reveal-icon="eyeIcon"');
    expect(withdrawView).toContain('data-reveal-field="withdrawPinField"');
    expect(withdrawView).toContain('data-reveal-icon="withdrawPinEye"');
    expect(count(withdrawView, /data-reveal-field=/g)).toBe(2);
    expect(withdrawJs).toContain('[data-reveal-field]');
  });

  test('ওয়ালেট সিঙ্ক hidden ফিল্ড দুটোই ভরে', () => {
    expect(withdrawView).toMatch(/data-sync-wallet/);
    expect(withdrawJs).toMatch(/getElementById\('methodField'\)/);
    expect(withdrawJs).toMatch(/getElementById\('accountNumberField'\)/);
  });

  test('সাবমিটে লোডিং স্টেট ও নিশ্চিতকরণ টিকে আছে', () => {
    expect(withdrawView).toContain('data-loading-target="withdrawSubmitBtn"');
    expect(withdrawView).toMatch(/data-loading-label="[^"]+"/);
    expect(withdrawView).toMatch(/data-confirm="[^"]+"/);
    // লোডিং স্টেট ও confirm দুটোই শেয়ার করা ui-hooks.js সামলায়
    expect(sharedJs).toContain('form[data-loading-target]');
    expect(sharedJs).toContain('form[data-confirm]');
    expect(withdrawJs).not.toContain('form[data-loading-target]');
    expect(withdrawJs).not.toContain('form[data-confirm]');
  });

  test('LivoToast না থাকলেও সাবমিট ভাঙে না', () => {
    // আগে `onsubmit="LivoToast.setLoading(...)"` — LivoToast না থাকলে
    // TypeError হয়ে সাবমিট আটকে যেত।
    expect(sharedJs).toMatch(/if \(btn && window\.LivoToast\)/);
  });
});

// ==================== admin/user-detail.ejs ====================

describe('admin/user-detail.ejs — ইনলাইন কোড সরানো হয়েছে', () => {
  test('কোনো ইনলাইন হ্যান্ডলার নেই', () => {
    expect(userDetail).not.toMatch(HANDLER_RE);
    expect(userDetail).not.toMatch(/document\.getElementById/);
  });

  test('তিনটে ধ্বংসাত্মক অ্যাকশনেই নিশ্চিতকরণ টিকে আছে', () => {
    // ব্যান, Withdraw PIN রিসেট, ইউজার ডিলিট — তিনটেই অপরিবর্তনীয় বা
    // ব্যয়বহুল, তাই confirm হারিয়ে গেলে চুপচাপ ক্ষতি হত।
    expect(count(userDetail, /data-confirm=/g)).toBe(3);
    expect(userDetail).toMatch(/data-confirm="\$\{banLabel\} করবেন\?"/);
    expect(userDetail).toMatch(/Withdraw PIN রিসেট করবেন\?/);
    expect(userDetail).toMatch(/স্থায়ীভাবে ডিলিট করবেন\?/);
  });

  test('মডাল hook আছে — নিজস্ব স্ক্রিপ্ট ফাইল লাগেনি', () => {
    expect(count(userDetail, /data-modal-open=/g)).toBe(1);
    expect(count(userDetail, /data-modal-close=/g)).toBe(2);
    // admin-layout ব্যবহার করে, তাই শেয়ার করা hook-ই যথেষ্ট
    expect(userDetail).toMatch(/partials\/admin-layout/);
    expect(userDetail).not.toMatch(/<script src="\/js\/admin-user-detail/);
  });
});
