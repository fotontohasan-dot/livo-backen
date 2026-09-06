const fs = require('fs');
const path = require('path');

// ==================== Phase 12: Telegram → GitHub write ====================
//
// roadmap Phase 12 এটাকে high-risk বলেছে এবং স্পষ্ট করেছে: "Direct
// production write নিষিদ্ধ"। telegram-bot.js একটা Telegram কমান্ড থেকে
// GitHub-এ ফাইল কমিট করতে পারে, অর্থাৎ চ্যাট থেকে কোড রিপোতে যায়।
//
// দুটো গার্ড এখানে সবচেয়ে গুরুত্বপূর্ণ, আর দুটোরই কোনো টেস্ট ছিল না:
//
//   ১. PROTECTED_BRANCHES — main/master/production-এ কখনো লেখা যাবে না।
//      GITHUB_BOT_BRANCH env ভুল করে 'main' দিলে বট সরাসরি প্রোডাকশন
//      ব্রাঞ্চে কমিট করত।
//
//   ২. fail-closed authorization — TELEGRAM_ADMIN_USER_IDS খালি থাকলে
//      কেউই অনুমোদিত নয়। উল্টোটা (খালি মানে সবাই অনুমোদিত) হলে env
//      সেট করতে ভুলে গেলেই যেকোনো Telegram ব্যবহারকারী রিপোতে লিখতে
//      পারত।

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'telegram-bot.js'), 'utf8');

describe('Phase 12 — protected branch-এ লেখা যায় না', () => {
  test('PROTECTED_BRANCHES-এ প্রোডাকশন ব্রাঞ্চগুলো আছে', () => {
    const m = /const PROTECTED_BRANCHES = \[([^\]]*)\]/.exec(SRC);
    expect(m).not.toBeNull();
    const list = m[1];
    ['main', 'master', 'production'].forEach((b) => {
      expect(list).toContain(`'${b}'`);
    });
  });

  test('তালিকাটা সত্যিই প্রয়োগ হয়, শুধু ঘোষণা নয়', () => {
    // একটা ধ্রুবক ঘোষণা করে ব্যবহার না করলে সেটা মিথ্যা আশ্বাস।
    expect(SRC).toMatch(/PROTECTED_BRANCHES\.includes\(BOT_BRANCH\)/);
  });

  test('গার্ডটা লেখার আগেই চলে', () => {
    // চেকটা কমিট করার পরে হলে ক্ষতি ইতিমধ্যেই হয়ে যেত।
    const guardIdx = SRC.indexOf('PROTECTED_BRANCHES.includes(BOT_BRANCH)');
    const putIdx = SRC.indexOf("method: 'PUT'");
    expect(guardIdx).toBeGreaterThan(-1);
    if (putIdx > -1) expect(guardIdx).toBeLessThan(putIdx);
  });

  test('ডিফল্ট ব্রাঞ্চ প্রোডাকশন নয়', () => {
    const m = /const BOT_BRANCH = process\.env\.GITHUB_BOT_BRANCH \|\| '([^']+)'/.exec(SRC);
    expect(m).not.toBeNull();
    expect(['main', 'master', 'production']).not.toContain(m[1]);
  });
});

describe('Phase 12 — authorization fail-closed', () => {
  test('ADMIN_USER_IDS খালি হলে কেউই অনুমোদিত নয়', () => {
    // এটাই সবচেয়ে সহজে উল্টে যাওয়ার মতো সিদ্ধান্ত: "খালি মানে সীমা নেই"
    // লিখলে env সেট করতে ভুলে গেলেই বট সবার জন্য খুলে যেত।
    expect(SRC).toMatch(/if \(ADMIN_USER_IDS\.size === 0\) return false;/);
  });

  test('অনুমোদন client-প্রদত্ত মান নয়, env তালিকা থেকে', () => {
    expect(SRC).toMatch(/ADMIN_USER_IDS\.has\(String\(fromId\)\)/);
    expect(SRC).toMatch(/process\.env\.TELEGRAM_ADMIN_USER_IDS/);
  });

  test('GitHub টোকেন সোর্সে হার্ডকোড নেই', () => {
    expect(SRC).toMatch(/process\.env\.GITHUB_TOKEN/);
    // ghp_ / github_pat_ ধরনের আসল টোকেন যেন কখনো কমিট না হয়
    expect(SRC).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(SRC).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
  });
});
