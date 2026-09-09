// tests/unit/walletSignature.test.js
// ---------------------------------------------------------------------------
// PHASE 2 — প্রোভাইডার কলব্যাকের স্বাক্ষর যাচাই।
//
// এখানে তিনটা বাস্তব আক্রমণ লক করা হচ্ছে:
//   ১. ভুল/জাল স্বাক্ষর — গ্রহণ করা যাবে না।
//   ২. Replay — একবার ধরা পড়া বৈধ রিকোয়েস্ট উইন্ডোর বাইরে আবার পাঠালে
//      প্রত্যাখ্যাত হতে হবে (নাহলে একই bet অনির্দিষ্টবার চালানো যেত)।
//   ৩. বডি টেম্পারিং — এক বাইট বদলালেও স্বাক্ষর মিলবে না।
//
// নেটওয়ার্ক বা DB ছাড়া, বিশুদ্ধ ইউনিট টেস্ট।
// ---------------------------------------------------------------------------

const signature = require('../../services/wallet/signature');

const SECRET = 'test-secret-not-a-real-credential';

function signed(body, ts) {
  return signature.sign(`${ts}${body}`, SECRET);
}

describe('wallet signature', () => {
  test('সঠিক স্বাক্ষর ও তাজা timestamp গ্রহণ করে', () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ tx_id: 'a1', amount: 50 });
    const r = signature.verify({ provider: 'x', timestamp: ts, signature: signed(body, ts), rawBody: body, secret: SECRET });
    expect(r.ok).toBe(true);
  });

  test('জাল স্বাক্ষর প্রত্যাখ্যাত', () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"tx_id":"a1"}';
    const r = signature.verify({ provider: 'x', timestamp: ts, signature: 'deadbeef'.repeat(8), rawBody: body, secret: SECRET });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  test('বডির এক বাইট বদলালেও মেলে না', () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"amount":50}';
    const sig = signed(body, ts);
    const r = signature.verify({ provider: 'x', timestamp: ts, signature: sig, rawBody: '{"amount":51}', secret: SECRET });
    expect(r.ok).toBe(false);
  });

  test('পুরনো timestamp (replay) প্রত্যাখ্যাত', () => {
    const ts = Math.floor(Date.now() / 1000) - 600; // ১০ মিনিট আগের
    const body = '{"tx_id":"a1"}';
    const r = signature.verify({ provider: 'x', timestamp: ts, signature: signed(body, ts), rawBody: body, secret: SECRET });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stale_timestamp');
  });

  test('সিক্রেট কনফিগার করা না থাকলে কখনো পাস করে না', () => {
    delete process.env.PROVIDER_NOSECRET_SECRET;
    const ts = Math.floor(Date.now() / 1000);
    const r = signature.verify({ provider: 'nosecret', timestamp: ts, signature: 'x', rawBody: '' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_secret_configured');
  });

  test('মিলিসেকেন্ড ও সেকেন্ড — দুই ফরম্যাটের timestamp-ই গ্রহণযোগ্য', () => {
    expect(signature.isFreshTimestamp(Math.floor(Date.now() / 1000))).toBe(true);
    expect(signature.isFreshTimestamp(Date.now())).toBe(true);
    expect(signature.isFreshTimestamp('not-a-number')).toBe(false);
    expect(signature.isFreshTimestamp(null)).toBe(false);
  });

  test('safeCompare দৈর্ঘ্য-অমিলে throw না করে false দেয়', () => {
    expect(signature.safeCompare('abc', 'abcd')).toBe(false);
    expect(signature.safeCompare('abc', 'abc')).toBe(true);
    expect(signature.safeCompare(null, 'abc')).toBe(false);
  });
});
