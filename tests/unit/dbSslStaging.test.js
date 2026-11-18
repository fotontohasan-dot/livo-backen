// staging-এ self-signed DB সার্টিফিকেট চলে; প্রোডাকশনে যাচাই strict থাকে।
const { resolveSslConfig } = require('../../db');

describe('resolveSslConfig', () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    for (const k of ['DATABASE_SSL', 'DATABASE_CA_CERT', 'DATABASE_SSL_INSECURE', 'APP_ENV']) delete process.env[k];
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { process.env = { ...ORIGINAL }; jest.restoreAllMocks(); });

  test('staging (NODE_ENV=production + APP_ENV=staging) → rejectUnauthorized:false', () => {
    process.env.NODE_ENV = 'production'; process.env.APP_ENV = 'staging';
    expect(resolveSslConfig()).toEqual({ rejectUnauthorized: false });
  });
  test('staging + DATABASE_CA_CERT → যাচাই চালু থাকে', () => {
    process.env.NODE_ENV = 'production'; process.env.APP_ENV = 'staging'; process.env.DATABASE_CA_CERT = 'CERT';
    expect(resolveSslConfig()).toEqual({ rejectUnauthorized: true, ca: 'CERT' });
  });
  test('প্রোডাকশন (staging নয়) → strict, অপরিবর্তিত', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveSslConfig()).toEqual({ rejectUnauthorized: true });
  });
  test('DATABASE_SSL=false সবকিছুর ওপরে', () => {
    process.env.NODE_ENV = 'production'; process.env.APP_ENV = 'staging'; process.env.DATABASE_SSL = 'false';
    expect(resolveSslConfig()).toBe(false);
  });
  test('প্রোডাকশন (staging নয়) + DATABASE_SSL_INSECURE=true → বুট ব্যর্থ (throw)', () => {
    process.env.NODE_ENV = 'production'; process.env.DATABASE_SSL_INSECURE = 'true';
    expect(() => resolveSslConfig()).toThrow(/DATABASE_SSL_INSECURE/);
  });
  test('staging + DATABASE_SSL_INSECURE=true → শুধু সতর্কতা, throw নয়', () => {
    process.env.NODE_ENV = 'production'; process.env.APP_ENV = 'staging'; process.env.DATABASE_SSL_INSECURE = 'true';
    expect(resolveSslConfig()).toEqual({ rejectUnauthorized: false });
    expect(console.warn).toHaveBeenCalled();
  });
});
