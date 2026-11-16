// /profile/add-bank-card রুট wallet_kind বাধ্যতামূলক করে (parseWalletKind)। security.ejs-এর কার্ড-ফর্মে
// ফিল্ডটা না থাকলে সার্ভার কার্ড নীরবে প্রত্যাখ্যান করে (E2E "ব্যাংক কার্ড যোগ" ফেলের কারণ ছিল)।
const fs = require('fs');
const path = require('path');

describe('views/profile/security.ejs — ব্যাংক কার্ড ফর্ম', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../views/profile/security.ejs'), 'utf8');
  const m = html.match(/<form[^>]*action="\/profile\/add-bank-card"[^>]*>[\s\S]*?<\/form>/);

  test('add-bank-card ফর্মটি আছে', () => { expect(m).not.toBeNull(); });
  test('ফর্মে hidden wallet_kind=ewallet পাঠানো হয়', () => {
    expect(m[0]).toMatch(/<input[^>]*type="hidden"[^>]*name="wallet_kind"[^>]*value="ewallet"/);
  });
});
