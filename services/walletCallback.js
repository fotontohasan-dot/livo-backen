// services/walletCallback.js
// ---------------------------------------------------------------------------
// bKash / Nagad / Rocket / Upay -এর পেমেন্ট কলব্যাক প্রক্রিয়াকরণ।
//
//   1. যাচাই: IP allow-list (ঐচ্ছিক) + স্বাক্ষর (HMAC-SHA256 অথবা RSA-SHA256)
//   2. ওয়ালেটভেদে আলাদা payload -> সাধারণ ফরম্যাট
//   3. pending ডিপোজিটের সাথে মিলিয়ে (TrxID + পরিমাণ + মুদ্রা) ব্যালেন্স যোগ
//
// নিরাপত্তা নীতি:
//   . সিক্রেট/পাবলিক-কী কনফিগার না থাকলে fail-closed (অনুরোধ প্রত্যাখ্যাত)
//   . স্বাক্ষর না মিললে ডেটাবেসে যাওয়ার আগেই থেমে যায়
//   . কলব্যাক দিয়ে নতুন ডিপোজিট তৈরি হয় না; কেবল ব্যবহারকারীর তৈরি pending
//     রিকোয়েস্ট নিশ্চিত হয়
//   . একই কলব্যাক বারবার এলে দুইবার ব্যালেন্স যোগ হয় না (SELECT ... FOR UPDATE
//     + status='pending' পরীক্ষা, তাই একাধিক সার্ভার ইনস্ট্যান্সেও নিরাপদ)
//   . পরিমাণ/মুদ্রা না মিললে ব্যালেন্স যোগ হয় না
//
// স্বাক্ষরের সঠিক নিয়ম (হেডারের নাম, অ্যালগরিদম, টাইমস্ট্যাম্প আছে কিনা) প্রতিটি
// ওয়ালেটের মার্চেন্ট ডকুমেন্টেশন অনুযায়ী WALLET_CONFIG-এ বসাতে হবে। নিচের মান
// অনুমানভিত্তিক ডিফল্ট; আসল ডক না মিলিয়ে প্রোডাকশনে চালাবেন না।
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { pool } = require('../db');

const WALLETS = Object.freeze(['bkash', 'nagad', 'rocket', 'upay']);

// ---- ওয়ালেট কনফিগারেশন (এখানে শুধু নাম/অ্যালগরিদম বদলালেই চলবে) ----
//  sigHeader   : স্বাক্ষর যে হেডারে আসে
//  tsHeader    : টাইমস্ট্যাম্প হেডার (null হলে টাইমস্ট্যাম্প-চেক নেই; তখন রিপ্লে
//                ঠেকায় শুধু "একবারই pending -> approved" নিয়ম)
//  algo        : 'hmac-sha256' | 'rsa-sha256'
//  encoding    : hex | base64 (HMAC-এর জন্য; RSA সবসময় base64)
//  signedFormat: 'body' -> শুধু rawBody, 'ts+body' -> timestamp + rawBody
const WALLET_CONFIG = Object.freeze({
  bkash:  { sigHeader: 'x-bkash-signature',  tsHeader: null, algo: 'hmac-sha256', encoding: 'hex', signedFormat: 'body' },
  nagad:  { sigHeader: 'x-nd-signature',     tsHeader: null, algo: 'rsa-sha256',  encoding: 'base64', signedFormat: 'body' },
  rocket: { sigHeader: 'x-rocket-signature', tsHeader: null, algo: 'hmac-sha256', encoding: 'hex', signedFormat: 'body' },
  upay:   { sigHeader: 'x-upay-signature',   tsHeader: null, algo: 'hmac-sha256', encoding: 'hex', signedFormat: 'body' }
});

// ---- ওয়ালেটভেদে payload ফিল্ডের নাম (আসল sandbox JSON দেখে মিলিয়ে নিন) ----
const FIELD_MAP = Object.freeze({
  bkash:  { trxId: ['trxID', 'trxId', 'transactionId'], amount: ['amount'], status: ['transactionStatus', 'status'], currency: ['currency'], payer: ['customerMsisdn', 'payerAccount'], paymentId: ['paymentID', 'paymentId'], success: ['completed'] },
  nagad:  { trxId: ['issuerPaymentRefNo', 'merchantOrderId', 'orderId'], amount: ['amount'], status: ['status'], currency: ['currency'], payer: ['clientMobileNo'], paymentId: ['paymentRefId'], success: ['success'] },
  rocket: { trxId: ['txnId', 'trx_id', 'transactionId'], amount: ['amount'], status: ['status'], currency: ['currency'], payer: ['sender'], paymentId: ['reference'], success: ['success', 'completed', 'successful'] },
  upay:   { trxId: ['transactionId', 'trx_id', 'txn_id'], amount: ['amount'], status: ['status'], currency: ['currency'], payer: ['sender'], paymentId: ['merchantTxnId'], success: ['success', 'completed', 'successful'] }
});

const MAX_TRX_ID_LEN = 64;
const TRX_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_WINDOW_SECONDS = Number(process.env.WALLET_CALLBACK_WINDOW_SECONDS || 300);

// ---- env ----
function envKey(wallet, suffix) {
  return `WALLET_CALLBACK_${String(wallet).toUpperCase()}_${suffix}`;
}
function secretFor(wallet) { return process.env[envKey(wallet, 'SECRET')] || null; }
function publicKeyFor(wallet) {
  const v = process.env[envKey(wallet, 'PUBLIC_KEY')];
  return v ? v.replace(/\\n/g, '\n') : null; // .env-এ এক লাইনে \n দিয়ে লেখা PEM-ও চলবে
}
function allowedIps(wallet) {
  return (process.env[envKey(wallet, 'IPS')] || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function normalizeIp(ip) { return String(ip || '').replace(/^::ffff:/, ''); }
function isIpAllowed(req, wallet) {
  const list = allowedIps(wallet);
  if (list.length === 0) return true; // allow-list না থাকলে শুধু স্বাক্ষরের ওপর নির্ভর
  return list.includes(normalizeIp(req.ip));
}

// ---- স্বাক্ষর যাচাই ----
function safeEqual(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function isFreshTimestamp(ts, nowMs = Date.now()) {
  const raw = Number(ts);
  if (!Number.isFinite(raw)) return false;
  const ms = Math.abs(raw) < 1e11 ? raw * 1000 : raw;
  return Math.abs(nowMs - ms) <= SIGNATURE_WINDOW_SECONDS * 1000;
}

/** @returns {{ ok: boolean, reason?: string }} */
function verifyRequest(req, wallet) {
  const cfg = WALLET_CONFIG[wallet];
  if (!cfg) return { ok: false, reason: 'unsupported_wallet' };

  const raw = req.rawBody;
  if (!Buffer.isBuffer(raw) || raw.length === 0) return { ok: false, reason: 'missing_raw_body' };

  const sig = req.get(cfg.sigHeader);
  if (!sig) return { ok: false, reason: 'missing_signature' };

  let signed = raw;
  if (cfg.tsHeader) {
    const ts = req.get(cfg.tsHeader);
    if (!isFreshTimestamp(ts)) return { ok: false, reason: 'stale_timestamp' };
    if (cfg.signedFormat === 'ts+body') signed = Buffer.concat([Buffer.from(String(ts)), raw]);
  }

  if (cfg.algo === 'rsa-sha256') {
    const pub = publicKeyFor(wallet);
    if (!pub) return { ok: false, reason: 'no_key_configured' };
    try {
      const v = crypto.createVerify('RSA-SHA256');
      v.update(signed); v.end();
      return v.verify(pub, sig, 'base64') ? { ok: true } : { ok: false, reason: 'bad_signature' };
    } catch (_) { return { ok: false, reason: 'bad_key_or_signature_format' }; }
  }

  const secret = secretFor(wallet);
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  const expected = crypto.createHmac('sha256', secret).update(signed).digest(cfg.encoding);
  return safeEqual(expected, sig) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// ---- payload রূপান্তর ----
function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}

function parseAmount(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null; // শুধু ধনাত্মক, সর্বোচ্চ ২ দশমিক
  const n = Number(s);
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** @returns {{ ok: true, data } | { ok: false, reason: string }} */
function normalizePayload(wallet, body) {
  const map = FIELD_MAP[wallet];
  if (!map) return { ok: false, reason: 'unsupported_wallet' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'invalid_body' };

  const trx = pick(body, map.trxId);
  if (typeof trx !== 'string' && typeof trx !== 'number') return { ok: false, reason: 'missing_trx_id' };
  const trxId = String(trx).trim();
  if (!trxId || trxId.length > MAX_TRX_ID_LEN || !TRX_ID_PATTERN.test(trxId)) return { ok: false, reason: 'invalid_trx_id' };

  const amount = parseAmount(pick(body, map.amount));
  if (amount === null) return { ok: false, reason: 'invalid_amount' };

  const status = String(pick(body, map.status) || '').toLowerCase();
  const currency = String(pick(body, map.currency) || 'BDT').toUpperCase();
  const payer = pick(body, map.payer);
  const paymentId = pick(body, map.paymentId);

  return {
    ok: true,
    data: {
      wallet, trxId, amount, currency, status,
      isSuccess: map.success.includes(status),
      payer: payer ? String(payer).slice(0, 32) : null,
      paymentId: paymentId ? String(paymentId).slice(0, 128) : null
    }
  };
}

function amountsEqual(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }

/**
 * pending ডিপোজিটের সাথে মিলিয়ে নিশ্চিত করা। creditApprovedDeposit ব্যবহার করে,
 * তাই অ্যাডমিন অনুমোদনের সাথে ব্যালেন্স/বোনাস/রেফারেল/নোটিফিকেশন লজিক অভিন্ন।
 * @returns {Promise<{ outcome: string, requestId?: number }>}
 */
async function reconcile(data, creditApprovedDeposit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT * FROM payment_requests WHERE type='deposit' AND method=$1 AND transaction_id=$2 FOR UPDATE`,
      [data.wallet, data.trxId]
    );
    const request = found.rows[0];

    if (!request) { await client.query('ROLLBACK'); return { outcome: 'unmatched' }; }
    if (request.status !== 'pending') { await client.query('ROLLBACK'); return { outcome: 'already_processed', requestId: request.id }; }

    const note = (extra) => JSON.stringify({ source: 'wallet_callback', wallet: data.wallet, status: data.status, at: new Date().toISOString(), ...extra });

    if (!data.isSuccess) {
      await client.query(`UPDATE payment_requests SET gateway_response=$1, updated_at=NOW() WHERE id=$2`, [note({}), request.id]);
      await client.query('COMMIT');
      return { outcome: 'not_successful', requestId: request.id };
    }

    if (!amountsEqual(request.amount, data.amount) || data.currency !== 'BDT') {
      await client.query(`UPDATE payment_requests SET gateway_response=$1, updated_at=NOW() WHERE id=$2`,
        [note({ mismatch: true, callbackAmount: data.amount, currency: data.currency }), request.id]);
      await client.query('COMMIT');
      return { outcome: 'amount_mismatch', requestId: request.id };
    }

    await client.query(`UPDATE payment_requests SET gateway_val_id=$1, gateway_response=$2 WHERE id=$3`,
      [data.paymentId, note({ payer: data.payer }), request.id]);
    await creditApprovedDeposit(client, request);
    await client.query('COMMIT');
    return { outcome: 'credited', requestId: request.id, userId: request.user_id, amount: request.amount };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { WALLETS, WALLET_CONFIG, FIELD_MAP, secretFor, publicKeyFor, allowedIps, isIpAllowed, verifyRequest, normalizePayload, parseAmount, reconcile };
