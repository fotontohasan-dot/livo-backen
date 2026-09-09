// ---------------------------------------------------------------------------
// tests/unit/passwordPolicy.test.js
//
// আগে নিয়ম ছিল শুধু `length < 8`, তিন জায়গায় আলাদা করে লেখা — কোনো
// কমপ্লেক্সিটি নেই, কোনো ব্লকলিস্ট নেই, তাই `password123` গৃহীত হতো।
// টাকার প্ল্যাটফর্মে অ্যাকাউন্ট টেকওভার মানে সরাসরি উইথড্র, তাই
// credential stuffing-ই সবচেয়ে সস্তা আক্রমণ।
// ---------------------------------------------------------------------------

const { validatePassword, MIN_LENGTH, BCRYPT_COST } = require('../../utils/passwordPolicy');

describe('পাসওয়ার্ড নীতি (utils/passwordPolicy.js)', () => {
  test('bcrypt cost অন্তত ১২', () => {
    // ১০ থেকে ১২ মানে হ্যাশ প্রতি ~৪ গুণ বেশি কাজ, অর্থাৎ DB ফাঁস হলে
    // অফলাইন ক্র্যাকিং ~৪ গুণ ধীর।
    expect(BCRYPT_COST).toBeGreaterThanOrEqual(12);
  });

  test('ন্যূনতম দৈর্ঘ্য অন্তত ১০', () => {
    expect(MIN_LENGTH).toBeGreaterThanOrEqual(10);
  });

  describe('প্রত্যাখ্যান', () => {
    test.each([
      ['খালি', ''],
      ['খুব ছোট', 'Abc12345'],
      ['শুধু সংখ্যা', '1234567890'],
      ['শুধু অক্ষর', 'abcdefghijk'],
      ['একই ক্যারেক্টার', 'aaaaaaaaaa'],
      ['কমন পাসওয়ার্ড', 'password123'],
      ['কমন পাসওয়ার্ড (কেস ভিন্ন)', 'Password123'],
      ['কমন পাসওয়ার্ড', 'welcome123']
    ])('%s → বাতিল', (_label, password) => {
      const result = validatePassword(password);
      expect(result.valid).toBe(false);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });

    test('নিজের ইউজারনেম থাকলে বাতিল', () => {
      const result = validatePassword('rakib1234hasan', { username: 'rakib1234' });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('auth_password_contains_identity');
    });

    test('ইমেইলের local-part থাকলে বাতিল', () => {
      const result = validatePassword('shamim99extra1', { email: 'shamim99@example.com' });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('auth_password_contains_identity');
    });

    test('null/undefined ক্র্যাশ করে না', () => {
      expect(validatePassword(null).valid).toBe(false);
      expect(validatePassword(undefined).valid).toBe(false);
    });
  });

  describe('গ্রহণ', () => {
    test.each([
      'SecurePass123',
      'livoUser4821x',
      'Tk9mn2qwerty',
      'my-long-pass-42'
    ])('%s → গৃহীত', (password) => {
      expect(validatePassword(password).valid).toBe(true);
    });

    test('ছোট ইউজারনেম (৪ অক্ষরের কম) সাবস্ট্রিং হিসেবে গোনা হয় না', () => {
      // নাহলে 'abc'-র মতো নাম প্রায় সব পাসওয়ার্ড বাতিল করে দিত
      expect(validatePassword('abcSecure1234', { username: 'abc' }).valid).toBe(true);
    });
  });
});
