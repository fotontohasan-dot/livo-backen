// tests/security/repoIntegrity.test.js
// ---------------------------------------------------------------------------
// রিপোজিটরির রুটে কিছু ফাইল আছে যেগুলো Node অ্যাপের অংশ নয়:
//
//   android          — Kotlin সোর্স (AuthKeyManager.kt + BiometricAuthManager.kt)। কোনো
//                      JS/বিল্ড/Docker স্ক্রিপ্ট এটাকে রেফার করে না, কিন্তু git history
//                      অনুযায়ী এটা ইচ্ছাকৃতভাবে কমিট করা মোবাইল ক্লায়েন্ট কম্পোনেন্টের সোর্স।
//                      তাই মুছে ফেলা হয়নি — শুধু নিশ্চিত করা হয় এটা রানটাইমে লোড হয় না
//                      এবং HTTP-তে সার্ভ হয় না।
//   verify_all.js    — ডেভেলপার স্ক্রিনশট/স্মোক ইউটিলিটি (Playwright)। অ্যাপ বুট পাথে নেই।
//
// এই টেস্টের কাজ একটাই: ভবিষ্যতে কেউ যেন ভুল করে এগুলোকে সার্ভ-যোগ্য (public/) বা
// অ্যাপ্লিকেশন রানটাইমের অংশ বানিয়ে না ফেলে। Kotlin ফাইলটাতে কী-অ্যালায়াস/ক্রিপ্টো
// কনফিগ আছে, তাই এটা ব্রাউজারে পৌঁছানো উচিত নয়।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { freshRequest } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');

describe('রুট-লেভেল non-application ফাইলগুলোর integrity', () => {
  test('android ও verify_all.js public/ ডিরেক্টরিতে নেই (তাই static-এ সার্ভ হয় না)', () => {
    expect(fs.existsSync(path.join(ROOT, 'public', 'android'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'public', 'verify_all.js'))).toBe(false);
  });

  test('android ফাইল থাকলে সেটা Kotlin সোর্সই — কোনো JS মডিউল নয়', () => {
    const p = path.join(ROOT, 'android');
    if (!fs.existsSync(p)) return; // মুছে ফেলা হলে এই অ্যাসারশন প্রযোজ্য নয়
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toMatch(/\.kt\b|object\s+\w+|fun\s+\w+/);
    // require()-এর মাধ্যমে অ্যাপ্লিকেশনে টেনে আনা হয়নি
    const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    expect(appSrc).not.toMatch(/require\(['"]\.\/android['"]\)/);
  });

  test.each(['/android', '/verify_all.js'])('%s HTTP-তে সার্ভ হয় না', async (p) => {
    const res = await freshRequest().get(p);
    expect(res.status).not.toBe(200);
  });
});
