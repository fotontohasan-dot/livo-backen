// ==================== Step 4D — পেমেন্ট গেটওয়ে timeout ====================
// গেটওয়ে অডিট: আমাদের কোড থেকে *বাইরে* কল করে শুধু SSLCommerz (services/sslcommerz.js)।
// bKash / Nagad / Rocket / Upay শুধু ইনবাউন্ড, স্বাক্ষর-যাচাই-করা কলব্যাক (routes/walletCallback.js) — আমাদের
// দিক থেকে কোনো আউটবাউন্ড কল নেই, তাই timeout প্রযোজ্য নয়। নিচের গার্ড টেস্ট সেটাই ধরে রাখে: কেউ ওয়ালেট কোডে
// আউটবাউন্ড কল যোগ করলে এই টেস্ট ফেল করবে এবং তাকে timeout (ও no-retry) ভাবতে বাধ্য করবে।
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

describe('SSLCommerz — আউটবাউন্ড কলে timeout, কোনো retry নেই', () => {
  const realFetch = global.fetch;
  const ENV_KEYS = ['SSLCZ_STORE_ID', 'SSLCZ_STORE_PASSWD', 'SSLCZ_TIMEOUT_MS', 'SSLCZ_IS_LIVE'];
  const savedEnv = {};
  beforeEach(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
  afterEach(() => {
    global.fetch = realFetch;
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  });

  // সাড়া না দেওয়া গেটওয়ে: signal abort হলেই কেবল শেষ হয়
  function hangingFetch() {
    return jest.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }));
  }
  function loadSslcommerz(timeoutMs) {
    process.env.SSLCZ_STORE_ID = 'test_store';
    process.env.SSLCZ_STORE_PASSWD = 'test_passwd';
    process.env.SSLCZ_IS_LIVE = 'false';
    if (timeoutMs === undefined) delete process.env.SSLCZ_TIMEOUT_MS; else process.env.SSLCZ_TIMEOUT_MS = String(timeoutMs);
    let mod;
    jest.isolateModules(() => { mod = require('../../services/sslcommerz'); });
    return mod;
  }

  const CALLS = [
    ['initPayment', (s) => s.initPayment({ amount: 100, tranId: 'T1', customer: {}, baseUrl: 'https://example.test' })],
    ['validatePayment', (s) => s.validatePayment('VAL1')],
    ['validateByTransactionId', (s) => s.validateByTransactionId('T1')]
  ];

  test.each(CALLS)('%s: SSLCZ_TIMEOUT_MS-এর মধ্যে timeout, ঠিক একটাই HTTP কল (retry নেই)', async (_name, run) => {
    const fetchMock = hangingFetch();
    global.fetch = fetchMock;
    const ssl = loadSslcommerz(200);
    const started = Date.now();
    await expect(run(ssl)).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2000);
    // retry থাকলে অপেক্ষা-পরবর্তী দ্বিতীয় কল দেখা যেত
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });

  test('timeout env-কনফিগারযোগ্য; সোর্সে ডিফল্ট আছে এবং breaker/retry নেই', () => {
    const src = read('services/sslcommerz.js');
    expect(src).toMatch(/SSLCZ_TIMEOUT_MS/);
    expect(src).toMatch(/GATEWAY_TIMEOUT_MS\s*=\s*Number\(process\.env\.SSLCZ_TIMEOUT_MS\)\s*\|\|\s*\d+/);
    expect(src).toMatch(/breaker:\s*false/);
    expect(src).not.toMatch(/retry|attempts\s*[:=]\s*[2-9]/i);
  });
});

describe('ওয়ালেট গেটওয়ে (bKash/Nagad/Rocket/Upay) — ইনবাউন্ড-অনলি, আউটবাউন্ড কল নেই', () => {
  const { WALLETS, WALLET_CONFIG } = require('../../services/walletCallback');
  const OUTBOUND = /\bfetch\s*\(|integrationFetch|require\(['"](?:node-fetch|axios|got|undici|https?)['"]\)|XMLHttpRequest/;

  test('চারটা ওয়ালেটই তালিকায়', () => {
    expect([...WALLETS].sort()).toEqual(['bkash', 'nagad', 'rocket', 'upay']);
  });

  test.each(['bkash', 'nagad', 'rocket', 'upay'])('%s: কনফিগ শুধু ইনবাউন্ড স্বাক্ষর যাচাই; ওয়ালেট কোডে কোনো আউটবাউন্ড HTTP কল নেই', (wallet) => {
    expect(WALLET_CONFIG[wallet]).toBeDefined();
    expect(WALLET_CONFIG[wallet].sigHeader).toBeTruthy();
    for (const f of ['services/walletCallback.js', 'routes/walletCallback.js']) {
      expect(read(f)).not.toMatch(OUTBOUND);
    }
  });
});
