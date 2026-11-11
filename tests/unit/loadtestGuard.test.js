// scripts/loadtest/lib/guard.js — staging-only বাধ্যবাধকতা (C3)। নেটওয়ার্ক/DB লাগে না।
const { checkTarget, checkDbTarget } = require('../../scripts/loadtest/lib/guard');

describe('loadtest guard — URL', () => {
  const ok = (u, e) => checkTarget(u, e || {}).ok;
  test('URL না থাকলে প্রত্যাখ্যাত', () => expect(ok(undefined)).toBe(false));
  test('production হোস্ট প্রত্যাখ্যাত (বিল্ট-ইন + env)', () => {
    expect(ok('https://bet420-backen.onrender.com')).toBe(false);
    expect(ok('https://livo-web.onrender.com')).toBe(false);
    expect(ok('https://my-prod.example.com', { LOADTEST_PRODUCTION_HOSTS: 'my-prod.example.com' })).toBe(false);
  });
  test('ALLOWED_HOSTS-এ থাকলেও production তালিকা জেতে', () => {
    expect(ok('https://livo-web.onrender.com', { LOADTEST_ALLOWED_HOSTS: 'livo-web.onrender.com' })).toBe(false);
  });
  test('staging নামের https হোস্ট গৃহীত; নামে staging না থাকলে স্পষ্ট allow লাগে', () => {
    expect(ok('https://livo-web-staging.onrender.com')).toBe(true);
    expect(ok('https://foo.onrender.com')).toBe(false);
    expect(ok('https://foo.onrender.com', { LOADTEST_ALLOWED_HOSTS: 'foo.onrender.com' })).toBe(true);
  });
  test('http প্রত্যাখ্যাত; loopback শুধু LOADTEST_ALLOW_LOCAL=1', () => {
    expect(ok('http://x-staging.onrender.com')).toBe(false);
    expect(ok('http://localhost:3000')).toBe(false);
    expect(ok('http://localhost:3000', { LOADTEST_ALLOW_LOCAL: '1' })).toBe(true);
  });
  test('নিজের PUBLIC_APP_URL/CANONICAL_HOST-এর সমান হলে প্রত্যাখ্যাত', () => {
    expect(ok('https://staging.example.com', { PUBLIC_APP_URL: 'https://staging.example.com' })).toBe(false);
    expect(ok('https://staging.example.com', { CANONICAL_HOST: 'staging.example.com' })).toBe(false);
  });
});

describe('loadtest guard — DB', () => {
  test('staging নাম/স্পষ্ট allow ছাড়া প্রত্যাখ্যাত, production DB প্রত্যাখ্যাত', () => {
    expect(checkDbTarget('postgres://u:p@dpg-x/livo').ok).toBe(false);
    expect(checkDbTarget('postgres://u:p@dpg-x/livo_staging').ok).toBe(true);
    expect(checkDbTarget('postgres://u:p@dpg-x/livo_staging', { LOADTEST_PRODUCTION_DB_HOSTS: 'dpg-x' }).ok).toBe(false);
    expect(checkDbTarget('postgres://u:p@dpg-y/livo', { LOADTEST_ALLOWED_DB_HOSTS: 'dpg-y' }).ok).toBe(true);
    expect(checkDbTarget('postgres://u:p@dpg-s/staging', { DATABASE_URL: 'postgres://a:b@dpg-s/staging' }).ok).toBe(false);
  });
});
