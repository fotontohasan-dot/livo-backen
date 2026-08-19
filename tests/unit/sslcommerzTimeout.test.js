// রিগ্রেশন: SSLCommerz গেটওয়েতে outbound fetch() কল আগে কোনো timeout ছাড়াই ছিল —
// গেটওয়ে ধীর হলে বা সাড়া না দিলে OS-লেভেল TCP timeout (৬০-১২০+ সেকেন্ড) পর্যন্ত ঝুলে
// থাকত, আর /success ও /ipn রুটে এই কলটা একটা open DB transaction + row lock ধরে থাকা
// অবস্থায় await করা হয় (routes/payment.js) — তাই একটা bounded timeout জরুরি।
// এই টেস্ট services/sslcommerz.js-কে সরাসরি (mock না করে) নেয়, শুধু global.fetch mock করে
// একটা কখনো-resolve-না-হওয়া promise দিয়ে, আর যাচাই করে যে কলটা নির্দিষ্ট সময়ের মধ্যেই
// timeout এরর দিয়ে reject হয়ে যায় — অনির্দিষ্টকাল ঝুলে থাকে না।

process.env.SSLCZ_STORE_ID = 'test_store';
process.env.SSLCZ_STORE_PASSWD = 'test_pass';
process.env.SSLCZ_IS_LIVE = 'false';
process.env.SSLCZ_TIMEOUT_MS = '100'; // টেস্ট দ্রুত রাখতে ছোট timeout

const sslcommerz = require('../../services/sslcommerz');

describe('SSLCommerz outbound fetch timeout', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // real fetch() নিজেই AbortSignal শোনে এবং abort হলে AbortError দিয়ে reject করে — মকটা
  // সেই আচরণ নকল করে, শুধু কখনো নিজে থেকে resolve না করে (গেটওয়ে ঝুলে থাকার সিমুলেশন)।
  function hangingFetchRespectingAbort() {
    return jest.fn((url, options) => new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    }));
  }

  test('initPayment গেটওয়ে সাড়া না দিলে bounded সময়ের মধ্যে timeout এররে reject হয়', async () => {
    global.fetch = hangingFetchRespectingAbort();

    const started = Date.now();
    await expect(
      sslcommerz.initPayment({
        amount: 500,
        tranId: 'T1',
        customer: { name: 'x', email: 'x@x.com', phone: '01700000000' },
        baseUrl: 'http://localhost:3000'
      })
    ).rejects.toThrow(/timeout/i);
    // 100ms timeout + সামান্য overhead — কয়েক সেকেন্ডের মধ্যে অবশ্যই শেষ হওয়া উচিত
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('validatePayment গেটওয়ে সাড়া না দিলে bounded সময়ের মধ্যে timeout এররে reject হয়', async () => {
    global.fetch = hangingFetchRespectingAbort();
    const started = Date.now();
    await expect(sslcommerz.validatePayment('VAL_1')).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('গেটওয়ে দ্রুত সাড়া দিলে স্বাভাবিকভাবেই কাজ করে (timeout ফলস-পজিটিভ না)', async () => {
    global.fetch = jest.fn(async () => ({
      json: async () => ({ status: 'SUCCESS', GatewayPageURL: 'https://sandbox.sslcommerz.com/pay/T1' })
    }));
    const url = await sslcommerz.initPayment({
      amount: 500,
      tranId: 'T1',
      customer: { name: 'x', email: 'x@x.com', phone: '01700000000' },
      baseUrl: 'http://localhost:3000'
    });
    expect(url).toBe('https://sandbox.sslcommerz.com/pay/T1');
  });
});
