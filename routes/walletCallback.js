// routes/walletCallback.js
// ---------------------------------------------------------------------------
// একক POST রুট: bKash / Nagad / Rocket / Upay-এর কলব্যাক রিসিভ করে।
//
//   POST /wallet-callback/:provider     (provider = bkash | nagad | rocket | upay)
//
// ওয়ালেটের মার্চেন্ট ড্যাশবোর্ডে কলব্যাক URL হিসেবে দিন:
//   https://<আপনার-ডোমেইন>/wallet-callback/bkash   ইত্যাদি
//
// প্রবাহ:  IP allow-list -> স্বাক্ষর যাচাই -> payload রূপান্তর -> pending ডিপোজিটের সাথে মিল
//          -> ব্যালেন্স যোগ (creditApprovedDeposit, অ্যাডমিন অনুমোদনের মতোই)
//
// রেসপন্স নীতি:
//   . 401/403 : স্বাক্ষর/IP ভুল (কারণ ভেতরের লগে, ক্লায়েন্টকে জানানো হয় না)
//   . 400     : পেলোড অবৈধ (রিট্রাই করলেও লাভ নেই)
//   . 200     : বৈধ অনুরোধ — মিলুক বা না মিলুক, যাতে ওয়ালেট অকারণে রিট্রাই না করে
//   . 500     : সার্ভার সমস্যা (ওয়ালেট পরে রিট্রাই করবে; আমাদের দিকে idempotent)
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

const walletCallback = require('../services/walletCallback');
const { createLimiter } = require('../middleware/rateLimitFactory');
const { logEvent: logAuditEvent } = require('../services/auditLog');

const limiter = createLimiter('wallet-callback', {
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `${req.params.provider || 'unknown'}:${req.ip}`,
  handler: (req, res) => res.status(429).json({ success: false, error: 'RATE_LIMITED' })
});

// এই রুটে শুধু raw body (Buffer) — স্বাক্ষর যাচাইয়ে হুবহু bytes লাগে।
// অবশ্যই app-এর গ্লোবাল express.json()-এর আগে মাউন্ট করতে হবে (app.js দেখুন)।
const rawJson = express.raw({ type: '*/*', limit: '64kb' });

function deny(res, status, code) {
  return res.status(status).json({ success: false, error: code });
}

router.post('/:provider', limiter, rawJson, async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  if (!walletCallback.WALLETS.includes(provider)) return deny(res, 404, 'UNKNOWN_PROVIDER');

  if (!Buffer.isBuffer(req.body)) {
    console.error('[walletCallback] raw body পাওয়া যায়নি — app.js-এ মাউন্টের ক্রম দেখুন');
    return deny(res, 500, 'SERVER_MISCONFIGURED');
  }
  req.rawBody = req.body;

  // ১. IP allow-list
  if (!walletCallback.isIpAllowed(req, provider)) {
    console.warn(`[walletCallback] ${provider}: allow-list-বহির্ভূত IP ${req.ip}`);
    return deny(res, 403, 'IP_NOT_ALLOWED');
  }

  // ২. স্বাক্ষর যাচাই
  const auth = walletCallback.verifyRequest(req, provider);
  if (!auth.ok) {
    console.warn(`[walletCallback] ${provider}: স্বাক্ষর ব্যর্থ (${auth.reason}) ip=${req.ip}`);
    return deny(res, 401, 'INVALID_SIGNATURE');
  }

  // ৩. পার্স + রূপান্তর
  let body;
  try { body = JSON.parse(req.rawBody.toString('utf8')); }
  catch (_) { return deny(res, 400, 'INVALID_JSON'); }

  const parsed = walletCallback.normalizePayload(provider, body);
  if (!parsed.ok) {
    console.warn(`[walletCallback] ${provider}: payload অবৈধ (${parsed.reason})`);
    return deny(res, 400, 'INVALID_PAYLOAD');
  }

  // ৪. সিস্টেমের সাথে সমন্বয়
  try {
    // payment.js-এর সাথে বৃত্তাকার নির্ভরতা এড়াতে এখানে lazy require
    const { creditApprovedDeposit } = require('./payment');
    const result = await walletCallback.reconcile(parsed.data, creditApprovedDeposit);

    if (result.outcome === 'credited') {
      await logAuditEvent({
        req, actorType: 'system', actorId: null, actorUsername: `wallet:${provider}`,
        action: 'PAYMENT_AUTO_APPROVED', category: 'financial', riskLevel: 'high',
        details: { requestId: result.requestId, userId: result.userId, amount: result.amount, wallet: provider, trxId: parsed.data.trxId }
      }).catch((e) => console.error('audit log error:', e.message));
    } else if (result.outcome === 'amount_mismatch') {
      console.warn(`[walletCallback] ${provider}: পরিমাণ মেলেনি request=${result.requestId} — অ্যাডমিন পর্যালোচনা দরকার`);
    }

    return res.status(200).json({ success: true, outcome: result.outcome });
  } catch (err) {
    console.error(`[walletCallback] ${provider}: প্রক্রিয়াকরণ ব্যর্থ:`, err.message);
    return deny(res, 500, 'INTERNAL_ERROR');
  }
});

module.exports = router;
