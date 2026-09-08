// services/wallet/index.js
// ---------------------------------------------------------------------------
// Seamless Wallet — প্রোভাইডার গেমের ব্যালেন্স মিউটেশনের **একমাত্র** পথ।
//
// ইন-হাউস গেম থাকার সময় ব্যালেন্স বদলাত routes/games.js-এর ভেতরে, ছড়ানো
// জায়গা থেকে। এখন RNG প্রোভাইডারের কাছে, আর টাকার হিসাব আমাদের কাছে — তাই
// প্রতিটা ডেবিট/ক্রেডিট ঠিক এখান দিয়েই যায়। রুট লেয়ার (routes/providerWallet.js)
// শুধু HTTP/স্বাক্ষর সামলায়, টাকার নিয়ম জানে না।
//
// অপরিবর্তনীয় নিয়ম (invariants):
//
//   ১. Atomicity — ব্যালেন্স পড়া, চেক করা ও লেখা একই DB ট্রানজেকশনে,
//      `SELECT ... FOR UPDATE` দিয়ে ইউজারের সারি lock করে। একই ইউজারের
//      সমান্তরাল bet/win সিরিয়ালাইজ হয়, lost update হয় না।
//
//   ২. Idempotency — provider_transactions-এ UNIQUE (provider, provider_tx_id)।
//      একই tx_id দ্বিতীয়বার এলে INSERT ব্যর্থ হয়, ট্রানজেকশন rollback হয়,
//      এবং প্রথমবারের সংরক্ষিত ফলাফলই হুবহু ফেরত যায় — ব্যালেন্স স্পর্শ হয় না।
//      দেখুন services/wallet/idempotency.js।
//
//   ৩. লেজার সামঞ্জস্য — coin_transactions-এ প্রতিটা এন্ট্রি ব্যালেন্স-পরিবর্তনের
//      সমান ও সঠিক চিহ্নসহ লেখা হয়:
//          bet      → -amount, type 'casino_bet'
//          win      → +amount, type 'game_play'
//          rollback → +amount, type 'casino_rollback'
//      এতে এই কোডবেসের মূল ইনভেরিয়েন্ট
//      (balance == starting + SUM(coin_transactions.amount)) অটুট থাকে —
//      tests/integration/financialLedgerIntegrity.test.js দেখুন।
//
//   ৪. Latency — mission/badge/referral/cashback-এর মতো ভারী কাজ কখনো
//      response ব্লক করে না; COMMIT-এর পরে job queue-তে যায়
//      (services/queueHandlers.js-এর 'provider_wallet_effects')।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const queue = require('../queue');
const idempotency = require('./idempotency');

// ইউজারের আসল ব্যালেন্স কলাম। demo মোডে প্রোভাইডার গেম চললে demo_balance
// ব্যবহৃত হয় — একই রাউন্ডের স্টেক ও পেআউট সবসময় একই কলামে থাকে।
const REAL_COL = 'coins';
const DEMO_COL = 'demo_balance';

/**
 * ওয়ালেট-লেয়ারের সব প্রত্যাশিত ব্যর্থতা এই এররে আসে। `code` মানটা
 * প্রোভাইডার-নিরপেক্ষ; অ্যাডাপ্টারের formatError() সেটাকে প্রোভাইডারের
 * নিজস্ব কোডে অনুবাদ করে (services/casinoProviders/, PHASE 3)।
 */
class WalletError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message || code);
    this.name = 'WalletError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const CODES = {
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  TX_NOT_FOUND: 'TX_NOT_FOUND',
  SESSION_INVALID: 'SESSION_INVALID'
};

function balanceColumn(mode) {
  return mode === 'demo' ? DEMO_COL : REAL_COL;
}

/**
 * অঙ্ক যাচাই — প্রোভাইডার থেকে আসা মান কখনো বিশ্বাস করা হয় না।
 * "10; DROP" বা "5abc"-এর মতো numeric-prefix ইনপুট প্রত্যাখ্যাত হয়।
 */
function parseAmount(value) {
  const ok =
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && /^\s*\d+(\.\d{1,2})?\s*$/.test(value));
  if (!ok) throw new WalletError(CODES.INVALID_AMOUNT, 'invalid amount');
  const n = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(n) || n < 0) throw new WalletError(CODES.INVALID_AMOUNT, 'invalid amount');
  return n;
}

// ==================== ব্যালেন্স পড়া ====================

async function getBalance(userId, mode = 'real') {
  const col = balanceColumn(mode);
  const r = await pool.query(`SELECT ${col} AS balance FROM users WHERE id = $1`, [userId]);
  if (!r.rows.length) throw new WalletError(CODES.USER_NOT_FOUND, 'user not found', 404);
  return Number(r.rows[0].balance);
}

// ==================== অভ্যন্তরীণ: এক ট্রানজেকশনে মিউটেশন ====================
//
// সব পথ (debit/credit/rollback) এই একটাই ফাংশন ব্যবহার করে, তাই lock, লেজার
// ও idempotency-র নিয়ম কোনো একটা পথে ভুল করে বাদ পড়তে পারে না।
//
// `delta` ধনাত্মক = ক্রেডিট, ঋণাত্মক = ডেবিট।
async function applyMutation({
  provider, providerTxId, roundId, userId, gameId, type, amount, delta,
  currency = 'BDT', mode = 'real', ledgerType, ledgerDescription, rawPayload,
  requireFunds = false
}) {
  // দ্রুত পথ: ইতিমধ্যে দেখা tx হলে DB ট্রানজেকশন খোলার দরকারই নেই।
  const seen = await idempotency.findExisting(pool, provider, providerTxId);
  if (seen) {
    return { duplicate: true, balance: Number(seen.balance_after), transaction: seen };
  }

  const col = balanceColumn(mode);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      `SELECT ${col} AS balance FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (!userRes.rows.length) {
      await client.query('ROLLBACK');
      throw new WalletError(CODES.USER_NOT_FOUND, 'user not found', 404);
    }

    const before = Number(userRes.rows[0].balance);
    if (requireFunds && before < amount) {
      // ব্যালেন্স স্পর্শ না করেই ফেরত — কোনো লেজার সারি, কোনো tx রেকর্ড নয়।
      await client.query('ROLLBACK');
      throw new WalletError(CODES.INSUFFICIENT_FUNDS, 'insufficient funds');
    }
    const after = Math.round((before + delta) * 100) / 100;

    // idempotency গার্ড সবার আগে: ডুপ্লিকেট হলে এখানেই 23505-এ থেমে যাবে,
    // ব্যালেন্স বা লেজারে কিছু লেখার আগেই।
    let txRow;
    try {
      const ins = await client.query(
        `INSERT INTO provider_transactions
           (provider, provider_tx_id, round_id, user_id, game_id, type, amount, currency,
            balance_before, balance_after, status, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11)
         RETURNING id, type, amount, currency, balance_before, balance_after, status, round_id, game_id, created_at`,
        [provider, providerTxId, roundId || null, userId, gameId || null, type, amount, currency,
         before, after, rawPayload ? JSON.stringify(rawPayload) : null]
      );
      txRow = ins.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      if (idempotency.isDuplicateError(err)) {
        // অন্য একটা সমান্তরাল রিকোয়েস্ট আমাদের আগে জিতেছে — তার ফলাফলই সত্য।
        const existing = await idempotency.findExisting(pool, provider, providerTxId);
        if (existing) {
          return { duplicate: true, balance: Number(existing.balance_after), transaction: existing };
        }
      }
      throw err;
    }

    await client.query(`UPDATE users SET ${col} = $1 WHERE id = $2`, [after, userId]);

    // ডেমো রাউন্ডের ফল আসল লেজারে যায় না — আলাদা demo_transactions টেবিলে।
    if (mode === 'demo') {
      await client.query(
        `INSERT INTO demo_transactions (user_id, category, type, amount, description)
         VALUES ($1, 'casino', $2, $3, $4)`,
        [userId, type === 'bet' ? 'bet' : 'win', amount, ledgerDescription]
      );
    } else {
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,$3,$4)`,
        [userId, delta, ledgerType, ledgerDescription]
      );
    }

    await client.query('COMMIT');
    return { duplicate: false, balance: after, transaction: txRow };
  } catch (err) {
    // BEGIN-এর পরে যেকোনো অপ্রত্যাশিত ব্যর্থতায় ট্রানজেকশন যেন খোলা না থাকে।
    try { await client.query('ROLLBACK'); } catch (e) { /* ইতিমধ্যে rollback হয়ে থাকতে পারে */ }
    throw err;
  } finally {
    client.release();
  }
}

// ==================== bet (ডেবিট) ====================

async function debit({ provider, providerTxId, roundId, userId, gameId, amount, currency, mode, rawPayload }) {
  const amt = parseAmount(amount);
  const result = await applyMutation({
    provider, providerTxId, roundId, userId, gameId,
    type: 'bet',
    amount: amt,
    delta: -amt,
    currency, mode, rawPayload,
    requireFunds: true,
    ledgerType: 'casino_bet',
    ledgerDescription: `${provider} ${gameId || ''} বাজি`.trim()
  });

  if (!result.duplicate && mode !== 'demo' && amt > 0) {
    // response ব্লক না করে ব্যাকগ্রাউন্ডে: turnover, cashback, VIP,
    // referral commission, mission progress, loyalty points।
    queue.enqueue('provider_wallet_effects', {
      kind: 'bet', userId, provider, gameId, amount: amt
    });
  }
  return result;
}

// ==================== win (ক্রেডিট) ====================

async function credit({ provider, providerTxId, roundId, userId, gameId, amount, currency, mode, rawPayload }) {
  const amt = parseAmount(amount);
  const result = await applyMutation({
    provider, providerTxId, roundId, userId, gameId,
    type: 'win',
    amount: amt,
    delta: amt,
    currency, mode, rawPayload,
    requireFunds: false,
    ledgerType: 'game_play',
    ledgerDescription: `${provider} ${gameId || ''} জয়`.trim()
  });

  if (!result.duplicate && mode !== 'demo') {
    queue.enqueue('provider_wallet_effects', {
      kind: 'win', userId, provider, gameId, amount: amt, roundId
    });
  }
  return result;
}

// ==================== rollback / refund ====================
//
// প্রোভাইডার একটা bet বাতিল করলে সেই টাকা ফেরত দিতে হয়। দুবার rollback এলে
// দ্বিতীয়টা no-op — দুই স্তরের সুরক্ষা:
//   ক. rollback নিজেই একটা provider_tx_id নিয়ে আসে → UNIQUE কনস্ট্রেইন্ট
//   খ. মূল লেনদেনের status 'rolled_back' হয়ে যায় → একই bet দুবার ফেরত যায় না
async function rollback({ provider, providerTxId, roundId, referenceTxId, userId, gameId, currency, mode, rawPayload }) {
  const seen = await idempotency.findExisting(pool, provider, providerTxId);
  if (seen) {
    return { duplicate: true, balance: Number(seen.balance_after), transaction: seen };
  }

  // কোন লেনদেনটা ফেরত দিতে হবে? প্রোভাইডার হয় সরাসরি tx_id দেয়, নাহলে round_id।
  let original = null;
  if (referenceTxId) {
    original = await idempotency.findExisting(pool, provider, referenceTxId);
  } else if (roundId) {
    const rows = await idempotency.findByRound(pool, provider, roundId, 'bet');
    original = rows.find(r => r.status === 'completed') || rows[0] || null;
  }

  if (!original) {
    // কিছুই ডেবিট হয়নি এমন রাউন্ডের rollback — ইচ্ছাকৃতভাবে সফল no-op।
    // প্রোভাইডাররা টাইমআউটের পর প্রায়ই "নিশ্চিত হতে" rollback পাঠায়; এটাকে
    // এরর করলে তারা অনির্দিষ্টকাল রিট্রাই করতে থাকে।
    const balance = await getBalance(userId, mode);
    return { duplicate: false, noop: true, balance, transaction: null };
  }

  if (original.status === 'rolled_back') {
    const balance = await getBalance(userId, mode);
    return { duplicate: true, noop: true, balance, transaction: original };
  }

  const amt = Number(original.amount);
  const result = await applyMutation({
    provider, providerTxId, roundId: roundId || original.round_id, userId, gameId,
    type: 'rollback',
    amount: amt,
    delta: amt,
    currency, mode, rawPayload,
    requireFunds: false,
    ledgerType: 'casino_rollback',
    ledgerDescription: `${provider} ${gameId || ''} বাজি ফেরত`.trim()
  });

  if (!result.duplicate) {
    await pool.query(
      `UPDATE provider_transactions SET status = 'rolled_back' WHERE id = $1 AND status = 'completed'`,
      [original.id]
    );
  }
  return result;
}

// ==================== একক লেনদেন লুকআপ ====================

async function getTransaction(provider, providerTxId) {
  const row = await idempotency.findExisting(pool, provider, providerTxId);
  if (!row) throw new WalletError(CODES.TX_NOT_FOUND, 'transaction not found', 404);
  return row;
}

module.exports = {
  getBalance, debit, credit, rollback, getTransaction,
  parseAmount, WalletError, CODES
};
