// routes/providerWallet.js
// ---------------------------------------------------------------------------
// Seamless Wallet API — প্রোভাইডার সার্ভার→আমাদের সার্ভার কলব্যাক।
//
// প্রায় সব ক্যাসিনো অ্যাগ্রিগেটর এই পাঁচটা এন্ডপয়েন্ট চায়:
//   POST /provider/:provider/balance
//   POST /provider/:provider/bet
//   POST /provider/:provider/win
//   POST /provider/:provider/rollback
//   GET  /provider/:provider/transaction/:txId
//
// এই রুট লেয়ার ইচ্ছাকৃতভাবে "পাতলা": HTTP, রেট-লিমিট ও ফরম্যাটিং ছাড়া
// এখানে কোনো ব্যবসায়িক নিয়ম নেই। টাকার সব সিদ্ধান্ত services/wallet/-এ,
// অথেন্টিকেশন middleware/providerAuth.js-এ, আর প্রোভাইডার-নির্দিষ্ট
// পার্সিং/ফরম্যাটিং অ্যাডাপ্টারে (PHASE 3)।
//
// লেটেন্সি: এই রুটগুলো ২০০ms-এর নিচে থাকতে হবে (প্রোভাইডারের SLA)। তাই
// mission/badge/referral-এর মতো ভারী কাজ ওয়ালেট লেয়ার COMMIT-এর পরে
// job queue-তে ঠেলে দেয় — কোনো রুট হ্যান্ডলার সেগুলোর জন্য await করে না।
//
// CSRF: এই পাথগুলো middleware/csrf.js-এর EXEMPT_PREFIXES-এ আছে — কলার একটা
// এক্সটার্নাল সার্ভার, ব্রাউজার সেশন নেই। বদলে HMAC + IP allow-list।
// ---------------------------------------------------------------------------

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { pool } = require('../db');
const wallet = require('../services/wallet');
const providerAuth = require('../middleware/providerAuth');
const { requireFeature } = require('../middleware/featureGate');
const { createRedisStore } = require('../middleware/redisRateLimitStore');

// প্রোভাইডার সার্ভার থেকে আসা ট্রাফিক ব্যবহারকারীর ট্রাফিকের চেয়ে অনেক বেশি
// ঘন — সীমাটা উদার, কিন্তু অসীম নয় (ভুল কনফিগারে অসীম রিট্রাই লুপ ঠেকাতে)।
const walletLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: false,
  legacyHeaders: false,
  store: createRedisStore('provider-wallet'),
  keyGenerator: (req) => `${req.params.provider || 'unknown'}:${req.ip}`,
  handler: (req, res) => res.status(429).json({ success: false, error: 'RATE_LIMITED' })
});

router.use(requireFeature('provider_wallet'));

// ==================== রিকোয়েস্ট পার্সিং ====================
//
// অ্যাডাপ্টার থাকলে তার parseWalletRequest() ব্যবহৃত হয় — প্রতিটা প্রোভাইডারের
// ফিল্ডের নাম আলাদা (tx_id / transactionId / reference ইত্যাদি)। না থাকলে
// একটা সাধারণ স্কিমা ধরা হয়, যেটা টেস্ট ও mock প্রোভাইডারের জন্য যথেষ্ট।
function parseRequest(req, type) {
  const adapter = req.providerAdapter;
  if (adapter && typeof adapter.parseWalletRequest === 'function') {
    return { ...adapter.parseWalletRequest(req), type };
  }
  const b = req.body || {};
  return {
    type,
    txId: b.tx_id || b.transaction_id || null,
    roundId: b.round_id || null,
    referenceTxId: b.reference_tx_id || b.original_tx_id || null,
    sessionToken: b.session_token || b.token || null,
    userId: b.user_id || null,
    gameId: b.game_id || null,
    amount: b.amount,
    currency: b.currency || 'BDT'
  };
}

/**
 * প্রোভাইডার কোন ইউজারের কথা বলছে সেটা নির্ধারণ।
 *
 * পছন্দের পথ session token: গেম লঞ্চের সময় আমরা যে টোকেন তৈরি করেছি
 * (game_sessions) প্রোভাইডার সেটাই ফেরত পাঠায়। এতে একটা কলব্যাক কখনো
 * নিজের ইচ্ছেমতো user_id দাবি করতে পারে না — টোকেনই বাঁধন।
 */
async function resolveUser(parsed) {
  if (parsed.sessionToken) {
    const r = await pool.query(
      `SELECT user_id, mode, game_id FROM game_sessions
        WHERE session_token = $1 AND closed_at IS NULL AND expires_at > NOW()`,
      [parsed.sessionToken]
    );
    if (!r.rows.length) {
      throw new wallet.WalletError(wallet.CODES.SESSION_INVALID, 'invalid or expired session', 401);
    }
    return { userId: r.rows[0].user_id, mode: r.rows[0].mode || 'real', gameId: parsed.gameId || r.rows[0].game_id };
  }
  const id = parseInt(parsed.userId, 10);
  if (!Number.isFinite(id)) {
    throw new wallet.WalletError(wallet.CODES.SESSION_INVALID, 'no session token or user id', 400);
  }
  return { userId: id, mode: 'real', gameId: parsed.gameId };
}

// ==================== রেসপন্স ফরম্যাটিং ====================

function ok(req, res, payload) {
  const adapter = req.providerAdapter;
  if (adapter && typeof adapter.formatWalletResponse === 'function') {
    return res.json(adapter.formatWalletResponse(payload));
  }
  return res.json({ success: true, ...payload });
}

function fail(req, res, err) {
  const adapter = req.providerAdapter;
  const code = err instanceof wallet.WalletError ? err.code : 'INTERNAL_ERROR';
  const status = err instanceof wallet.WalletError ? err.httpStatus : 500;
  if (!(err instanceof wallet.WalletError)) {
    console.error(`[providerWallet] ${req.params.provider}:`, err.message);
  }
  if (adapter && typeof adapter.formatError === 'function') {
    return res.status(status).json(adapter.formatError(code));
  }
  return res.status(status).json({ success: false, error: code });
}

// ==================== এন্ডপয়েন্ট ====================

router.post('/:provider/balance', walletLimiter, providerAuth, async (req, res) => {
  try {
    const parsed = parseRequest(req, 'balance');
    const { userId, mode } = await resolveUser(parsed);
    const balance = await wallet.getBalance(userId, mode);
    return ok(req, res, { balance, currency: parsed.currency });
  } catch (err) {
    return fail(req, res, err);
  }
});

router.post('/:provider/bet', walletLimiter, providerAuth, async (req, res) => {
  try {
    const parsed = parseRequest(req, 'bet');
    if (!parsed.txId) throw new wallet.WalletError('MISSING_TX_ID', 'tx id required');
    const { userId, mode, gameId } = await resolveUser(parsed);
    const result = await wallet.debit({
      provider: req.providerName,
      providerTxId: parsed.txId,
      roundId: parsed.roundId,
      userId, gameId, mode,
      amount: parsed.amount,
      currency: parsed.currency,
      rawPayload: req.body
    });
    return ok(req, res, {
      balance: result.balance,
      currency: parsed.currency,
      transaction_id: parsed.txId,
      duplicate: !!result.duplicate
    });
  } catch (err) {
    return fail(req, res, err);
  }
});

router.post('/:provider/win', walletLimiter, providerAuth, async (req, res) => {
  try {
    const parsed = parseRequest(req, 'win');
    if (!parsed.txId) throw new wallet.WalletError('MISSING_TX_ID', 'tx id required');
    const { userId, mode, gameId } = await resolveUser(parsed);
    const result = await wallet.credit({
      provider: req.providerName,
      providerTxId: parsed.txId,
      roundId: parsed.roundId,
      userId, gameId, mode,
      amount: parsed.amount,
      currency: parsed.currency,
      rawPayload: req.body
    });
    return ok(req, res, {
      balance: result.balance,
      currency: parsed.currency,
      transaction_id: parsed.txId,
      duplicate: !!result.duplicate
    });
  } catch (err) {
    return fail(req, res, err);
  }
});

router.post('/:provider/rollback', walletLimiter, providerAuth, async (req, res) => {
  try {
    const parsed = parseRequest(req, 'rollback');
    if (!parsed.txId) throw new wallet.WalletError('MISSING_TX_ID', 'tx id required');
    const { userId, mode, gameId } = await resolveUser(parsed);
    const result = await wallet.rollback({
      provider: req.providerName,
      providerTxId: parsed.txId,
      roundId: parsed.roundId,
      referenceTxId: parsed.referenceTxId,
      userId, gameId, mode,
      currency: parsed.currency,
      rawPayload: req.body
    });
    return ok(req, res, {
      balance: result.balance,
      currency: parsed.currency,
      transaction_id: parsed.txId,
      duplicate: !!result.duplicate
    });
  } catch (err) {
    return fail(req, res, err);
  }
});

// প্রোভাইডার রিকনসিলিয়েশনে ব্যবহার করে: "এই tx তোমাদের কাছে পৌঁছেছিল কি?"
router.get('/:provider/transaction/:txId', walletLimiter, providerAuth, async (req, res) => {
  try {
    const row = await wallet.getTransaction(req.providerName, req.params.txId);
    return ok(req, res, {
      transaction_id: req.params.txId,
      type: row.type,
      amount: Number(row.amount),
      currency: row.currency,
      balance_after: Number(row.balance_after),
      status: row.status,
      created_at: row.created_at
    });
  } catch (err) {
    return fail(req, res, err);
  }
});

module.exports = router;
