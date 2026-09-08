// tests/unit/providerAuthIp.test.js
// ---------------------------------------------------------------------------
// PHASE 2 — IP allow-list-এর আচরণ।
//
// সবচেয়ে গুরুত্বপূর্ণ নিয়মটা এখানে লক করা হচ্ছে: প্রোডাকশনে allow-list
// কনফিগার করা না থাকলে fail-closed। "env সেট করতে ভুলে গেছি" অবস্থাটা যদি
// নীরবে "সবাইকে অনুমতি" হয়ে যেত, তাহলে একটা ভুলে যাওয়া ডিপ্লয় ভেরিয়েবলই
// পুরো ওয়ালেট API-কে ইন্টারনেটের সামনে খুলে দিত।
// ---------------------------------------------------------------------------

const providerAuth = require('../../middleware/providerAuth');

function reqFrom(ip) {
  return { ip, socket: { remoteAddress: ip } };
}

describe('providerAuth IP allow-list', () => {
  const OLD_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD_ENV;
    delete process.env.PROVIDER_ACME_IPS;
  });

  test('allow-list-এ থাকা IP গ্রহণ করে', () => {
    process.env.PROVIDER_ACME_IPS = '203.0.113.5, 203.0.113.6';
    expect(providerAuth.isIpAllowed(reqFrom('203.0.113.6'), 'acme')).toBe(true);
  });

  test('তালিকার বাইরের IP প্রত্যাখ্যাত', () => {
    process.env.PROVIDER_ACME_IPS = '203.0.113.5';
    expect(providerAuth.isIpAllowed(reqFrom('198.51.100.1'), 'acme')).toBe(false);
  });

  test('IPv4-mapped IPv6 (::ffff:) স্বাভাবিক করে মেলায়', () => {
    process.env.PROVIDER_ACME_IPS = '203.0.113.5';
    expect(providerAuth.isIpAllowed(reqFrom('::ffff:203.0.113.5'), 'acme')).toBe(true);
  });

  test('প্রোডাকশনে allow-list না থাকলে fail-closed', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PROVIDER_ACME_IPS;
    expect(providerAuth.isIpAllowed(reqFrom('203.0.113.5'), 'acme')).toBe(false);
  });

  test('প্রোডাকশনের বাইরে allow-list না থাকলে লোকাল ইন্টিগ্রেশন চালানো যায়', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.PROVIDER_ACME_IPS;
    expect(providerAuth.isIpAllowed(reqFrom('127.0.0.1'), 'acme')).toBe(true);
  });

  test('হাইফেনযুক্ত প্রোভাইডার নাম env key-তে আন্ডারস্কোর হয়', () => {
    process.env.PROVIDER_MOCK_CASINO_IPS = '203.0.113.9';
    expect(providerAuth.allowedIps('mock-casino')).toEqual(['203.0.113.9']);
    delete process.env.PROVIDER_MOCK_CASINO_IPS;
  });
});
