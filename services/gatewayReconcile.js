// services/gatewayReconcile.js
// ---------------------------------------------------------------------------
// গেটওয়ে ডিপোজিট রিকনসিলিয়েশন — আটকে থাকা pending রিকোয়েস্ট নিষ্পত্তি করে।
//
// কেন দরকার:
//   SSLCommerz ডিপোজিট ক্রেডিট হওয়ার দুটো পথ — ইউজারের ব্রাউজার /success-এ ফিরে
//   আসা, আর সার্ভার-টু-সার্ভার /ipn। দুটোই ব্যর্থ হতে পারে: ইউজার পেমেন্ট করেই
//   ট্যাব বন্ধ করে দিল, আর সেই মুহূর্তে আমাদের সার্ভার ডাউন/ডিপ্লয় হচ্ছিল বলে IPN-ও
//   হারিয়ে গেল (গেটওয়ের রিট্রাই সীমিত)। তখন টাকা কেটে নেওয়া হয়েছে অথচ রিকোয়েস্ট
//   চিরকাল 'pending' — ইউজার কয়েন পায় না, আর অ্যাডমিনের হাতেও এটা ধরার কোনো
//   স্বয়ংক্রিয় উপায় ছিল না।
//
//   এই জব তাই তৃতীয় ও শেষ স্তর: গেটওয়েকে নিজে থেকে জিজ্ঞেস করে "এই tran_id-র
//   আসল অবস্থা কী?" এবং সেই উত্তর অনুযায়ী নিষ্পত্তি করে।
//
// নিরাপত্তা ও আর্থিক নিয়ম:
//   • ক্রেডিট করার শর্ত /ipn-এর সাথে হুবহু এক — status VALID/VALIDATED, স্টোর-
//     কারেন্সিতে amount মিল, currency মিল। কোনো শর্ত শিথিল করা হয়নি।
//   • FOR UPDATE + status পুনঃযাচাই একই ট্রানজেকশনে, তাই একই সময়ে IPN এসে গেলেও
//     ডাবল ক্রেডিট হয় না (idempotent)।
//   • গেটওয়ে ক্রেডেনশিয়াল না থাকলে কিছুই করা হয় না — অনুমান করে reject/credit
//     করা হয় না। fail-closed।
//   • গেটওয়ে কল ব্যর্থ হলে ওই রো ছোঁয়া হয় না, পরের রানে আবার চেষ্টা হয়।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const sslcommerz = require('./sslcommerz');
const paymentVerification = require('./paymentVerification');

// এত সময় পার হওয়ার আগে হাত দেওয়া হয় না — ইউজার তখনো গেটওয়ে পেজে থাকতে পারে,
// বা /success কলব্যাক পথে থাকতে পারে। খুব আগ্রাসী হলে চলমান পেমেন্ট নষ্ট হতো।
const MIN_AGE_MINUTES = Number(process.env.GATEWAY_RECONCILE_MIN_AGE_MIN) || 20;

// এর চেয়ে পুরনো রো আর গেটওয়েতে খোঁজা হয় না (গেটওয়েও পুরনো ট্রানজেকশন রাখে না)।
const MAX_AGE_DAYS = Number(process.env.GATEWAY_RECONCILE_MAX_AGE_DAYS) || 7;

// এক রানে সর্বোচ্চ কতগুলো — প্রতিটার জন্য একটা করে বাইরের HTTP কল হয়, তাই
// অসীম লুপ চালিয়ে গেটওয়ে রেট-লিমিটে পড়া বা জব ঘণ্টাখানেক ঝুলে থাকা চলে না।
const BATCH_LIMIT = Number(process.env.GATEWAY_RECONCILE_BATCH) || 25;

// গেটওয়ে যেসব status-কে চূড়ান্ত ব্যর্থতা বলে, শুধু সেগুলোতেই reject করা হয়।
// অজানা/অস্পষ্ট status-এ রো pending থেকেই যায় — ভুল করে reject করার চেয়ে
// অ্যাডমিনের নজরে থাকা নিরাপদ।
const FAILED_STATUSES = ['FAILED', 'EXPIRED', 'CANCELLED', 'UNATTEMPTED'];

function isConfigured() {
  return Boolean(process.env.SSLCZ_STORE_ID && process.env.SSLCZ_STORE_PASSWD);
}

/**
 * একটি আটকে থাকা রিকোয়েস্ট নিষ্পত্তি করে।
 * রিটার্ন: 'credited' | 'rejected' | 'unchanged' | 'error'
 */
async function reconcileOne(request) {
  let verification;
  try {
    verification = await sslcommerz.validateByTransactionId(request.gateway_tran_id);
  } catch (e) {
    // গেটওয়ে সাড়া দেয়নি — রো-তে হাত না দিয়ে পরের রানের জন্য রেখে দেওয়া হচ্ছে
    console.error(`gatewayReconcile: ${request.gateway_tran_id} যাচাই ব্যর্থ —`, e.message);
    return 'error';
  }

  const status = String(verification.status || '').toUpperCase();
  const paid = status === 'VALID' || status === 'VALIDATED';

  // ক্রেডিটের শর্ত /ipn-এর সাথে অভিন্ন — এখানে কোনো শিথিলতা নেই
  const amountMatches = paymentVerification.amountMatchesRequest(verification, request.amount);
  const currencyMatches = paymentVerification.isExpectedCurrency(verification);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // লক নিয়ে অবস্থা আবার পড়া — এর মধ্যে IPN/success এসে ক্রেডিট করে ফেলে থাকতে পারে
    const fresh = await client.query(
      `SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE`, [request.id]
    );
    const row = fresh.rows[0];
    if (!row || row.status !== 'pending') {
      await client.query('ROLLBACK');
      return 'unchanged';
    }

    if (paid && amountMatches && currencyMatches) {
      const { creditApprovedDeposit } = require('../routes/payment');
      await client.query(
        `UPDATE payment_requests SET gateway_response = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ reconciled: true, verification: verification.raw || verification }), row.id]
      );
      await creditApprovedDeposit(client, row);
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
        [row.user_id, 'ডিপোজিট সম্পন্ন',
          `আপনার ${row.amount} টাকার ডিপোজিট যাচাই করে যোগ করা হয়েছে।`]
      );
      await client.query('COMMIT');
      return 'credited';
    }

    if (status === 'NOT_FOUND' || FAILED_STATUSES.includes(status)) {
      await client.query(
        `UPDATE payment_requests SET status = 'rejected', gateway_response = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'pending'`,
        [JSON.stringify({ reconciled: true, verification: verification.raw || verification }), row.id]
      );
      await client.query('COMMIT');
      return 'rejected';
    }

    // পেমেন্ট সফল কিন্তু amount/currency মেলেনি — এটা নিছক আটকে থাকা রো নয়,
    // সম্ভাব্য কারচুপি। স্বয়ংক্রিয়ভাবে ক্রেডিটও নয়, rejectও নয়; অ্যাডমিনের
    // চোখে পড়ার জন্য pending রেখে দেওয়া হয় এবং লগ করা হয়।
    if (paid && (!amountMatches || !currencyMatches)) {
      console.error(
        `gatewayReconcile: MISMATCH tran=${request.gateway_tran_id} request_amount=${request.amount} ` +
        `gateway_amount=${paymentVerification.storeAmountOf(verification)} currency=${verification.currency} — pending রাখা হলো`
      );
    }
    await client.query('ROLLBACK');
    return 'unchanged';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`gatewayReconcile: ${request.gateway_tran_id} নিষ্পত্তি ব্যর্থ —`, e.message);
    return 'error';
  } finally {
    client.release();
  }
}

/**
 * আটকে থাকা সব gateway ডিপোজিট রিকনসাইল করে।
 * রিটার্ন: { scanned, credited, rejected, unchanged, errors, skipped }
 */
async function reconcileStuckDeposits() {
  const summary = { scanned: 0, credited: 0, rejected: 0, unchanged: 0, errors: 0, skipped: false };

  if (!isConfigured()) {
    // ক্রেডেনশিয়াল ছাড়া গেটওয়েকে জিজ্ঞেস করার উপায় নেই — অনুমান করে কিছু করা হবে না
    summary.skipped = true;
    return summary;
  }

  // ORDER BY last_reconciled_at NULLS FIRST — কেবল created_at ASC দিয়ে সাজালে
  // যেসব পুরনো রো কখনোই নিষ্পত্তি হয় না (যেমন amount mismatch, যেগুলো ইচ্ছাকৃতভাবে
  // pending রাখা হয়) সেগুলোই প্রতি রানে ব্যাচের শুরুটা দখল করে বসে থাকত এবং নতুন
  // আটকে থাকা ডিপোজিট কখনো স্ক্যানই হতো না (starvation)। প্রতিটা পরীক্ষিত রোতে
  // last_reconciled_at বসিয়ে দেওয়ায় সবাই ঘুরেফিরে সুযোগ পায়।
  const stuck = await pool.query(
    `SELECT id, user_id, amount, gateway_tran_id, method, want_bonus, status
     FROM payment_requests
     WHERE type = 'deposit' AND status = 'pending'
       AND gateway = 'sslcommerz' AND gateway_tran_id IS NOT NULL
       AND created_at < NOW() - ($1 || ' minutes')::interval
       AND created_at > NOW() - ($2 || ' days')::interval
     ORDER BY last_reconciled_at ASC NULLS FIRST, created_at ASC
     LIMIT $3`,
    [String(MIN_AGE_MINUTES), String(MAX_AGE_DAYS), BATCH_LIMIT]
  );

  for (const request of stuck.rows) {
    summary.scanned++;
    const outcome = await reconcileOne(request);
    // রো এখনো pending থাকলেও "দেখা হয়েছে" চিহ্নিত করা হচ্ছে, নাহলে পরের রানে
    // আবার এটাই ব্যাচের প্রথমে এসে অন্যদের জায়গা নিয়ে নিত।
    await pool.query(
      `UPDATE payment_requests SET last_reconciled_at = NOW() WHERE id = $1`, [request.id]
    ).catch((e) => console.error('gatewayReconcile stamp error:', e.message));
    if (outcome === 'credited') summary.credited++;
    else if (outcome === 'rejected') summary.rejected++;
    else if (outcome === 'error') summary.errors++;
    else summary.unchanged++;
  }

  return summary;
}

module.exports = {
  reconcileStuckDeposits, reconcileOne, isConfigured,
  MIN_AGE_MINUTES, MAX_AGE_DAYS, BATCH_LIMIT, FAILED_STATUSES
};
