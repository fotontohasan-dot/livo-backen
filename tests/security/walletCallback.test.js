// tests/security/walletCallback.test.js
// ই-ওয়ালেট কলব্যাক: স্বাক্ষর যাচাই, payload রূপান্তর, রুটের আচরণ (DB ছাড়া, mock দিয়ে)

const crypto = require('crypto');

jest.mock('../../db', () => ({ pool: { connect: jest.fn() } }));
jest.mock('../../services/auditLog', () => ({ logEvent: jest.fn().mockResolvedValue() }));
jest.mock('../../middleware/rateLimitFactory', () => ({ createLimiter: () => (req, res, next) => next() }));
jest.mock('../../routes/payment', () => ({ creditApprovedDeposit: jest.fn().mockResolvedValue({ bonusGiven: 0 }) }));

const express = require('express');
const request = require('supertest');
const { pool } = require('../../db');
const svc = require('../../services/walletCallback');
const { creditApprovedDeposit } = require('../../routes/payment');

const SECRET = 'test-secret-123';
const hmac = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/wallet-callback', require('../../routes/walletCallback'));
  app.use(express.json()); // গ্লোবাল parser মাউন্টের পরে — raw body আগেই কাটা হয়ে গেছে
  return app;
}

function mockDb(rows) {
  const queries = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      queries.push(String(sql).trim().split(/\s+/)[0]);
      if (/SELECT \* FROM payment_requests/.test(sql)) return { rows };
      return { rows: [] };
    }),
    release: jest.fn()
  };
  pool.connect.mockResolvedValue(client);
  return { client, queries };
}

const pending = (over = {}) => ({ id: 7, user_id: 3, type: 'deposit', method: 'bkash', transaction_id: 'TRX123', amount: '500.00', status: 'pending', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WALLET_CALLBACK_BKASH_SECRET = SECRET;
  process.env.WALLET_CALLBACK_ROCKET_SECRET = SECRET;
  process.env.WALLET_CALLBACK_UPAY_SECRET = SECRET;
  delete process.env.WALLET_CALLBACK_BKASH_IPS;
  delete process.env.WALLET_CALLBACK_NAGAD_PUBLIC_KEY;
});

describe('normalizePayload', () => {
  test('bKash payload সাধারণ ফরম্যাটে আসে', () => {
    const r = svc.normalizePayload('bkash', { trxID: 'ABC123', amount: '500.00', transactionStatus: 'Completed', paymentID: 'P1' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ wallet: 'bkash', trxId: 'ABC123', amount: 500, isSuccess: true, currency: 'BDT' });
  });
  test.each([
    ['ঋণাত্মক', { trxID: 'A1', amount: '-5', transactionStatus: 'Completed' }],
    ['শূন্য', { trxID: 'A1', amount: '0', transactionStatus: 'Completed' }],
    ['৩ দশমিক ঘর', { trxID: 'A1', amount: '1.234', transactionStatus: 'Completed' }],
    ['scientific', { trxID: 'A1', amount: '1e3', transactionStatus: 'Completed' }],
    ['অ-সংখ্যা', { trxID: 'A1', amount: 'abc', transactionStatus: 'Completed' }],
    ['অবজেক্ট', { trxID: 'A1', amount: { a: 1 }, transactionStatus: 'Completed' }]
  ])('অবৈধ পরিমাণ প্রত্যাখ্যাত: %s', (_n, body) => {
    expect(svc.normalizePayload('bkash', body)).toEqual({ ok: false, reason: 'invalid_amount' });
  });
  test.each([["a'b"], ['a b'], ['x'.repeat(65)], ['../etc']])('অবৈধ TrxID প্রত্যাখ্যাত: %s', (id) => {
    expect(svc.normalizePayload('bkash', { trxID: id, amount: '10', transactionStatus: 'Completed' }).ok).toBe(false);
  });
  test('অ-অবজেক্ট body প্রত্যাখ্যাত', () => {
    expect(svc.normalizePayload('bkash', [1, 2]).ok).toBe(false);
    expect(svc.normalizePayload('bkash', null).ok).toBe(false);
  });
});

describe('POST /wallet-callback/:provider — নিরাপত্তা', () => {
  const body = JSON.stringify({ trxID: 'TRX123', amount: '500.00', transactionStatus: 'Completed', paymentID: 'P9' });

  test('অজানা প্রোভাইডার -> 404', async () => {
    const r = await request(buildApp()).post('/wallet-callback/paypal').set('Content-Type', 'application/json').send(body);
    expect(r.status).toBe(404);
  });
  test('স্বাক্ষর নেই -> 401, DB স্পর্শ হয় না', async () => {
    const r = await request(buildApp()).post('/wallet-callback/bkash').set('Content-Type', 'application/json').send(body);
    expect(r.status).toBe(401);
    expect(pool.connect).not.toHaveBeenCalled();
  });
  test('ভুল স্বাক্ষর -> 401', async () => {
    const r = await request(buildApp()).post('/wallet-callback/bkash').set('Content-Type', 'application/json').set('x-bkash-signature', hmac(body, 'wrong')).send(body);
    expect(r.status).toBe(401);
    expect(pool.connect).not.toHaveBeenCalled();
  });
  test('body বদলালে (স্বাক্ষর পুরনো) -> 401', async () => {
    const tampered = body.replace('500.00', '50000.00');
    const r = await request(buildApp()).post('/wallet-callback/bkash').set('Content-Type', 'application/json').set('x-bkash-signature', hmac(body)).send(tampered);
    expect(r.status).toBe(401);
  });
  test('সিক্রেট কনফিগার না থাকলে fail-closed', async () => {
    delete process.env.WALLET_CALLBACK_BKASH_SECRET;
    const r = await request(buildApp()).post('/wallet-callback/bkash').set('Content-Type', 'application/json').set('x-bkash-signature', hmac(body)).send(body);
    expect(r.status).toBe(401);
    expect(pool.connect).not.toHaveBeenCalled();
  });
  test('খালি সিক্রেট দিয়ে তৈরি স্বাক্ষরও গ্রহণযোগ্য নয়', async () => {
    process.env.WALLET_CALLBACK_BKASH_SECRET = '';
    const r = await request(buildApp()).post('/wallet-callback/bkash').set('Content-Type', 'application/json').set('x-bkash-signature', hmac(body, '')).send(body);
    expect(r.status).toBe(401);
  });
  test('allow-list-বহির্ভূত IP -> 403', async () => {
    process.env.WALLET_CALLBACK_BKASH_IPS = '203.0.113.9';
    const r = await request(buildApp()).post('/wallet-callback/bkash').set('Content-Type', 'application/json').set('x-bkash-signature', hmac(body)).send(body);
    expect(r.status).toBe(403);
  });
  test('অবৈধ JSON (বৈধ স্বাক্ষর সহ) -> 400', async () => {
    const bad = '{not json';
    const r = await request(buildApp()).post('/wallet-callback/bkash').set('Content-Type', 'application/json').set('x-bkash-signature', hmac(bad)).send(bad);
    expect(r.status).toBe(400);
  });
  test('Nagad: RSA স্বাক্ষর কাজ করে, ভুল কী-তে প্রত্যাখ্যাত', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const nb = JSON.stringify({ issuerPaymentRefNo: 'NGD1', amount: '200', status: 'Success' });
    const sign = (k) => crypto.createSign('RSA-SHA256').update(nb).sign(k, 'base64');
    process.env.WALLET_CALLBACK_NAGAD_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
    mockDb([pending({ method: 'nagad', transaction_id: 'NGD1', amount: '200.00' })]);
    const ok = await request(buildApp()).post('/wallet-callback/nagad').set('Content-Type', 'application/json').set('x-nd-signature', sign(privateKey)).send(nb);
    expect(ok.status).toBe(200);
    const bad = await request(buildApp()).post('/wallet-callback/nagad').set('Content-Type', 'application/json').set('x-nd-signature', sign(other.privateKey)).send(nb);
    expect(bad.status).toBe(401);
  });
});

describe('POST /wallet-callback/:provider — সমন্বয়', () => {
  const send = (body, provider = 'bkash') =>
    request(buildApp()).post(`/wallet-callback/${provider}`).set('Content-Type', 'application/json').set(`x-${provider === 'bkash' ? 'bkash' : provider}-signature`, hmac(body)).send(body);
  const good = JSON.stringify({ trxID: 'TRX123', amount: '500.00', transactionStatus: 'Completed', paymentID: 'P9' });

  test('মিললে ব্যালেন্স যোগ হয় (credited) এবং COMMIT হয়', async () => {
    const { queries } = mockDb([pending()]);
    const r = await send(good);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('credited');
    expect(creditApprovedDeposit).toHaveBeenCalledTimes(1);
    expect(queries).toContain('COMMIT');
  });
  test('একই কলব্যাক দ্বিতীয়বার (status=approved) -> ব্যালেন্স যোগ হয় না', async () => {
    mockDb([pending({ status: 'approved' })]);
    const r = await send(good);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('already_processed');
    expect(creditApprovedDeposit).not.toHaveBeenCalled();
  });
  test('পরিমাণ মিলল না -> ব্যালেন্স যোগ হয় না', async () => {
    mockDb([pending({ amount: '100.00' })]);
    const r = await send(good);
    expect(r.body.outcome).toBe('amount_mismatch');
    expect(creditApprovedDeposit).not.toHaveBeenCalled();
  });
  test('মুদ্রা BDT নয় -> ব্যালেন্স যোগ হয় না', async () => {
    mockDb([pending()]);
    const r = await send(JSON.stringify({ trxID: 'TRX123', amount: '500.00', currency: 'USD', transactionStatus: 'Completed' }));
    expect(r.body.outcome).toBe('amount_mismatch');
    expect(creditApprovedDeposit).not.toHaveBeenCalled();
  });
  test('ব্যর্থ লেনদেন (Failed) -> ব্যালেন্স যোগ হয় না', async () => {
    mockDb([pending()]);
    const r = await send(JSON.stringify({ trxID: 'TRX123', amount: '500.00', transactionStatus: 'Failed' }));
    expect(r.body.outcome).toBe('not_successful');
    expect(creditApprovedDeposit).not.toHaveBeenCalled();
  });
  test('অজানা TrxID -> 200, কিছুই তৈরি/যোগ হয় না', async () => {
    const { queries } = mockDb([]);
    const r = await send(good);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('unmatched');
    expect(creditApprovedDeposit).not.toHaveBeenCalled();
    expect(queries).not.toContain('INSERT');
  });
  test('ভেতরে ত্রুটি হলে 500 (ওয়ালেট রিট্রাই করবে) এবং ROLLBACK', async () => {
    const { queries } = mockDb([pending()]);
    creditApprovedDeposit.mockRejectedValueOnce(new Error('db down'));
    const r = await send(good);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ success: false, error: 'INTERNAL_ERROR' });
    expect(queries).toContain('ROLLBACK');
  });
  test('অন্য ওয়ালেটের লেনদেন দিয়ে মিল হয় না (method পৃথক)', async () => {
    const { client } = mockDb([]);
    await send(good, 'bkash');
    const call = client.query.mock.calls.find(([s]) => /FROM payment_requests/.test(s));
    expect(call[1]).toEqual(['bkash', 'TRX123']);
  });
});
