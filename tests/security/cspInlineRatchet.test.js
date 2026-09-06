const fs = require('fs');
const path = require('path');

// ==================== CSP ইনলাইন র‍্যাচেট ====================
// docs/CSP.md-এর মাইগ্রেশন লম্বা: ২৫০টা ইনলাইন ইভেন্ট হ্যান্ডলার (৮০ ফাইলে)
// আর ২৭৩টা ইনলাইন `<script>` ব্লক (১৯০ ফাইলে)। এতগুলো একসাথে সরানো যায় না,
// আর যতদিন সরছে ততদিনে নতুন ইনলাইন কোড যোগ হলে কাজটা কখনো শেষ হবে না।
//
// এই টেস্ট সেই সমস্যাটাই আটকায়: বর্তমান সংখ্যাটাই সর্বোচ্চ সীমা। সংখ্যা
// কমলে টেস্ট পাস করে (আর মনে করিয়ে দেয় সীমাটা নামিয়ে আনতে); বাড়লে ফেল।
// অর্থাৎ ইনলাইন surface একমুখী — শুধু ছোট হতে পারে।
//
// মাইগ্রেশন শেষ হলে সীমা ০-এ নামবে, তখন app.js-এ nonce প্রয়োগ নীতিতে উঠবে
// আর `'unsafe-inline'` সরবে।

const ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['views', 'public'];
const EXTS = ['.ejs', '.html'];

// বর্তমান বেসলাইন। এটা লক্ষ্য নয়, ছাদ — প্রতিটা মাইগ্রেশনের পরে নামে।
// 250/273 (8666dbe) → 233/272: views/profile/security.ejs
//                    → 219/271: views/admin/kyc.ejs
//                    → 192/269: views/profile/chat.ejs, views/admin/games.ejs
//                    → 183/258: CSRF ইনজেক্টর (১০ কপি) + views/payment/admin.ejs
//                    → 176/257: views/admin/chat.ejs
//                    → 162/255: views/admin/matches.ejs, views/admin/localization.ejs
//                    → 150/254: payment/withdraw.ejs, admin/user-detail.ejs
//                              (+ শেয়ার করা admin-ui-hooks.js)
//                    → 115/254: ৩৫টা onsubmit confirm → data-confirm,
//                              শেয়ার করা hook দুই লেআউটেই (ui-hooks.js)
//                    → 102/253: profile/index.ejs + data-dismiss/href/reload
//                    →  86/253: ৭টা গেমের বাজি-নির্বাচন → data-game-select
//                    →  69/253: roulette, play, deposit, cards
//                    →  54/253: শেয়ার করা partials (admin-layout, navbar,
//                              announcements) + admin users/markets
//                    →  44/253: contest-payouts, support, telegram
//                    →  28/253: accumulator, referral, profile, queues,
//                              audit-logs, withdrawals, deposits
//                    →   0/254: বাকি সব singleton। হ্যান্ডলার শূন্য, তাই
//                              app.js-এ scriptSrcAttr এখন প্রয়োগ নীতিতেই
//                              'none'. (script ব্লক ২৫৩→২৫৪: offline.html-এ
//                              একটা যোগ হয়েছে, কারণ ওই পেজ কোনো লেআউট বা
//                              শেয়ার করা স্ক্রিপ্ট পায় না।)
//
// ধাপ ৩ (ইনলাইন <script> ব্লক): ২৫৪ → ২০৪ (৫০টা ভাঙা ট্যাগ ঠিক করায়)
//                             → ৬৭ (১১৭টা গেম স্ক্রিপ্ট
//                               public/js/games/-এ সরানোয়)
// (১০০টা অব্যবহৃত গেম টেমপ্লেট মুছে ফেলায় এই সংখ্যা বদলায়নি — ওগুলোর
//  স্ক্রিপ্ট আগেই বাইরে সরানো হয়েছিল।)
//                             → ২৯ (৩৮টা EJS-মুক্ত ব্লক
//                               public/js/views/-এ সরানোয়)
//                             → ২৪ (৫টা ছোট ব্লক JSON ডেটা ব্লক + বাইরের
//                               স্ক্রিপ্টে ভাগ করায়)
//                             → ২১ (trusted-devices, analytics, match-detail)
//                             → ২০ (partials/head — টোস্ট ও ফ্ল্যাশ বার্তা)
//                             → ১৬ (login, registration, wheel, accumulator)
//                             → ১২ (floating-promo, sports/index, baccarat,
//                               admin-layout ফ্ল্যাশ)
//                             → ১০ (games/play.ejs — বাজি ইঞ্জিন ও
//                               জেনেরিক গেম UI)
//                             →  ৭ (index.ejs, matches.ejs)
//                             →  ০ (admin bets/markets/reports/support/
//                               notification-template-form, offline.html)
//
// দুটোই এখন শূন্য, তাই app.js-এ scriptSrc থেকে 'unsafe-inline' সরানো হয়েছে।
const MAX_INLINE_HANDLERS = 0;
const MAX_INLINE_SCRIPT_BLOCKS = 0;

const HANDLER_RE = /\son(?:click|change|submit|input|load|error|focus|blur|keyup|keydown|mouseover)=/g;
const SCRIPT_RE = /<script>/g;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (EXTS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function countAll(regex) {
  const perFile = [];
  let total = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      const matches = src.match(regex);
      const n = matches ? matches.length : 0;
      if (n > 0) {
        perFile.push({ file: path.relative(ROOT, file), count: n });
        total += n;
      }
    }
  }
  perFile.sort((a, b) => b.count - a.count);
  return { total, perFile };
}

describe('CSP — ইনলাইন কোড র‍্যাচেট (শুধু কমতে পারে)', () => {
  test(`ইনলাইন ইভেন্ট হ্যান্ডলার ${MAX_INLINE_HANDLERS}-এর বেশি নয়`, () => {
    const { total, perFile } = countAll(HANDLER_RE);
    if (total > MAX_INLINE_HANDLERS) {
      const worst = perFile.slice(0, 10).map((f) => `  ${f.file}: ${f.count}`).join('\n');
      throw new Error(
        `ইনলাইন হ্যান্ডলার বেড়ে ${total} হয়েছে (সীমা ${MAX_INLINE_HANDLERS}).\n` +
        `নতুন ইনলাইন onclick/onchange যোগ করবেন না — addEventListener ব্যবহার করুন.\n` +
        `সবচেয়ে বেশি যেসব ফাইলে:\n${worst}`
      );
    }
    expect(total).toBeLessThanOrEqual(MAX_INLINE_HANDLERS);
  });

  test(`ইনলাইন <script> ব্লক ${MAX_INLINE_SCRIPT_BLOCKS}-এর বেশি নয়`, () => {
    const { total, perFile } = countAll(SCRIPT_RE);
    if (total > MAX_INLINE_SCRIPT_BLOCKS) {
      const worst = perFile.slice(0, 10).map((f) => `  ${f.file}: ${f.count}`).join('\n');
      throw new Error(
        `ইনলাইন <script> ব্লক বেড়ে ${total} হয়েছে (সীমা ${MAX_INLINE_SCRIPT_BLOCKS}).\n` +
        `নতুন ইনলাইন স্ক্রিপ্টে nonce দিন: <script nonce="<%= cspNonce %>">\n` +
        `সবচেয়ে বেশি যেসব ফাইলে:\n${worst}`
      );
    }
    expect(total).toBeLessThanOrEqual(MAX_INLINE_SCRIPT_BLOCKS);
  });
});

describe('CSP — nonce অবকাঠামো', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  test('প্রতি রিকোয়েস্টে cspNonce তৈরি হয়', () => {
    expect(appSource).toMatch(/res\.locals\.cspNonce\s*=\s*crypto\.randomBytes\(/);
  });

  test('nonce Report-Only নীতিতে আছে', () => {
    expect(appSource).toMatch(/'nonce-\$\{res\.locals\.cspNonce\}'/);
  });

  test('প্রয়োগ করা নীতিতে আর কোনো unsafe-inline নেই', () => {
    // মাইগ্রেশন শেষ। ইনলাইন হ্যান্ডলার ০, ইনলাইন <script> ব্লক ০,
    // তাই script-src থেকে 'unsafe-inline' সরানো হয়েছে।
    const enforced = /const cspDirectives = \{[\s\S]*?\n\};/.exec(appSource);
    expect(enforced).not.toBeNull();
    expect(enforced[0]).not.toMatch(/scriptSrc:[^\]]*'unsafe-inline'/);
  });
});

describe('CSP — ইনলাইন হ্যান্ডলার প্রয়োগ নীতিতেই নিষিদ্ধ', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  test("প্রয়োগ করা নীতিতে scriptSrcAttr 'none'", () => {
    const enforced = /const cspDirectives = \{[\s\S]*?\n\};/.exec(appSource);
    expect(enforced).not.toBeNull();
    expect(enforced[0]).toMatch(/scriptSrcAttr: \["'none'"\]/);
    expect(enforced[0]).not.toMatch(/scriptSrcAttr: \["'unsafe-inline'"\]/);
  });

  test("style surface দুটো ডিরেক্টিভে ভাগ — elem কড়া, attr এখনো শিথিল", () => {
    // styleSrc আর একটা ডিরেক্টিভ নয়। `<style>` ব্লকগুলোতে nonce বসানোর
    // পর style-src-elem কড়া করা গেছে; কিন্তু ইনলাইন style="..." এখনো
    // ১৮০০-র বেশি, তাই style-src-attr শিথিল। এটা ব্যর্থতা নয়, সৎ অবস্থা।
    // বিস্তারিত ও সীমা: tests/security/cspInlineStyleRatchet.test.js
    const enforced = /const cspDirectives = \{[\s\S]*?\n\};/.exec(appSource);
    expect(enforced[0]).toMatch(/styleSrcElem: \[/);
    expect(enforced[0]).toMatch(/styleSrcAttr: \["'unsafe-inline'"\]/);
    // elem-এ 'unsafe-inline' থাকলে nonce-টাই অর্থহীন হয়ে যেত
    const elem = /styleSrcElem: \[[\s\S]*?\]/.exec(enforced[0]);
    expect(elem[0]).not.toContain("'unsafe-inline'");
    expect(elem[0]).toContain('cspNonce');
  });
});
