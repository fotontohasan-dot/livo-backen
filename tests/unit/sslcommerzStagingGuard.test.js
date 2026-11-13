// staging নিরাপত্তা: SSLCommerz-এ live URL ও আউটবাউন্ড কল গার্ড + প্রোভাইডার সতর্কতা।
const { resolveSslczMode, isStaging, nonMockProviders } = require('../../utils/stagingGuard');

const LIVE = 'https://securepay.sslcommerz.com';
const SANDBOX = 'https://sandbox.sslcommerz.com';

describe('resolveSslczMode — live URL কখন ব্যবহার হয়', () => {
  test('SSLCZ_IS_LIVE ফাঁকা/false/অন্য মান → sandbox', () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect(resolveSslczMode({ NODE_ENV: 'production', SSLCZ_IS_LIVE: v }).baseUrl).toBe(SANDBOX);
    }
  });
  test('production + SSLCZ_IS_LIVE=true → live (আসল প্রোডাকশন আচরণ অপরিবর্তিত)', () => {
    const m = resolveSslczMode({ NODE_ENV: 'production', SSLCZ_IS_LIVE: 'true' });
    expect(m.live).toBe(true);
    expect(m.baseUrl).toBe(LIVE);
  });
  test('APP_ENV=staging + SSLCZ_IS_LIVE=true → তবুও sandbox, blocked চিহ্নিত', () => {
    const m = resolveSslczMode({ NODE_ENV: 'production', APP_ENV: 'staging', SSLCZ_IS_LIVE: 'true' });
    expect(m).toEqual({ live: false, baseUrl: SANDBOX, blockedLiveInStaging: true });
  });
  test('NODE_ENV=staging (বড়/ছোট হাতের) + live=true → sandbox', () => {
    expect(resolveSslczMode({ NODE_ENV: ' Staging ', SSLCZ_IS_LIVE: 'true' }).baseUrl).toBe(SANDBOX);
  });
  test('isStaging', () => {
    expect(isStaging({ APP_ENV: 'staging' })).toBe(true);
    expect(isStaging({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('services/sslcommerz — আউটবাউন্ড কল', () => {
  const ORIGINAL = { ...process.env };
  let integrationFetch;

  function load(env) {
    jest.resetModules();
    process.env = { ...ORIGINAL, ...env };
    for (const k of ['SSLCZ_STORE_ID', 'SSLCZ_STORE_PASSWD', 'SSLCZ_IS_LIVE', 'APP_ENV']) {
      if (!(k in env)) delete process.env[k];
    }
    integrationFetch = jest.fn(async () => ({ json: async () => ({ status: 'SUCCESS', GatewayPageURL: 'https://gw/x', element: [] }) }));
    jest.doMock('../../utils/integrationHttp', () => ({ integrationFetch }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    return require('../../services/sslcommerz');
  }
  afterEach(() => { process.env = { ...ORIGINAL }; jest.restoreAllMocks(); jest.dontMock('../../utils/integrationHttp'); });

  const cust = { name: 'T', email: 't@e.x', phone: '01700000000' };
  const blanks = [
    {},
    { SSLCZ_STORE_ID: 'id' },
    { SSLCZ_STORE_PASSWD: 'pw' },
    { SSLCZ_STORE_ID: '', SSLCZ_STORE_PASSWD: '' }
  ];

  test.each(blanks)('কী ফাঁকা/অর্ধেক (%j) → তিনটি ফাংশনই throw করে, কোনো fetch হয় না', async (env) => {
    const s = load({ NODE_ENV: 'production', ...env });
    await expect(s.initPayment({ amount: 1, tranId: 't', customer: cust, baseUrl: 'https://x' })).rejects.toThrow(/সেট করা নেই/);
    await expect(s.validatePayment('v')).rejects.toThrow(/সেট করা নেই/);
    await expect(s.validateByTransactionId('t')).rejects.toThrow(/সেট করা নেই/);
    expect(integrationFetch).not.toHaveBeenCalled();
  });

  test('staging + SSLCZ_IS_LIVE=true + কী আছে → সব কল sandbox-এ, securepay-তে কখনো নয়', async () => {
    const s = load({ NODE_ENV: 'production', APP_ENV: 'staging', SSLCZ_IS_LIVE: 'true', SSLCZ_STORE_ID: 'id', SSLCZ_STORE_PASSWD: 'pw' });
    await s.initPayment({ amount: 1, tranId: 't', customer: cust, baseUrl: 'https://x' });
    await s.validatePayment('v');
    await s.validateByTransactionId('t');
    expect(integrationFetch).toHaveBeenCalledTimes(3);
    for (const call of integrationFetch.mock.calls) {
      expect(call[1].startsWith(SANDBOX)).toBe(true);
      expect(call[1]).not.toContain('securepay');
    }
  });

  test('production + live=true + কী আছে → live URL (অপরিবর্তিত)', async () => {
    const s = load({ NODE_ENV: 'production', SSLCZ_IS_LIVE: 'true', SSLCZ_STORE_ID: 'id', SSLCZ_STORE_PASSWD: 'pw' });
    await s.validatePayment('v');
    expect(integrationFetch.mock.calls[0][1].startsWith(LIVE)).toBe(true);
  });
});

describe('nonMockProviders — staging বুট সতর্কতা', () => {
  test('কিছুই কনফিগার না থাকলে খালি', () => {
    expect(nonMockProviders({ APP_ENV: 'staging' })).toEqual([]);
  });
  test('সব মক URL-এ ঘোরানো থাকলে খালি', () => {
    const env = {
      ALLOW_PROVIDER_BASE_URL_OVERRIDE: 'true',
      CRICKET_API_KEY: 'mock', RAPIDAPI_KEY: 'mock',
      CRICKET_API_BASE_URL: 'https://livo-mock-provider-staging.onrender.com/cricket',
      FOOTBALL_API_BASE_URL: 'https://livo-mock-provider-staging.onrender.com/football',
      SMS_API_URL: 'https://livo-mock-provider-staging.onrender.com/sms/send', SMS_API_KEY: 'mock',
      PROVIDER_MOCK_CASINO_API_URL: 'https://x/casino'
    };
    expect(nonMockProviders(env)).toEqual([]);
  });
  test('আসল কী/URL থাকলে নাম আসে, মান (সিক্রেট) কখনো নয়', () => {
    const env = {
      CRICKET_API_KEY: 'SECRET-CRICKET-123', RAPIDAPI_KEY: 'SECRET-RAPID-456',
      SMS_API_URL: 'https://sms.real.example/send', SMS_API_KEY: 'SECRET-SMS-789',
      PROVIDER_DB_GAMES_API_URL: 'https://casino.real.example', PROVIDER_DB_GAMES_SECRET: 'SECRET-CASINO',
      SSLCZ_STORE_ID: 'SECRET-ID', SSLCZ_STORE_PASSWD: 'SECRET-PW'
    };
    const out = nonMockProviders(env);
    expect(out.length).toBe(5);
    const text = out.join('\n');
    expect(text).not.toMatch(/SECRET-|real\.example/);
    expect(text).toMatch(/cricket/); expect(text).toMatch(/football/); expect(text).toMatch(/sms/);
    expect(text).toMatch(/casino:db_games/); expect(text).toMatch(/sslcommerz/);
  });
});

describe('runStartupValidation — staging লগ', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL }; jest.restoreAllMocks(); });

  test('staging-এ আসল প্রোভাইডার থাকলে warn, সিক্রেট ছাড়া; non-staging-এ কোনো STAGING লগ নেই', () => {
    const { runStartupValidation } = require('../../services/envValidator');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.APP_ENV = 'staging';
    process.env.SMS_API_URL = 'https://sms.real.example/send';
    process.env.SMS_API_KEY = 'TOPSECRETKEY';
    runStartupValidation();
    const logged = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toMatch(/STAGING সতর্কতা/);
    expect(logged).toMatch(/sms/);
    expect(logged).not.toMatch(/TOPSECRETKEY|real\.example/);

    warn.mockClear();
    delete process.env.APP_ENV;
    process.env.NODE_ENV = 'test';
    runStartupValidation();
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).not.toMatch(/STAGING সতর্কতা/);
  });
});
