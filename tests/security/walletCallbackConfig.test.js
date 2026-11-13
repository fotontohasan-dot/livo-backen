// tests/security/walletCallbackConfig.test.js
// Step 4G — ওয়ালেট callback: আন্দাজ-করা মান env দিয়ে বদলানো, timestamp যাচাই (ঐচ্ছিক, ডিফল্ট বন্ধ), বুট সতর্কতা।
// সিক্রেট হিসেবে এখানে শুধু স্পষ্ট নকল মান।

jest.mock('../../db', () => ({ pool: { connect: jest.fn() } }));

const crypto = require('crypto');
const svc = require('../../services/walletCallback');

const SECRET = 'fake-test-secret-4g';
const BODY = Buffer.from(JSON.stringify({ trxID: 'T1', amount: '100', transactionStatus: 'Completed' }));
const hmac = (buf, secret = SECRET) => crypto.createHmac('sha256', secret).update(buf).digest('hex');
const fakeReq = (headers, rawBody = BODY) => ({ rawBody, get: (h) => headers[String(h).toLowerCase()] });

const SUFFIXES = ['SIG_HEADER', 'ALGO', 'ENCODING', 'SIGNED_FORMAT', 'TS_HEADER', 'WINDOW_SECONDS', 'FIELD_TRX_ID', 'FIELD_AMOUNT',
  'FIELD_STATUS', 'FIELD_CURRENCY', 'FIELD_PAYER', 'FIELD_PAYMENT_ID', 'SUCCESS_VALUES', 'SECRET', 'PUBLIC_KEY', 'IPS'];
function clearEnv() {
  for (const w of svc.WALLETS) for (const s of SUFFIXES) delete process.env[`WALLET_CALLBACK_${w.toUpperCase()}_${s}`];
  delete process.env.WALLET_CALLBACK_WINDOW_SECONDS;
}
beforeEach(() => { clearEnv(); process.env.WALLET_CALLBACK_BKASH_SECRET = SECRET; });
afterAll(clearEnv);

describe('ডিফল্ট আগের মতোই', () => {
  test.each(svc.WALLETS)('%s: কোনো env না থাকলে config ও field map হুবহু ডিফল্ট', (w) => {
    const c = svc.getWalletConfig(w);
    expect(c).toMatchObject(svc.WALLET_CONFIG[w]);
    expect(c.windowSeconds).toBe(300);
    expect(c.invalid).toEqual([]);
    expect(c.tsHeader).toBeNull(); // timestamp যাচাই ডিফল্টে বন্ধ
    const m = svc.getFieldMap(w);
    expect(m).toMatchObject(svc.FIELD_MAP[w]);
    expect(m.invalid).toEqual([]);
  });

  test('ডিফল্ট header ও পুরনো timestamp: সঠিক স্বাক্ষরে পাস (timestamp বন্ধ)', () => {
    const r = svc.verifyRequest(fakeReq({ 'x-bkash-signature': hmac(BODY), 'x-timestamp': '1' }), 'bkash');
    expect(r.ok).toBe(true);
  });
});

describe('env দিয়ে বদল', () => {
  test('SIG_HEADER বদলালে নতুন header-ই পড়া হয়, পুরনোটা আর চলে না', () => {
    process.env.WALLET_CALLBACK_BKASH_SIG_HEADER = 'x-custom-sig';
    expect(svc.verifyRequest(fakeReq({ 'x-custom-sig': hmac(BODY) }), 'bkash').ok).toBe(true);
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': hmac(BODY) }), 'bkash')).toEqual({ ok: false, reason: 'missing_signature' });
  });

  test('ENCODING=base64 কাজ করে', () => {
    process.env.WALLET_CALLBACK_BKASH_ENCODING = 'base64';
    const sig = crypto.createHmac('sha256', SECRET).update(BODY).digest('base64');
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': sig }), 'bkash').ok).toBe(true);
  });

  test('ALGO=rsa-sha256 হলে public key লাগে; না থাকলে fail-closed', () => {
    process.env.WALLET_CALLBACK_BKASH_ALGO = 'rsa-sha256';
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': 'AAAA' }), 'bkash')).toEqual({ ok: false, reason: 'no_key_configured' });
  });

  test('payload field নাম ও সফল-মান বদলানো যায়', () => {
    process.env.WALLET_CALLBACK_BKASH_FIELD_TRX_ID = 'myTrx';
    process.env.WALLET_CALLBACK_BKASH_FIELD_AMOUNT = 'amt';
    process.env.WALLET_CALLBACK_BKASH_FIELD_STATUS = 'st';
    process.env.WALLET_CALLBACK_BKASH_SUCCESS_VALUES = 'OK, Done';
    const r = svc.normalizePayload('bkash', { myTrx: 'X9', amt: '250.50', st: 'done' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ trxId: 'X9', amount: 250.5, isSuccess: true });
    // পুরনো নাম আর পড়া হয় না
    expect(svc.normalizePayload('bkash', { trxID: 'X9', amount: '250', transactionStatus: 'Completed' }).ok).toBe(false);
  });
});

describe('ভুল env — নীরবে ডিফল্টে ফেরে না (fail-closed)', () => {
  test.each([
    ['ALGO', 'sha1'], ['ENCODING', 'utf8'], ['SIGNED_FORMAT', 'whatever'], ['SIG_HEADER', 'bad header!'], ['WINDOW_SECONDS', '-5']
  ])('%s=%s → invalid_config, স্বাক্ষর ঠিক থাকলেও প্রত্যাখ্যাত', (suffix, value) => {
    process.env[`WALLET_CALLBACK_BKASH_${suffix}`] = value;
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': hmac(BODY) }), 'bkash')).toEqual({ ok: false, reason: 'invalid_config' });
  });

  test('ভুল FIELD_* → payload invalid_config', () => {
    process.env.WALLET_CALLBACK_BKASH_FIELD_AMOUNT = 'a b,';
    expect(svc.normalizePayload('bkash', { trxID: 'A1', amount: '5' })).toEqual({ ok: false, reason: 'invalid_config' });
  });
});

describe('ঐচ্ছিক timestamp যাচাই', () => {
  const NOW = 1_800_000_000_000;
  const signedTs = (ts) => hmac(Buffer.concat([Buffer.from(String(ts)), BODY]));

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    process.env.WALLET_CALLBACK_BKASH_TS_HEADER = 'x-bk-ts';
    process.env.WALLET_CALLBACK_BKASH_SIGNED_FORMAT = 'ts+body';
  });
  afterEach(() => jest.restoreAllMocks());

  test('টাটকা timestamp (সেকেন্ড ও মিলিসেকেন্ড) পাস', () => {
    const s = Math.floor(NOW / 1000) - 60;
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': signedTs(s), 'x-bk-ts': String(s) }), 'bkash').ok).toBe(true);
    const ms = NOW - 60_000;
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': signedTs(ms), 'x-bk-ts': String(ms) }), 'bkash').ok).toBe(true);
  });

  test('৫ মিনিটের বেশি পুরনো → stale_timestamp, স্বাক্ষর ঠিক থাকলেও', () => {
    const old = Math.floor(NOW / 1000) - 301;
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': signedTs(old), 'x-bk-ts': String(old) }), 'bkash'))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  test('timestamp header না থাকলে বা সংখ্যা না হলে প্রত্যাখ্যাত', () => {
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': signedTs(1) }), 'bkash').reason).toBe('stale_timestamp');
    expect(svc.verifyRequest(fakeReq({ 'x-bkash-signature': signedTs('abc'), 'x-bk-ts': 'abc' }), 'bkash').reason).toBe('stale_timestamp');
  });

  test('timestamp বদলালে স্বাক্ষর মেলে না (ts+body স্বাক্ষরিত)', () => {
    const s = Math.floor(NOW / 1000);
    const r = svc.verifyRequest(fakeReq({ 'x-bkash-signature': signedTs(s - 10), 'x-bk-ts': String(s) }), 'bkash');
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('উইন্ডো কনফিগযোগ্য: ওয়ালেট-নির্দিষ্ট > গ্লোবাল', () => {
    const s = Math.floor(NOW / 1000) - 120;
    const req = () => fakeReq({ 'x-bkash-signature': signedTs(s), 'x-bk-ts': String(s) });
    process.env.WALLET_CALLBACK_WINDOW_SECONDS = '60';
    expect(svc.verifyRequest(req(), 'bkash').reason).toBe('stale_timestamp');
    process.env.WALLET_CALLBACK_BKASH_WINDOW_SECONDS = '600';
    expect(svc.verifyRequest(req(), 'bkash').ok).toBe(true);
  });
});

describe('বুট সতর্কতা', () => {
  test('secret/key ছাড়া ওয়ালেট তালিকাভুক্ত; সেট-করাটা নয়; কোনো মান ফাঁস নয়', () => {
    const w = svc.bootWarnings({ WALLET_CALLBACK_BKASH_SECRET: SECRET });
    const text = w.join('\n');
    expect(text).toMatch(/nagad: WALLET_CALLBACK_NAGAD_PUBLIC_KEY সেট নেই/);
    expect(text).toMatch(/rocket: WALLET_CALLBACK_ROCKET_SECRET সেট নেই/);
    expect(text).toMatch(/upay: WALLET_CALLBACK_UPAY_SECRET সেট নেই/);
    expect(text).not.toMatch(/bkash: WALLET_CALLBACK_BKASH_SECRET সেট নেই/);
    expect(text).not.toContain(SECRET);
  });

  test('সব সেট থাকলে কোনো সতর্কতা নেই', () => {
    const env = { WALLET_CALLBACK_BKASH_SECRET: 'a', WALLET_CALLBACK_NAGAD_PUBLIC_KEY: 'b', WALLET_CALLBACK_ROCKET_SECRET: 'c', WALLET_CALLBACK_UPAY_SECRET: 'd' };
    expect(svc.bootWarnings(env)).toEqual([]);
  });

  test('ভুল env ও স্বাক্ষর-বহির্ভূত timestamp-এর সতর্কতা, শুধু নাম', () => {
    const env = { WALLET_CALLBACK_BKASH_SECRET: SECRET, WALLET_CALLBACK_BKASH_ALGO: 'md5', WALLET_CALLBACK_ROCKET_SECRET: SECRET, WALLET_CALLBACK_ROCKET_TS_HEADER: 'x-ts' };
    const text = svc.bootWarnings(env).join('\n');
    expect(text).toMatch(/bkash: অবৈধ env মান \(WALLET_CALLBACK_BKASH_ALGO\)/);
    expect(text).toMatch(/rocket: TS_HEADER সেট কিন্তু SIGNED_FORMAT=ts\+body নয়/);
    expect(text).not.toContain('md5');
  });

  test('logBootWarnings logger.warn-এ লেখে', () => {
    const logger = { warn: jest.fn() };
    const w = svc.logBootWarnings(logger, { WALLET_CALLBACK_BKASH_SECRET: SECRET });
    expect(w.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
