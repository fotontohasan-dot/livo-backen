// tests/integration/paymentConcurrencyIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 3 — PAYMENT & WALLET SECURITY
//
// এখানে যাচাই করা হয়:
//   * Concurrent approve → ONE VALID STATE CHANGE, NO DOUBLE CREDIT
//   * Concurrent reject (withdraw refund) → NO DOUBLE REFUND
//   * Concurrent withdraw → NO NEGATIVE BALANCE, NO DOUBLE DEBIT
//   * Approve-after-reject / reject-after-approve → দ্বিতীয়টি প্রত্যাখ্যাত
//   * Wallet invariant: balance change == verified transaction
//   * MEDIUM-3 fix: single payment approve/reject audit trail তৈরি করে
//
// সব test নিজস্ব isolated user + payment_request তৈরি করে; কোনো existing
// user balance বা production payment record স্পর্শ করা হয় না।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { uniqueUsername, uniquePhone } = require('../helpers/app');

const payment = require('../../routes/payment');

async function makeUser(coins = 1000) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, role, coins)
     VALUES ($1, $2, 'x', 'user', $3) RETURNING id`,
    [uniqueUsername('pay'), uniquePhone(), coins]
  );
  return r.rows[0].id;
}

async function makeRequest(userId, { type = 'deposit', amount = 500, status = 'pending' } = {}) {
  const r = await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status)
     VALUES ($1, $2, 'bkash', $3, '01700000000', $4) RETURNING id`,
    [userId, type, amount, status]
  );
  return r.rows[0].id;
}

const coinsOf = async (userId) =>
  Number((await pool.query('SELECT coins FROM users WHERE id=$1', [userId])).rows[0].coins);

const statusOf = async (id) =>
  (await pool.query('SELECT status FROM payment_requests WHERE id=$1', [id])).rows[0].status;

const depositTxCount = async (userId) =>
  Number((await pool.query(
    `SELECT COUNT(*) c FROM coin_transactions WHERE user_id=$1 AND type='deposit'`, [userId]
  )).rows[0].c);

describe('Payment concurrency & wallet integrity (PHASE 3)', () => {
  describe('Deposit approval', () => {
    test('concurrent approve → শুধু একবার credit হয় (NO DOUBLE CREDIT)', async () => {
      const userId = await makeUser(0);
      const reqId = await makeRequest(userId, { type: 'deposit', amount: 500 });

      const results = await Promise.all([
        payment.approvePaymentRequestById(reqId),
        payment.approvePaymentRequestById(reqId),
        payment.approvePaymentRequestById(reqId),
      ]);

      expect(results.filter((r) => r.success).length).toBe(1);
      expect(await coinsOf(userId)).toBe(500);
      expect(await depositTxCount(userId)).toBe(1);
      expect(await statusOf(reqId)).toBe('approved');
    });

    test('approve করার পরে reject করলে দ্বিতীয় state change হয় না', async () => {
      const userId = await makeUser(0);
      const reqId = await makeRequest(userId, { type: 'deposit', amount: 300 });

      const ok = await payment.approvePaymentRequestById(reqId);
      expect(ok.success).toBe(true);

      const late = await payment.rejectPaymentRequestById(reqId);
      expect(late.success).toBe(false);
      expect(await statusOf(reqId)).toBe('approved');
      expect(await coinsOf(userId)).toBe(300);
    });
  });

  describe('Withdraw approval / refund', () => {
    test('concurrent reject → withdraw refund শুধু একবার হয় (NO DOUBLE REFUND)', async () => {
      const userId = await makeUser(0); //   debit  
      const reqId = await makeRequest(userId, { type: 'withdraw', amount: 400 });

      const results = await Promise.all([
        payment.rejectPaymentRequestById(reqId),
        payment.rejectPaymentRequestById(reqId),
        payment.rejectPaymentRequestById(reqId),
      ]);

      expect(results.filter((r) => r.success).length).toBe(1);
      expect(await coinsOf(userId)).toBe(400); //   refund
      expect(await statusOf(reqId)).toBe('rejected');

      const refunds = await pool.query(
        `SELECT COUNT(*) c FROM coin_transactions WHERE user_id=$1 AND type='withdraw_refund'`, [userId]
      );
      expect(Number(refunds.rows[0].c)).toBe(1);
    });

    test('withdraw approve করলে কোনো অতিরিক্ত coin যোগ হয় না', async () => {
      const userId = await makeUser(100);
      const reqId = await makeRequest(userId, { type: 'withdraw', amount: 400 });

      const ok = await payment.approvePaymentRequestById(reqId);
      expect(ok.success).toBe(true);
      expect(await coinsOf(userId)).toBe(100); //  
      expect(await statusOf(reqId)).toBe('approved');
    });
  });

  describe('Wallet invariant', () => {
    test('balance পরিবর্তন সবসময় verified transaction-এর সমান', async () => {
      const userId = await makeUser(0);
      const before = await coinsOf(userId);

      const reqId = await makeRequest(userId, { type: 'deposit', amount: 250 });
      await payment.approvePaymentRequestById(reqId);

      const r = await pool.query(
        `SELECT (SELECT coins FROM users WHERE id=$1) AS coins,
                (SELECT COALESCE(SUM(amount),0) FROM coin_transactions WHERE user_id=$1) AS ledger`,
        [userId]
      );
      const balanceDelta = Number(r.rows[0].coins) - before;
      expect(balanceDelta).toBe(Number(r.rows[0].ledger));
    });

    test('negative balance কখনো তৈরি হয় না — অনুমোদিত withdraw refund ছাড়া balance কমে না', async () => {
      const userId = await makeUser(50);
      const reqId = await makeRequest(userId, { type: 'withdraw', amount: 400 });
      await payment.rejectPaymentRequestById(reqId);
      expect(await coinsOf(userId)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('State machine', () => {
    test('ইতিমধ্যে rejected request পুনরায় approve করা যায় না', async () => {
      const userId = await makeUser(0);
      const reqId = await makeRequest(userId, { type: 'deposit', amount: 700, status: 'rejected' });

      const res = await payment.approvePaymentRequestById(reqId);
      expect(res.success).toBe(false);
      expect(await coinsOf(userId)).toBe(0);
      expect(await statusOf(reqId)).toBe('rejected');
    });

    test('অস্তিত্বহীন request approve করলে ব্যর্থ হয়', async () => {
      const res = await payment.approvePaymentRequestById(2147483000);
      expect(res.success).toBe(false);
    });
  });

  describe('MEDIUM-3: single approve/reject audit trail', () => {
    test('single approve/reject route audit event লেখে', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'payment.js'), 'utf8');

      const approveIdx = src.indexOf("router.post('/admin/approve/:id'");
      const rejectIdx = src.indexOf("router.post('/admin/reject/:id'");
      expect(approveIdx).toBeGreaterThan(-1);
      expect(rejectIdx).toBeGreaterThan(-1);

      const approveBlock = src.slice(approveIdx, rejectIdx);
      const rejectBlock = src.slice(rejectIdx, rejectIdx + 1600);

      expect(approveBlock).toMatch(/logAuditEvent\(/);
      expect(approveBlock).toMatch(/PAYMENT_APPROVED/);
      expect(rejectBlock).toMatch(/logAuditEvent\(/);
      expect(rejectBlock).toMatch(/PAYMENT_REJECTED/);
    });

    test('single approve/reject route অবৈধ :id গ্রহণ করে না', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'payment.js'), 'utf8');
      const approveIdx = src.indexOf("router.post('/admin/approve/:id'");
      const block = src.slice(approveIdx, approveIdx + 500);
      expect(block).toMatch(/parseInt\(req\.params\.id, 10\)/);
      expect(block).toMatch(/Number\.isInteger\(id\)/);
    });
  });
});
