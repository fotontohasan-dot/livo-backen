// রিগ্রেশন: services/googleAuth.js-এর exchangeCodeForProfile() আগে google-auth-library-এর
// getToken()/verifyIdToken() কল কোনো bounded timeout ছাড়াই await করত। Google-এর টোকেন/সার্টিফিকেট
// এন্ডপয়েন্ট ধীর হলে বা সাড়া না দিলে লগইন রিকোয়েস্টটা অনির্দিষ্টকাল ঝুলে থাকতে পারত। এই টেস্ট
// google-auth-library-এর OAuth2Client মক করে getToken() কখনো resolve না করা একটা promise
// রিটার্ন করায়, আর যাচাই করে exchangeCodeForProfile() bounded সময়ের মধ্যেই timeout এররে reject হয়।
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_AUTH_TIMEOUT_MS = '100'; // টেস্ট দ্রুত রাখতে ছোট timeout

jest.mock('google-auth-library', () => {
  return {
    OAuth2Client: jest.fn().mockImplementation(() => ({
      getToken: jest.fn(() => new Promise(() => {})), // কখনো resolve/reject হয় না
      verifyIdToken: jest.fn(() => new Promise(() => {})),
      generateAuthUrl: jest.fn()
    }))
  };
});

const googleAuth = require('../../services/googleAuth');

describe('Google OAuth token exchange timeout', () => {
  test('getToken() হ্যাং করলে exchangeCodeForProfile bounded সময়ের মধ্যে timeout এররে reject হয়', async () => {
    const started = Date.now();
    await expect(
      googleAuth.exchangeCodeForProfile('http://localhost:3000/auth/google/callback', 'fake-code', 'fake-nonce')
    ).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
