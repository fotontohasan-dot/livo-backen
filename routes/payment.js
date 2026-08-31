const express = require('express');
const { buildUrl, getBaseUrl } = require('../utils/publicUrl');
const businessTime = require('../utils/businessTime');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireFeature } = require('../middleware/featureGate');
// দ্রষ্টব্য — গেট শুধু *ইনিশিয়েশনে* বসানো হয়েছে (/deposit, /withdraw,
// /sslcommerz/init)। গেটওয়ে কলব্যাক (/sslcommerz/success|fail|cancel|ipn) ও
// অ্যাডমিন approve/reject ইচ্ছাকৃতভাবে গেটমুক্ত:
//   • ডিপোজিট বন্ধ করার মুহূর্তে যে টাকা ইতিমধ্যে গেটওয়েতে চলে গেছে, সেই
//     কলব্যাক ব্লক করলে ইউজারের টাকা কেটে গিয়ে কয়েন ক্রেডিট হতো না।
//   • উইথড্র বন্ধ করার পরেও অ্যাডমিনকে পুরনো pending রিকোয়েস্ট নিষ্পত্তি
//     করতে দিতে হবে, নাহলে ইউজারের টাকা আটকে থাকে।
// অর্থাৎ ফিচার বন্ধ = নতুন রিকোয়েস্ট নেওয়া বন্ধ, চলমান টাকা আটকে ফেলা নয়।
const { createBonus, canWithdraw } = require('../services/turnover');
const { processReferralDeposit } = require('../services/referral');
const crypto = require('crypto');
const sslcommerz = require('../services/sslcommerz');
// যাচাইয়ের বিশুদ্ধ যুক্তি — গেটওয়ে মডিউল mock করা হলেও এটা চলতেই থাকে
const paymentVerification = require('../services/paymentVerification');
const { broadcastDemoStats, emitAdminAlert } = require('../services/socket');
const { notifyTelegram } = require('../services/telegramNotify');
const { verifyPin, getPinStatus } = require('../services/withdrawPin');
const { scanTransaction } = require('../services/fraudDetection');
const { isSessionNewDevice } = require('../services/deviceTracking');
const { checkIp } = require('../services/vpnDetection');
const { isAuth, requireVerifiedEmail, requireAdmin } = require('../middleware/auth');
const RedisRateLimitStore = require('../services/redisRateLimitStore');
const queue = require('../services/queue');
const cache = require('../services/cache');

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: (req) => req.t('common_rate_limited'),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:payment:')
});

// ব্যান/ডিলিট হওয়া ইউজার যেন পুরনো সেশন দিয়ে ডিপোজিট/উইথড্র করতে না পারে, তাই এখানে
// শুধু req.session.user-এর অস্তিত্ব চেক করা আগের স্থানীয় requireLogin-এর বদলে
// middleware/auth.js-এর isAuth ব্যবহার করা হচ্ছে — এটা প্রতিটা রিকোয়েস্টে DB থেকে
// is_banned যাচাই করে (৩০ সেকেন্ড ক্যাশসহ)।

// আগে এখানে একটা লোকাল requireAdmin ছিল যেটা শুধু req.session.user.role চেক করতো (স্টেল সেশন —
// ডিমোট করা admin-এর পুরনো সেশন দিয়েও ঢোকা যেত)। এখন middleware/auth.js-এর isAdmin ব্যবহার করা হচ্ছে,
// যেটা প্রতিটা রিকোয়েস্টে DB থেকে বর্তমান role যাচাই করে — একই consistent authorization flow সব জায়গায়।
// requireAdmin already imported above
const { requirePermission } = require('../services/rbac');
const { logAdminAction, logEvent: logAuditEvent } = require('../services/auditLog');

function parseAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function notifyAdmins(title, message, alertType) {
  try {
    const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    const userIds = admins.rows.map(a => a.id);
    const jobId = await queue.enqueue('notification', {
      userIds,
      title,
      message,
      telegramText: `🔔 <b>${title}</b>\n${message}`,
      telegramCategory: alertType || null
    });
    if (!jobId) {
      // কিউ এনকিউ ব্যর্থ হলে সরাসরি পাঠিয়ে দেওয়া হচ্ছে যাতে অ্যাডমিন নোটিফিকেশন মিস না হয়
      for (const uid of userIds) {
        await pool.query(
          `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
          [uid, title, message]
        );
      }
      notifyTelegram(`🔔 <b>${title}</b>\n${message}`, { category: alertType || null });
    }
  } catch (e) {
    console.error('notifyAdmins error:', e.message);
  }
  if (alertType) emitAdminAlert(alertType, { title, message });
}

// ==================== রিলোড বোনাসের হার ====================
// কততম ডিপোজিট ও কোন বার অনুযায়ী বোনাস শতাংশ ঠিক হয়।
//  ১ম ডিপোজিট: ১০০%
//  ২য় ডিপোজিট: ৫০%
//  শুক্রবার (যেকোনো ডিপোজিট): ৮০% (রিলোড)
//  ৩য়+ সাধারণ দিন: ১৫%
//  সর্বোচ্চ বোনাস ১৫০০০ কয়েন
function bonusPercentFor(depositCountBefore, isFriday) {
  if (depositCountBefore === 0) return 100;   // প্রথম ডিপোজিট
  if (isFriday) return 80;                      // শুক্রবার রিলোড
  if (depositCountBefore === 1) return 50;      // দ্বিতীয় ডিপোজিট
  return 15;                                    // সাধারণ রিলোড
}
const MAX_BONUS = 15000;

// ডিপোজিট অনুমোদন হলে কয়েন+বোনাস+রেফারেল প্রসেস করে — অ্যাডমিন approve
// এবং SSLCommerz অটো-ক্রেডিট দুই জায়গা থেকেই এই একই ফাংশন কল হয়
async function creditApprovedDeposit(client, request) {
  let bonusGiven = 0;
  const amount = Math.round(Number(request.amount));

  await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [amount, request.user_id]);
  await client.query('UPDATE users SET total_deposited = COALESCE(total_deposited,0) + $1 WHERE id=$2', [request.amount, request.user_id]);
  // ইউজারের /profile/transactions পেজ coin_transactions টেবিল থেকে পড়ে — এই ইনসার্ট ছাড়া
  // অনুমোদিত ডিপোজিট কখনো সেই হিস্ট্রিতে দেখা যেত না (ব্যালেন্স ঠিকই বাড়ত, শুধু রেকর্ড থাকত না)।
  await client.query(
    `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'deposit', $3)`,
    [request.user_id, amount, `ডিপোজিট অনুমোদন (${request.method})`]
  );

  // ডিপোজিট করলে ইউজারের ডেমো ব্যালেন্সও একই পরিমাণ বেড়ে যাবে (স্বয়ংক্রিয়)
  await client.query('UPDATE users SET demo_balance = COALESCE(demo_balance,0) + $1 WHERE id=$2', [amount, request.user_id]);
  broadcastDemoStats().catch(e => console.error('demo stats broadcast:', e.message));

  if (request.want_bonus) {
    const cnt = await client.query(
      `SELECT COUNT(*) FROM payment_requests WHERE user_id=$1 AND type='deposit' AND status='approved' AND id <> $2`,
      [request.user_id, request.id]
    );
    const before = parseInt(cnt.rows[0].count);
    const isFriday = new Date().getDay() === 5;
    const pct = bonusPercentFor(before, isFriday);

    bonusGiven = Math.min(MAX_BONUS, Math.floor(request.amount * pct / 100));

    if (bonusGiven > 0) {
      await client.query('SAVEPOINT bonus_sp');
      try {
        await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [bonusGiven, request.user_id]);
        await createBonus(client, request.user_id, 'deposit', bonusGiven);
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'deposit_bonus', 'ডিপোজিট বোনাস')`,
          [request.user_id, bonusGiven]
        );
        await client.query('RELEASE SAVEPOINT bonus_sp');
      } catch (bonusErr) {
        await client.query('ROLLBACK TO SAVEPOINT bonus_sp');
        console.error('createBonus failed, bonus skipped but deposit continues:', bonusErr.message);
        bonusGiven = 0;
      }
    }
  }

  await client.query('SAVEPOINT referral_sp');
  try {
    await processReferralDeposit(client, request.user_id, request.amount);
    await client.query('RELEASE SAVEPOINT referral_sp');
  } catch (refErr) {
    await client.query('ROLLBACK TO SAVEPOINT referral_sp');
    console.error('processReferralDeposit failed, referral bonus skipped:', refErr.message);
  }

  await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [request.id]);

  const message = bonusGiven > 0
    ? `আপনার ${request.amount} টাকার ডিপোজিট + ${bonusGiven} বোনাস যোগ হয়েছে! (টার্নওভার প্রযোজ্য)`
    : `আপনার ${request.amount} টাকার ডিপোজিট অনুমোদন হয়েছে!`;
  await client.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
    [request.user_id, 'পেমেন্ট অনুমোদন', message]
  );

  return bonusGiven;
}

const VALID_METHODS = ['bkash', 'nagad', 'rocket', 'upay', 'bank', 'crypto'];

const DEPOSIT_NUMBERS = [
  '01781732144',
  '01714275156',
  '01840199199',
  '01620992072'
];
let depositRotation = 0;

// ==================== WALLET HUB — একটাই পেজে ডিপোজিট/উইথড্র/কার্ড/হিস্টরির প্রিমিয়াম ওভারভিউ ====================
// বিদ্যমান /deposit, /withdraw, /profile/cards, /history পেজগুলোই এখানে quick-action হিসেবে লিংক করা,
// কোনো ফর্ম/বিজনেস লজিক ডুপ্লিকেট করা হয়নি — শুধু বিদ্যমান টেবিল থেকে read-only সামারি।
router.get('/wallet', isAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userRes = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    const coins = Number(userRes.rows[0]?.coins || 0);

    const recentTx = await pool.query(
      `SELECT id, type, amount, method, status, transaction_id, created_at
       FROM payment_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`,
      [userId]
    );

    const walletStats = await cache.getOrSet(`wallet:stats:${userId}`, 60, async () => {
      const allTime = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='deposit' AND status='approved' THEN amount ELSE 0 END),0) AS total_deposit,
           COALESCE(SUM(CASE WHEN type='withdraw' AND status='approved' THEN amount ELSE 0 END),0) AS total_withdraw
         FROM payment_requests WHERE user_id=$1`,
        [userId]
      );
      const last30 = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='deposit' AND status='approved' THEN amount ELSE 0 END),0) AS deposit_30d,
           COALESCE(SUM(CASE WHEN type='withdraw' AND status='approved' THEN amount ELSE 0 END),0) AS withdraw_30d,
           COUNT(*) FILTER (WHERE status='pending') AS pending_count
         FROM payment_requests WHERE user_id=$1 AND created_at >= NOW() - INTERVAL '30 days'`,
        [userId]
      );
      return {
        totalDeposit: Number(allTime.rows[0].total_deposit),
        totalWithdraw: Number(allTime.rows[0].total_withdraw),
        deposit30d: Number(last30.rows[0].deposit_30d),
        withdraw30d: Number(last30.rows[0].withdraw_30d),
        pendingCount: Number(last30.rows[0].pending_count)
      };
    });

    let cardCount = 0;
    try {
      const cardRes = await pool.query('SELECT COUNT(*) FROM bank_cards WHERE user_id=$1', [userId]);
      cardCount = Number(cardRes.rows[0].count);
    } catch (e) {}

    res.render('payment/wallet', {
      user: req.session.user,
      coins,
      recentTx: recentTx.rows,
      walletStats,
      cardCount
    });
  } catch (err) {
    console.error('wallet hub error:', err.message);
    req.flash('error', req.t('payment_wallet_load_error'));
    res.redirect('/profile');
  }
});

router.get('/deposit', isAuth, requireFeature('deposit'), (req, res) => {
  const current = DEPOSIT_NUMBERS[depositRotation % DEPOSIT_NUMBERS.length];
  depositRotation = (depositRotation + 1) % DEPOSIT_NUMBERS.length;
  res.render('payment/deposit', { user: req.session.user, payNumber: current });
});

router.post('/deposit', isAuth, requireFeature('deposit'), paymentLimiter, async (req, res) => {
  const { method, account_number } = req.body;
  const transaction_id = (req.body.transaction_id || '').trim();
  const wantBonus = req.body.want_bonus === 'yes';
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (!VALID_METHODS.includes(method)) {
    req.flash('error', req.t('payment_invalid_method'));
    return res.redirect('/payment/deposit');
  }
  if (!method || amount === null || !transaction_id || !account_number) {
    req.flash('error', req.t('payment_all_fields_required'));
    return res.redirect('/payment/deposit');
  }
  if (amount < 100) {
    req.flash('error', req.t('payment_min_deposit_100'));
    return res.redirect('/payment/deposit');
  }

  // দৈনিক ডিপোজিট লিমিটের চূড়ান্ত যাচাই নিচে INSERT-এর সাথে একই ট্রানজেকশনে
  // হয় (row lock সহ)। এখানকার যাচাইটা শুধু দ্রুত, বন্ধুত্বপূর্ণ প্রত্যাখ্যানের
  // জন্য — এটাই একমাত্র ভরসা নয়।
  try {
    const u = await pool.query(`SELECT daily_deposit_limit FROM users WHERE id = $1`, [userId]);
    const limit = u.rows[0] && u.rows[0].daily_deposit_limit ? Number(u.rows[0].daily_deposit_limit) : null;
    if (limit) {
      const todayDep = await pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests
         WHERE user_id = $1 AND type = 'deposit' AND status != 'rejected'
           AND created_at >= $2 AND created_at < $3`,
        [userId, businessTime.startOfDay(), businessTime.endOfDay()]
      );
      const already = Number(todayDep.rows[0].total);
      if (already + amount > limit) {
        req.flash('error', req.t('payment_daily_deposit_limit').replace('{value1}', limit).replace('{value2}', Math.max(0, limit - already)));
        return res.redirect('/payment/deposit');
      }
    }
  } catch (e) {
    // fail-closed — দায়িত্বশীল-জুয়া (responsible gambling) সীমা যাচাই করা না গেলে
    // সীমাটা এড়িয়ে ডিপোজিট চালিয়ে দেওয়া চলে না। আগে শুধু লগ হয়ে নিচে চলে যেত।
    console.error('deposit limit check error:', e.message);
    req.flash('error', req.t('payment_limit_check_failed'));
    return res.redirect('/payment/deposit');
  }

  // ==== Duplicate Transaction ID ব্লক ====
  // দুটো আলাদা নিয়ম, কারণ ঝুঁকিও আলাদা:
  //
  //   ১. **অন্য ইউজারের ব্যবহার করা TrxID** — status যাই হোক, সবসময় ব্লক।
  //      আগে শর্ত ছিল শুধু `status != 'rejected'`, তাই একবার reject হওয়া
  //      ট্রানজেকশন আইডি অন্য যেকোনো অ্যাকাউন্ট থেকে আবার দাবি করা যেত।
  //      একই পেমেন্ট রেফারেন্স দুই অ্যাকাউন্টে বসানো মানে payment identity
  //      confusion — কোন জমাটা আসলে কার, রেকর্ড থেকে আর বলা যায় না।
  //
  //   ২. **নিজের rejected TrxID** — আবার সাবমিট করা যাবে। টাইপো করে reject
  //      হওয়া আইডি শুদ্ধ করে দেওয়ার বৈধ প্রয়োজন আছে, আর নিজের রেকর্ডে
  //      পরিচয়-বিভ্রান্তির ঝুঁকি নেই।
  try {
    const dupCheck = await pool.query(
      `SELECT id FROM payment_requests
       WHERE type='deposit' AND method=$1 AND transaction_id=$2
         AND (user_id <> $3 OR status <> 'rejected')
       LIMIT 1`,
      [method, transaction_id, userId]
    );
    if (dupCheck.rows.length > 0) {
      req.flash('error', req.t('payment_duplicate_transaction_id'));
      return res.redirect('/payment/deposit');
    }
  } catch (e) {
    console.error('duplicate trx_id check error:', e.message);
  }

  try {
    // লিমিট যাচাই ও INSERT একই ট্রানজেকশনে, ইউজারের সারিতে লক নিয়ে।
    //
    // আগে যাচাই ছিল আলাদা SELECT, তারপর আলাদা INSERT। দুটো ডিপোজিট একসাথে
    // এলে দুটোই একই SUM দেখত, দুটোই লিমিটের নিচে মনে হতো, দুটোই ঢুকে যেত —
    // অর্থাৎ দায়িত্বশীল-জুয়ার দৈনিক সীমা কার্যত এড়ানো যেত। `FOR UPDATE`
    // দুটো রিকোয়েস্টকে ক্রমানুসারে চালায়, তাই দ্বিতীয়টা প্রথমটার অঙ্ক দেখতে পায়।
    //
    // দিনের সীমানাও এখন ব্যবসায়িক টাইমজোন থেকে (utils/businessTime.js),
    // আগের `CURRENT_DATE` নয় — সেটা DB সার্ভারের টাইমজোন (UTC) ধরত, ফলে
    // বাংলাদেশ সময় সন্ধ্যা ৬টায় লিমিট রিসেট হয়ে যেত।
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockRow = await client.query(
        'SELECT daily_deposit_limit FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      const limit = lockRow.rows[0] && lockRow.rows[0].daily_deposit_limit
        ? Number(lockRow.rows[0].daily_deposit_limit) : null;

      if (limit) {
        const sum = await client.query(
          `SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests
           WHERE user_id = $1 AND type = 'deposit' AND status != 'rejected'
             AND created_at >= $2 AND created_at < $3`,
          [userId, businessTime.startOfDay(), businessTime.endOfDay()]
        );
        const already = Number(sum.rows[0].total);
        if (already + amount > limit) {
          await client.query('ROLLBACK');
          req.flash('error', req.t('payment_daily_deposit_limit').replace('{value1}', limit).replace('{value2}', Math.max(0, limit - already)));
          return res.redirect('/payment/deposit');
        }
      }

      await client.query(
        `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status, want_bonus) VALUES ($1, 'deposit', $2, $3, $4, $5, 'pending', $6)`,
        [userId, method, amount, transaction_id, account_number, wantBonus]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    checkIp((req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()).then(vpnInfo => {
      scanTransaction(userId, 'deposit', { accountNumber: account_number, vpnInfo })
        .catch(e => console.error('fraud scanTransaction (deposit) error:', e.message));
    }).catch(e => console.error('vpn checkIp (deposit) error:', e.message));
    await notifyAdmins(req.t('payment_new_deposit_request'), req.t('payment_deposit_request_detail').replace('{value1}', req.session.user.username).replace('{value2}', amount).replace('{value3}', method), 'deposit');
    req.flash('success', req.t('payment_deposit_request_sent'));
    res.redirect('/payment/history');
  } catch (err) {
    // DB-এর unique constraint (race condition-এ দুইটা রিকোয়েস্ট একসাথে এলে) ধরার জন্য দ্বিতীয় স্তরের সুরক্ষা
    if (err.code === '23505') {
      req.flash('error', req.t('payment_duplicate_transaction_id'));
      return res.redirect('/payment/deposit');
    }
    console.error('deposit error:', err.message);
    req.flash('error', req.t('payment_generic_error'));
    res.redirect('/payment/deposit');
  }
});

router.get('/withdraw', isAuth, requireFeature('withdrawal'), async (req, res) => {
  try {
    const result = await pool.query('SELECT coins FROM users WHERE id=$1', [req.session.user.id]);
    // pg ড্রাইভার NUMERIC(14,2) কলাম স্ট্রিং হিসেবে ফেরত দেয় (যেমন "1499.00"), সংখ্যা হিসেবে না —
    // Number() দিয়ে কনভার্ট না করলে views/payment/withdraw.ejs-এর (coins || 0).toFixed(2) ক্র্যাশ
    // করত ("toFixed is not a function") যেহেতু স্ট্রিংয়ে সেই মেথড নেই। ফলে যেকোনো নন-জিরো
    // ব্যালেন্সের ইউজারের জন্য পুরো Withdraw পেজটাই 500 এরর দিয়ে ভেঙে যেত।
    const coins = Number(result.rows[0]?.coins) || 0;
    let cards = [];
    try {
      const cardRes = await pool.query('SELECT id, user_id, bank_name, account_number, holder_name, created_at FROM bank_cards WHERE user_id=$1', [req.session.user.id]);
      cards = cardRes.rows;
    } catch (e) { cards = []; }
    let pinStatus = { configured: false, locked: false };
    try { pinStatus = await getPinStatus(req.session.user.id); } catch (e) {}
    res.render('payment/withdraw', { user: req.session.user, coins, cards, pinStatus });
  } catch (err) {
    console.error('withdraw GET error:', err.message);
    res.redirect('/');
  }
});


router.post('/withdraw', isAuth, requireFeature('withdrawal'), requireVerifiedEmail, paymentLimiter, async (req, res) => {
  const { method, account_number, withdraw_pin } = req.body;
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (!VALID_METHODS.includes(method)) {
    req.flash('error', req.t('payment_invalid_method'));
    return res.redirect('/payment/withdraw');
  }
  if (!method || amount === null || !account_number) {
    req.flash('error', req.t('payment_all_fields_required'));
    return res.redirect('/payment/withdraw');
  }
  if (amount < 200) {
    req.flash('error', req.t('payment_min_withdraw_200'));
    return res.redirect('/payment/withdraw');
  }

  // ==================== Withdraw PIN ভেরিফিকেশন (নতুন নিরাপত্তা স্তর) ====================
  // প্রতিটি উইথড্র রিকোয়েস্টের আগে PIN যাচাই করা বাধ্যতামূলক। এটা একটা আলাদা গেট —
  // নিচের বিদ্যমান উইথড্র বিজনেস লজিক (turnover check, coins deduction ইত্যাদি) অপরিবর্তিত রাখা হয়েছে।
  try {
    const pinCheck = await verifyPin(userId, withdraw_pin, req.ip);

    if (pinCheck.notConfigured) {
      req.flash('error', req.t('payment_withdraw_pin_not_set'));
      return res.redirect('/profile/security');
    }
    if (pinCheck.locked) {
      const mins = Math.max(1, Math.ceil((pinCheck.remainingMs || 0) / 60000));
      req.flash('error', req.t('payment_withdraw_pin_locked').replace('{value}', mins));
      return res.redirect('/payment/withdraw');
    }
    if (!pinCheck.success) {
      const left = pinCheck.attemptsLeft != null ? req.t('payment_withdraw_pin_attempts_left').replace('{value}', pinCheck.attemptsLeft) : '';
      req.flash('error', req.t('payment_withdraw_pin_wrong').replace('{value}', left));
      return res.redirect('/payment/withdraw');
    }
  } catch (e) {
    console.error('withdraw pin verification error:', e.message);
    req.flash('error', req.t('payment_pin_verification_error'));
    return res.redirect('/payment/withdraw');
  }

  try {
    const check = await canWithdraw(userId);
    if (!check.allowed) {
      let msg = req.t('payment_turnover_incomplete_prefix');
      const parts = [];
      check.pending.forEach(p => {
        if (p.sportsLeft > 0) parts.push(req.t('payment_turnover_sports_left').replace('{value}', p.sportsLeft.toFixed(0)));
        if (p.casinoLeft > 0) parts.push(req.t('payment_turnover_casino_left').replace('{value}', p.casinoLeft.toFixed(0)));
      });
      msg += parts.join(', ');
      req.flash('error', msg);
      return res.redirect('/payment/withdraw');
    }
  } catch (e) {
    // fail-closed। আগে এই catch শুধু লগ করে নিচে চলে যেত, অর্থাৎ canWithdraw()
    // ব্যর্থ হলে (DB সমস্যা ইত্যাদি) টার্নওভার গেটটাই এড়িয়ে উইথড্র সম্পন্ন হয়ে যেত —
    // অসম্পূর্ণ ওয়েজারিং থাকা বোনাস তুলে নেওয়ার সরাসরি পথ। এখন যাচাই করা না গেলে
    // রিকোয়েস্ট আটকে যায়; ইউজার পরে আবার চেষ্টা করতে পারে।
    console.error('turnover check error:', e.message);
    req.flash('error', req.t('payment_turnover_check_failed'));
    return res.redirect('/payment/withdraw');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upd = await client.query(
      `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins`,
      [amount, userId]
    );

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      req.flash('error', req.t('payment_insufficient_coins'));
      return res.redirect('/payment/withdraw');
    }

    await client.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, account_number, status) VALUES ($1, 'withdraw', $2, $3, $4, 'pending')`,
      [userId, method, amount, account_number]
    );
    // ডিপোজিটের মতো — coin_transactions-এ না লিখলে /profile/transactions-এ উইথড্র কখনো দেখা যেত না
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'withdraw', $3)`,
      [userId, -amount, `উইথড্র রিকোয়েস্ট (${method})`]
    );
    broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;

    checkIp((req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()).then(async (vpnInfo) => {
      const isNewDevice = await isSessionNewDevice(req.sessionID).catch(() => false);
      scanTransaction(userId, 'withdraw', { accountNumber: account_number, vpnInfo, amount, isNewDevice })
        .catch(e => console.error('fraud scanTransaction (withdraw) error:', e.message));
    }).catch(e => console.error('vpn checkIp (withdraw) error:', e.message));

    await notifyAdmins(req.t('payment_new_withdraw_request'), req.t('payment_withdraw_request_detail').replace('{value1}', req.session.user.username).replace('{value2}', amount).replace('{value3}', method), 'withdraw');

    req.flash('success', req.t('payment_withdraw_request_sent'));
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('withdraw error:', err.message);
    req.flash('error', req.t('payment_generic_error'));
    res.redirect('/payment/withdraw');
  } finally {
    client.release();
  }
});

router.get('/history', isAuth, async (req, res) => {
  try {
    const { type, quick, from, to } = req.query;
    const conditions = ['user_id=$1'];
    const params = [req.session.user.id];

    if (type === 'deposit' || type === 'withdraw') {
      params.push(type);
      conditions.push(`type=$${params.length}`);
    }

    let dateFrom = from, dateTo = to;
    if (quick === 'today') {
      dateFrom = new Date().toISOString().slice(0, 10);
      dateTo = dateFrom;
    } else if (quick === 'yesterday') {
      const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      dateFrom = y; dateTo = y;
    } else if (quick === '7days') {
      dateFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      dateTo = new Date().toISOString().slice(0, 10);
    }

    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`created_at::date >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`created_at::date <= $${params.length}`);
    }

    const result = await pool.query(
      `SELECT id, user_id, type, amount, method, account_number, status, transaction_id, gateway_tran_id, created_at FROM payment_requests WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.render('payment/history', {
      user: req.session.user,
      requests: result.rows,
      filter: { type: type || '', quick: quick || '', from: dateFrom || '', to: dateTo || '' }
    });
  } catch (err) {
    console.error('history error:', err.message);
    res.render('payment/history', { loadError: true, user: req.session.user, requests: [], filter: { type: '', quick: '', from: '', to: '' } });
  }
});

// এই পেজটা টেবিলের প্রতিটা ঐতিহাসিক deposit/withdraw রিকোয়েস্ট (pending/approved/rejected —
// সবগুলো, কোনো WHERE ছাড়াই) ক্লায়েন্ট-সাইড ট্যাব-ফিল্টারের জন্য একবারে লোড করে
// (views/payment/admin.ejs-এর allRequests)। আগে কোনো LIMIT ছিল না — payment_requests
// বাড়ার সাথে সাথে প্রতিটা অ্যাডমিন পেজ-লোডে পুরো টেবিল স্ক্যান+সিরিয়ালাইজ হতো।
// সাম্প্রতিক ইতিহাস দেখানোই এই পেজের উদ্দেশ্য বলে বড় কিন্তু বাউন্ডেড LIMIT — বাস্তবিক
// ব্যবহারে কোনো পার্থক্য পড়ে না, কিন্তু ওয়ার্স্ট-কেস কোয়েরি/রেসপন্স সাইজ বাউন্ডেড থাকে।
const ADMIN_PAYMENTS_LIST_LIMIT = 2000;

router.get('/admin/payments', requireAdmin, requirePermission('payments_view'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id
       ORDER BY pr.created_at DESC LIMIT $1`,
      [ADMIN_PAYMENTS_LIST_LIMIT]
    );
    res.render('payment/admin', { user: req.session.user, requests: result.rows });
  } catch (err) {
    // ক্যোয়ারি ব্যর্থ হলে আগে খালি তালিকা রেন্ডার হতো — অ্যাডমিনের কাছে সেটা "কোনো পেন্ডিং
    // রিকোয়েস্ট নেই"-এর মতোই দেখাত। loadError দিয়ে পেজে স্পষ্ট সতর্কতা দেখানো হয়।
    console.error('admin payments list error:', err.message);
    res.render('payment/admin', { user: req.session.user, requests: [], loadError: true });
  }
});

function dhakaTodayStr() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00+06:00');
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function dhakaStartOf(dateStr) { return new Date(dateStr + 'T00:00:00+06:00'); }
function dhakaEndOf(dateStr) { return new Date(dateStr + 'T23:59:59.999+06:00'); }

router.get('/admin/deposits', requireAdmin, requirePermission('payments_view'), async (req, res) => {
  try {
    const method = ['bkash', 'nagad', 'rocket'].includes(req.query.method) ? req.query.method : 'bkash';
    const quick = req.query.quick || 'today';
    const today = dhakaTodayStr();
    let fromStr, toStr;

    if (quick === '7d') { fromStr = addDaysStr(today, -6); toStr = today; }
    else if (quick === '30d') { fromStr = addDaysStr(today, -29); toStr = today; }
    else if (quick === '90d') { fromStr = addDaysStr(today, -89); toStr = today; }
    else if (quick === 'year') { fromStr = today.slice(0, 4) + '-01-01'; toStr = today; }
    else if (quick === 'custom') { fromStr = req.query.from || today; toStr = req.query.to || today; }
    else { fromStr = today; toStr = today; }

    const fromTs = dhakaStartOf(fromStr);
    const toTs = dhakaEndOf(toStr);

    // তিনটা মেথডেরই টোটাল (বর্তমান ডেট রেঞ্জে) — ট্যাব হেডারে দেখানোর জন্য, শুধু approved হিসাব করা হচ্ছে
    const totalsResult = await pool.query(
      `SELECT method, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM payment_requests
       WHERE type='deposit' AND status='approved' AND method = ANY($1) AND created_at BETWEEN $2 AND $3
       GROUP BY method`,
      [['bkash', 'nagad', 'rocket'], fromTs, toTs]
    );
    const totals = { bkash: { total: 0, cnt: 0 }, nagad: { total: 0, cnt: 0 }, rocket: { total: 0, cnt: 0 } };
    totalsResult.rows.forEach(r => { totals[r.method] = { total: Number(r.total), cnt: parseInt(r.cnt) }; });

    // সিলেক্টেড ট্যাবের সব ট্রানজেকশন (pending/approved/rejected সবই — অ্যাডমিন অ্যাকশন নেওয়ার জন্য)
    const listResult = await pool.query(
      `SELECT pr.*, u.username FROM payment_requests pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.type='deposit' AND pr.method=$1 AND pr.created_at BETWEEN $2 AND $3
       ORDER BY pr.created_at DESC`,
      [method, fromTs, toTs]
    );

    res.render('payment/deposits', {
      user: req.session.user,
      method,
      quick,
      from: fromStr,
      to: toStr,
      totals,
      requests: listResult.rows
    });
  } catch (err) {
    console.error('deposits admin error:', err.message);
    res.render('payment/deposits', {
      user: req.session.user,
      method: 'bkash',
      quick: 'today',
      from: dhakaTodayStr(),
      to: dhakaTodayStr(),
      totals: { bkash: { total: 0, cnt: 0 }, nagad: { total: 0, cnt: 0 }, rocket: { total: 0, cnt: 0 } },
      requests: [],
      loadError: true
    });
  }
});

router.get('/admin/summary', requireAdmin, requirePermission('payments_view'), async (req, res) => {
  try {
    const quick = req.query.quick || 'today';
    const today = dhakaTodayStr();
    let fromStr, toStr;

    if (quick === '7d') {
      fromStr = addDaysStr(today, -6);
      toStr = today;
    } else if (quick === '30d') {
      fromStr = addDaysStr(today, -29);
      toStr = today;
    } else if (quick === 'all') {
      fromStr = '1970-01-01';
      toStr = today;
    } else if (quick === 'custom') {
      fromStr = req.query.from || today;
      toStr = req.query.to || today;
    } else {
      fromStr = today;
      toStr = today;
    }

    const fromTs = dhakaStartOf(fromStr);
    const toTs = dhakaEndOf(toStr);

    const grandResult = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END),0) AS total_deposit,
         COALESCE(SUM(CASE WHEN type='withdraw' THEN amount ELSE 0 END),0) AS total_withdraw,
         COUNT(*) FILTER (WHERE type='deposit') AS deposit_count,
         COUNT(*) FILTER (WHERE type='withdraw') AS withdraw_count
       FROM payment_requests
       WHERE status='approved' AND created_at BETWEEN $1 AND $2`,
      [fromTs, toTs]
    );

    const dailyResult = await pool.query(
      `SELECT
         DATE(created_at AT TIME ZONE 'Asia/Dhaka') AS day,
         COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END),0) AS deposit_total,
         COALESCE(SUM(CASE WHEN type='withdraw' THEN amount ELSE 0 END),0) AS withdraw_total
       FROM payment_requests
       WHERE status='approved' AND created_at BETWEEN $1 AND $2
       GROUP BY DATE(created_at AT TIME ZONE 'Asia/Dhaka')
       ORDER BY day DESC`,
      [fromTs, toTs]
    );

    const userResult = await pool.query(
      `SELECT u.id, u.username,
         COALESCE(SUM(CASE WHEN pr.type='deposit' THEN pr.amount ELSE 0 END),0) AS total_deposit,
         COALESCE(SUM(CASE WHEN pr.type='withdraw' THEN pr.amount ELSE 0 END),0) AS total_withdraw
       FROM payment_requests pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.status='approved' AND pr.created_at BETWEEN $1 AND $2
       GROUP BY u.id, u.username
       ORDER BY total_deposit DESC`,
      [fromTs, toTs]
    );

    res.render('payment/summary', {
      user: req.session.user,
      quick,
      from: fromStr,
      to: toStr,
      grand: grandResult.rows[0],
      daily: dailyResult.rows,
      users: userResult.rows
    });
  } catch (err) {
    console.error('summary error:', err.message);
    res.render('payment/summary', { loadError: true,
      user: req.session.user,
      quick: 'today',
      from: dhakaTodayStr(),
      to: dhakaTodayStr(),
      grand: { total_deposit: 0, total_withdraw: 0, deposit_count: 0, withdraw_count: 0 },
      daily: [],
      users: []
    });
  }
});

// ==================== একক / বাল্ক approve-reject-এর জন্য শেয়ার্ড লজিক ====================
// একক রুট (POST /admin/approve/:id, /admin/reject/:id) ও নতুন বাল্ক রুট — দুটোই এই একই
// ফাংশন কল করে, যাতে ব্যবসায়িক লজিক (coin credit/refund, notification, status আপডেট)
// দুই জায়গায় ডুপ্লিকেট না হয়। প্রতিটা আইটেম নিজস্ব BEGIN/COMMIT-এ চলে, তাই বাল্ক অপারেশনে
// একটা আইটেম ব্যর্থ হলে বাকিগুলো প্রভাবিত হয় না (partial failure নিরাপদে হ্যান্ডল হয়)।
// `t` — ওই রিকোয়েস্ট যে অ্যাডমিনের সেশনের ভাষায় ফেরত পাঠাতে হবে তার req.t। কলার (একক
// approve/reject রুট বা বাল্ক লুপ) সবসময় req সহ কল করে, তাই এখানে ফলব্যাক হিসেবে raw key
// ফেরত দেওয়া identity ফাংশন যথেষ্ট (কখনো ব্যবহার না হওয়ার কথা)।
async function approvePaymentRequestById(id, t = (k) => k) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return { id, success: false, error: t('payment_request_not_found_or_processed') };
    }

    if (request.type === 'deposit') {
      await creditApprovedDeposit(client, request);
    } else {
      await client.query(`UPDATE payment_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success')`,
        [request.user_id, 'পেমেন্ট অনুমোদন', `আপনার ${request.amount} টাকার উইথড্র অনুমোদন হয়েছে!`]
      );
    }
    await client.query('COMMIT');
    return { id, success: true, userId: request.user_id, type: request.type, amount: request.amount };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('approve error:', err.message);
    return { id, success: false, error: t('payment_generic_error') };
  } finally {
    client.release();
  }
}

async function rejectPaymentRequestById(id, t = (k) => k) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return { id, success: false, error: t('payment_request_not_found_or_processed') };
    }
    if (request.type === 'withdraw') {
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [Math.round(Number(request.amount)), request.user_id]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'withdraw_refund', 'বাতিলকৃত উইথড্র ফেরত')`,
        [request.user_id, Math.round(Number(request.amount))]
      );
    }
    await client.query(`UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'error')`,
      [request.user_id, 'পেমেন্ট বাতিল', `আপনার ${request.amount} টাকার রিকোয়েস্ট বাতিল হয়েছে।`]
    );
    await client.query('COMMIT');
    return { id, success: true, userId: request.user_id, type: request.type, amount: request.amount };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reject error:', err.message);
    return { id, success: false, error: t('payment_generic_error') };
  } finally {
    client.release();
  }
}

router.post('/admin/approve/:id', requireAdmin, requirePermission('payments_approve'), async (req, res) => {
  const { id } = req.params;
  const result = await approvePaymentRequestById(id, req.t);
  if (result.success) {
    req.flash('success', req.t('payment_approved'));
  } else {
    req.flash('error', result.error);
  }
  res.redirect('/payment/admin/payments');
});

router.post('/admin/reject/:id', requireAdmin, requirePermission('payments_approve'), async (req, res) => {
  const { id } = req.params;
  const result = await rejectPaymentRequestById(id, req.t);
  if (result.success) {
    req.flash('error', req.t('payment_rejected'));
  } else {
    req.flash('error', result.error);
  }
  res.redirect('/payment/admin/payments');
});

// ==================== বাল্ক approve/reject ====================
router.post('/admin/payments/bulk-approve', requireAdmin, requirePermission('payments_approve'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const cleanIds = ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: req.t('common_no_item_selected') });
  }
  if (cleanIds.length > 100) {
    return res.status(400).json({ success: false, error: req.t('common_bulk_limit_100') });
  }

  const results = [];
  for (const id of cleanIds) {
    results.push(await approvePaymentRequestById(id, req.t));
  }
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  logAdminAction(
    req.session.user.id, req.session.user.username, 'BULK_PAYMENT_APPROVE',
    `বাল্ক অনুমোদন: ${succeeded.length}টা সফল, ${failed.length}টা ব্যর্থ (আইডি: ${cleanIds.join(',')})`, req.ip
  );
  succeeded.forEach((r) => {
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'PAYMENT_APPROVED', category: 'financial', status: 'success', riskLevel: 'medium',
      details: { paymentRequestId: r.id, targetUserId: r.userId, type: r.type, amount: r.amount, via: 'bulk' }
    }).catch((e) => console.error('logAuditEvent (BULK_PAYMENT_APPROVE) error:', e.message));
  });

  res.json({ success: true, total: cleanIds.length, succeeded: succeeded.length, failed: failed.length, results });
});

router.post('/admin/payments/bulk-reject', requireAdmin, requirePermission('payments_approve'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
  const cleanIds = ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: req.t('common_no_item_selected') });
  }
  if (cleanIds.length > 100) {
    return res.status(400).json({ success: false, error: req.t('common_bulk_limit_100') });
  }

  const results = [];
  for (const id of cleanIds) {
    results.push(await rejectPaymentRequestById(id, req.t));
  }
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  logAdminAction(
    req.session.user.id, req.session.user.username, 'BULK_PAYMENT_REJECT',
    `বাল্ক বাতিল: ${succeeded.length}টা সফল, ${failed.length}টা ব্যর্থ (আইডি: ${cleanIds.join(',')})`, req.ip
  );
  succeeded.forEach((r) => {
    logAuditEvent({
      req, actorType: 'admin', actorId: req.session.user.id, actorUsername: req.session.user.username,
      action: 'PAYMENT_REJECTED', category: 'financial', status: 'success', riskLevel: 'medium',
      details: { paymentRequestId: r.id, targetUserId: r.userId, type: r.type, amount: r.amount, via: 'bulk' }
    }).catch((e) => console.error('logAuditEvent (BULK_PAYMENT_REJECT) error:', e.message));
  });

  res.json({ success: true, total: cleanIds.length, succeeded: succeeded.length, failed: failed.length, results });
});

// ==================== SSLCommerz (বিকাশ/নগদ/রকেট/কার্ড) — সম্পূর্ণ অটোমেটিক ====================
// অ্যাডমিনকে কোনো কিছু ম্যানুয়ালি অনুমোদন করতে হয় না — গেটওয়ে ভ্যালিডেশন পাশ করলেই কয়েন যোগ হয়ে যায়।

// val_id গেটওয়ে থেকে আসে ঠিকই, কিন্তু সেটা *কোন* ট্রানজেকশনের val_id — আগে সেটা যাচাই করা হতো না।
// validatePayment() শুধু status ও amount ফেরত দিত এবং কোডটা সেই দুটোই মিলিয়ে ক্রেডিট করে দিত।
// ফলে একজন ইউজার নিজের আগের সফল ডিপোজিটের val_id (যেটা success_url-এ তার ব্রাউজারেই আসে, গোপন নয়)
// রেখে দিয়ে বারবার নতুন pending ডিপোজিট খুলে সেই একই val_id রিপ্লে করলে প্রতিবারই কয়েন পেয়ে যেত —
// একই টাকা দিয়ে সীমাহীন ক্রেডিট। এখন verification-এর tran_id অবশ্যই যে রিকোয়েস্টটা ক্রেডিট হচ্ছে
// তার gateway_tran_id-র সমান হতে হবে। গেটওয়ে tran_id না দিলে fail-closed (ক্রেডিট হবে না)।
function isVerificationForRequest(verification, request) {
  const returnedTran = verification && (verification.tran_id || verification.tranId);
  if (!returnedTran) return false;
  return String(returnedTran) === String(request.gateway_tran_id);
}

router.post('/sslcommerz/init', isAuth, requireFeature('deposit'), paymentLimiter, async (req, res) => {
  const wantBonus = req.body.want_bonus === 'yes';
  const amount = parseAmount(req.body.amount);
  const userId = req.session.user.id;

  if (amount === null || amount < 100) {
    req.flash('error', req.t('payment_min_deposit_100'));
    return res.redirect('/payment/deposit');
  }

  const tranId = `LIVO${userId}${Date.now()}${crypto.randomBytes(3).toString('hex')}`;

  try {
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status, want_bonus, gateway, gateway_tran_id)
       VALUES ($1, 'deposit', 'sslcommerz', $2, 'pending', $3, 'sslcommerz', $4)`,
      [userId, amount, wantBonus, tranId]
    );

    const baseUrl = getBaseUrl(req);
    const gatewayUrl = await sslcommerz.initPayment({
      amount,
      tranId,
      customer: {
        name: req.session.user.username,
        email: req.session.user.email,
        phone: req.session.user.phone
      },
      baseUrl
    });

    res.redirect(gatewayUrl);
  } catch (err) {
    console.error('sslcommerz init error:', err.message);
    // গেটওয়ে সেশন শুরু করা যায়নি (timeout/network/config এরর) — উপরে ইতিমধ্যে ঢোকানো
    // pending রো-টা চিরস্থায়ীভাবে pending থেকে যাওয়ার বদলে rejected করে দেওয়া হচ্ছে,
    // নাহলে ইউজারের history/admin ড্যাশবোর্ডে একটা কখনো-সেটল-না-হওয়া রো থেকে যায়।
    await pool.query(
      `UPDATE payment_requests SET status='rejected', updated_at=NOW() WHERE gateway_tran_id=$1 AND status='pending'`,
      [tranId]
    ).catch((e) => console.error('sslcommerz init cleanup error:', e.message));
    req.flash('error', req.t('payment_gateway_init_failed'));
    res.redirect('/payment/deposit');
  }
});

// SSLCommerz পেমেন্ট সফল হলে ইউজারের ব্রাউজার এখানে রিডাইরেক্ট হয়ে আসে
router.post('/sslcommerz/success', async (req, res) => {
  const { tran_id, val_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM payment_requests WHERE gateway_tran_id=$1 FOR UPDATE`, [tran_id]
    );
    const request = result.rows[0];

    if (!request) {
      await client.query('ROLLBACK');
      req.flash('error', req.t('payment_transaction_not_found'));
      return res.redirect('/payment/deposit');
    }
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.redirect('/payment/history'); // আগেই IPN দিয়ে ক্রেডিট হয়ে গেছে
    }

    const verification = await sslcommerz.validatePayment(val_id);
    const validStatus = verification.status === 'VALID' || verification.status === 'VALIDATED';
    // অঙ্ক তুলনা সবসময় স্টোর-কারেন্সির (BDT) মানের সাথে — currency_amount নয়।
    const amountMatches = paymentVerification.amountMatchesRequest(verification, request.amount);
    const tranMatches = isVerificationForRequest(verification, request);
    // আগে currency কখনো যাচাই হতো না — অন্য মুদ্রায় সেটল হওয়া ট্রানজেকশনের সংখ্যাগত
    // তুলনা পাস করে যেতে পারত যদিও আসল মূল্য বহুগুণ কম।
    const currencyMatches = paymentVerification.isExpectedCurrency(verification);

    if (!validStatus || !amountMatches || !tranMatches || !currencyMatches) {
      await client.query(
        `UPDATE payment_requests SET status='rejected', gateway_val_id=$1, gateway_response=$2, updated_at=NOW() WHERE id=$3`,
        [val_id, JSON.stringify(verification), request.id]
      );
      await client.query('COMMIT');
      req.flash('error', req.t('payment_verification_failed'));
      return res.redirect('/payment/deposit');
    }

    await client.query(
      `UPDATE payment_requests SET gateway_val_id=$1, gateway_response=$2 WHERE id=$3`,
      [val_id, JSON.stringify(verification), request.id]
    );
    await creditApprovedDeposit(client, request);
    await client.query('COMMIT');

    if (req.session.user) {
      const u = await pool.query('SELECT coins FROM users WHERE id=$1', [request.user_id]);
      req.session.user.coins = u.rows[0].coins;
    }
    req.flash('success', req.t('payment_deposit_success_amount').replace('{value}', request.amount));
    res.redirect('/payment/history');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sslcommerz success error:', err.message);
    req.flash('error', req.t('payment_error_contact_support'));
    res.redirect('/payment/deposit');
  } finally {
    client.release();
  }
});

// fail/cancel কলব্যাক দুটো CSRF-এক্সেম্পট (middleware/csrf.js) এবং /success ও /ipn-এর মতো
// গেটওয়ে ভ্যালিডেশনও করে না — আগে শুধু tran_id মিললেই pending রিকোয়েস্ট rejected করে দিত।
// অর্থাৎ কারো tran_id জানা থাকলে (এটা গোপন নয় — গেটওয়েতে যায়, /payment/history-তেও দেখা যায়)
// সে অন্যের চলমান ডিপোজিট বাতিল করে দিতে পারত। এখন দুই স্তরের যাচাই:
//   ১) লগইন করা ইউজারের নিজের রিকোয়েস্ট হলে সরাসরি বাতিল করা যায় (user_id দিয়ে স্কোপড),
//   ২) সেশন না থাকলে (গেটওয়ে সরাসরি সার্ভার-টু-সার্ভার পোস্ট করলে) গেটওয়েতে ভ্যালিডেট করে
//      নিশ্চিত হওয়া হয় যে পেমেন্টটা আসলেই সফল হয়নি — তবেই rejected করা হয়।
async function rejectPendingGatewayRequest(req, tranId) {
  if (!tranId) return false;

  const sessionUserId = req.session && req.session.user ? req.session.user.id : null;
  if (sessionUserId) {
    const scoped = await pool.query(
      `UPDATE payment_requests SET status='rejected', updated_at=NOW()
       WHERE gateway_tran_id=$1 AND status='pending' AND user_id=$2`,
      [tranId, sessionUserId]
    );
    return scoped.rowCount > 0;
  }

  const existing = await pool.query(
    `SELECT id FROM payment_requests WHERE gateway_tran_id=$1 AND status='pending'`,
    [tranId]
  );
  if (!existing.rows[0]) return false;

  // সেশন নেই — গেটওয়ের কাছে যাচাই না করে কিছুতেই স্ট্যাটাস বদলানো হবে না।
  let verification = null;
  try {
    verification = await sslcommerz.validateByTransactionId(tranId);
  } catch (e) {
    console.error('sslcommerz fail/cancel validation error:', e.message);
    return false;
  }
  const paidStatus = verification && (verification.status === 'VALID' || verification.status === 'VALIDATED');
  if (paidStatus) return false; // আসলে পেমেন্ট সফল — /ipn এটাকে ক্রেডিট করবে, এখানে হাত দেওয়া যাবে না

  const updated = await pool.query(
    `UPDATE payment_requests SET status='rejected', gateway_response=$2, updated_at=NOW()
     WHERE gateway_tran_id=$1 AND status='pending'`,
    [tranId, JSON.stringify(verification || {})]
  );
  return updated.rowCount > 0;
}

router.post('/sslcommerz/fail', async (req, res) => {
  try {
    await rejectPendingGatewayRequest(req, req.body.tran_id);
  } catch (e) { console.error('sslcommerz fail error:', e.message); }
  req.flash('error', req.t('payment_failed'));
  res.redirect('/payment/deposit');
});

router.post('/sslcommerz/cancel', async (req, res) => {
  try {
    await rejectPendingGatewayRequest(req, req.body.tran_id);
  } catch (e) { console.error('sslcommerz cancel error:', e.message); }
  req.flash('error', req.t('payment_cancelled'));
  res.redirect('/payment/deposit');
});

// সার্ভার-টু-সার্ভার IPN — ব্যাকআপ হিসেবে, যদি ইউজারের ব্রাউজার success_url এ ফিরে না আসে
router.post('/sslcommerz/ipn', async (req, res) => {
  const { tran_id, val_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM payment_requests WHERE gateway_tran_id=$1 FOR UPDATE`, [tran_id]
    );
    const request = result.rows[0];
    if (!request || request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.sendStatus(200);
    }

    const verification = await sslcommerz.validatePayment(val_id);
    const validStatus = verification.status === 'VALID' || verification.status === 'VALIDATED';
    // অঙ্ক তুলনা সবসময় স্টোর-কারেন্সির (BDT) মানের সাথে — currency_amount নয়।
    const amountMatches = paymentVerification.amountMatchesRequest(verification, request.amount);
    const tranMatches = isVerificationForRequest(verification, request);
    // আগে currency কখনো যাচাই হতো না — অন্য মুদ্রায় সেটল হওয়া ট্রানজেকশনের সংখ্যাগত
    // তুলনা পাস করে যেতে পারত যদিও আসল মূল্য বহুগুণ কম।
    const currencyMatches = paymentVerification.isExpectedCurrency(verification);

    if (validStatus && amountMatches && tranMatches && currencyMatches) {
      await client.query(
        `UPDATE payment_requests SET gateway_val_id=$1, gateway_response=$2 WHERE id=$3`,
        [val_id, JSON.stringify(verification), request.id]
      );
      await creditApprovedDeposit(client, request);
    }
    await client.query('COMMIT');
    res.sendStatus(200);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sslcommerz ipn error:', err.message);
    // IPN হলো ব্রাউজার success_url-এ ফিরে না এলে ব্যাকআপ ডেলিভারি পথ (উপরের কমেন্ট দ্রষ্টব্য)।
    // আগে এখানে সবসময় 200 রিটার্ন হতো — অভ্যন্তরীণ ব্যর্থতাতেও (DB এরর, গেটওয়ে timeout) —
    // ফলে SSLCommerz সেটাকে "ডেলিভারড" ধরে নিয়ে আর রিট্রাই করত না, আর যে ডিপোজিট আসলে
    // সফল হয়েছিল সেটা চিরস্থায়ীভাবে pending থেকে যেতে পারত। এখন শুধু "কিছু করার নেই"
    // কেসগুলোতেই (রিকোয়েস্ট নেই / ইতিমধ্যে প্রসেসড — try ব্লকের প্রথম দিকে) 200 যায়;
    // সত্যিকারের অভ্যন্তরীণ ব্যর্থতায় 500 যায় যাতে গেটওয়ে তার নিজস্ব রিট্রাই নীতি অনুযায়ী আবার পাঠায়।
    res.sendStatus(500);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.creditApprovedDeposit = creditApprovedDeposit;
