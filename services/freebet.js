// services/freebet.js
// ফ্রি বেট — সিস্টেম/অ্যাডমিন ইউজারকে ফ্রি বেট দেয়।
// ইউজার ক্লেইম করলে সেই পরিমাণ বোনাস টাকা পায় (টার্নওভার শর্ত সহ — স্পোর্টস ৫x / ক্যাসিনো ৩৫x)।

const { pool } = require('../db');
const { createBonus } = require('./turnover');
const { t } = require('../utils/i18n');

const FIRST_DEPOSIT_REASON = 'first_deposit';
const FIRST_DEPOSIT_MIN_AMOUNT = 500;     // এর নিচে যোগ্য নয়
const FIRST_DEPOSIT_TIER_LIMIT = 10000;   // ≤ এটা হলে ছোট অঙ্ক, > হলে বড় অঙ্ক
const FIRST_DEPOSIT_SMALL = 30;
const FIRST_DEPOSIT_LARGE = 50;
const FREE_BET_TURNOVER_KEY = 'free_bet_turnover_multiplier';
const FREE_BET_TURNOVER_DEFAULT = 3;

// ডিপোজিট অঙ্ক থেকে প্রথম-ডিপোজিট ফ্রি বেটের পরিমাণ (০ = যোগ্য নয়)
function firstDepositFreeBetAmount(depositAmount) {
  const a = Number(depositAmount);
  if (!Number.isFinite(a) || a < FIRST_DEPOSIT_MIN_AMOUNT) return 0;
  return a <= FIRST_DEPOSIT_TIER_LIMIT ? FIRST_DEPOSIT_SMALL : FIRST_DEPOSIT_LARGE;
}

// ফ্রি বেট ক্লেইমের টার্নওভার গুণক (শুধু first_deposit সারির জন্য); db = pool বা transaction client
async function getFreeBetTurnoverMultiplier(db) {
  try {
    const r = await db.query('SELECT value FROM site_settings WHERE key = $1', [FREE_BET_TURNOVER_KEY]);
    const n = Number(r.rows[0] && r.rows[0].value);
    return Number.isFinite(n) && n > 0 ? n : FREE_BET_TURNOVER_DEFAULT;
  } catch (_) {
    return FREE_BET_TURNOVER_DEFAULT;
  }
}

// grantFreeBet-এর client-সংস্করণ: কলারের খোলা transaction-এর client দিয়ে চলে (নিজে BEGIN/COMMIT করে না,
// এরর গিলে ফেলে না — কলার সিদ্ধান্ত নেবে)। বিদ্যমান pool-সংস্করণ grantFreeBet অপরিবর্তিত।
// নতুন সারি তৈরি হলে true, আগে থেকেই থাকলে false।
async function grantFreeBetWithClient(client, userId, amount, reason) {
  if (!amount || amount <= 0) return false;
  const inserted = await client.query(
    `INSERT INTO free_bets (user_id, amount, reason, status) VALUES ($1, $2, $3, 'active')
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, amount, reason || 'reward']
  );
  if (inserted.rowCount === 0) return false;
  await client.query(
    `INSERT INTO notifications (user_id, title, message, type)
     VALUES ($1, 'ফ্রি বেট!', $2, 'success')`,
    [userId, `আপনি ${amount} টাকার একটি ফ্রি বেট পেয়েছেন! প্রোফাইল থেকে ক্লেইম করুন।`]
  );
  return true;
}

// প্রথম যোগ্য approved ডিপোজিটে একবার ফ্রি বেট (≥৫০০; ≤১০০০০ → ৩০, >১০০০০ → ৫০)।
// - ডিপোজিটে want_bonus নেওয়া হলে নয়।
// - "first_deposit সারি আছে কিনা" দেখে সিদ্ধান্ত (ডিপোজিট গুনে নয়); সমান্তরাল দুই অনুমোদনে
//   uniq_free_bet_user_reason ইনডেক্স + ON CONFLICT DO NOTHING একটাই রাখে।
// - ডিপোজিটের transaction-এর client দিয়ে চলে → ডিপোজিট রোলব্যাক হলে ফ্রি বেটও যায়।
// - SAVEPOINT: ফ্রি বেট অংশে এরর হলেও ডিপোজিট অনুমোদন (ব্যালেন্স/টার্নওভার) অক্ষত থাকে।
// ফেরত: দেওয়া পরিমাণ (০ = দেওয়া হয়নি)।
async function grantFirstDepositFreeBet(client, request) {
  if (!request || request.type !== 'deposit' || request.want_bonus) return 0;
  const amount = firstDepositFreeBetAmount(request.amount);
  if (amount <= 0) return 0;

  const exists = await client.query(
    'SELECT 1 FROM free_bets WHERE user_id = $1 AND reason = $2 LIMIT 1',
    [request.user_id, FIRST_DEPOSIT_REASON]
  );
  if (exists.rowCount > 0) return 0;

  await client.query('SAVEPOINT first_deposit_freebet');
  try {
    const granted = await grantFreeBetWithClient(client, request.user_id, amount, FIRST_DEPOSIT_REASON);
    await client.query('RELEASE SAVEPOINT first_deposit_freebet');
    return granted ? amount : 0;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT first_deposit_freebet');
    await client.query('RELEASE SAVEPOINT first_deposit_freebet');
    console.error('grantFirstDepositFreeBet error:', e.message);
    return 0;
  }
}

// ইউজারকে ফ্রি বেট দেওয়া
async function grantFreeBet(userId, amount, reason) {
  if (!amount || amount <= 0) return;
  try {
    // ডুপ্লিকেট আটকানোর আসল ভরসা DB-র uniq_free_bet_user_reason ইনডেক্স।
    // hasFreeBetReason() দিয়ে কলারের আগাম চেকটা দ্রুত ও বন্ধুত্বপূর্ণ, কিন্তু
    // সমান্তরাল দুটো কল দুটোই ওই চেক পাস করতে পারে — তখন ইনডেক্সই থামায়।
    const inserted = await pool.query(
      `INSERT INTO free_bets (user_id, amount, reason, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT DO NOTHING RETURNING id`,
      [userId, amount, reason || 'reward']
    );
    // ইতিমধ্যে দেওয়া হয়ে গেছে — দ্বিতীয় নোটিফিকেশন পাঠানোর দরকার নেই।
    if (inserted.rowCount === 0) return;
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'ফ্রি বেট!', $2, 'success')`,
      [userId, `আপনি ${amount} টাকার একটি ফ্রি বেট পেয়েছেন! প্রোফাইল থেকে ক্লেইম করুন।`]
    );
  } catch (e) {
    console.error('grantFreeBet error:', e.message);
  }
}

// active ফ্রি বেট (একবারই দিতে — ডুপ্লিকেট আটকাতে)
async function hasFreeBetReason(userId, reason) {
  const r = await pool.query(
    `SELECT id FROM free_bets WHERE user_id = $1 AND reason = $2`,
    [userId, reason]
  );
  return r.rows.length > 0;
}

// সব ফ্রি বেট
async function getAllFreeBets(userId) {
  const r = await pool.query(
    `SELECT * FROM free_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [userId]
  );
  return r.rows;
}

// ফ্রি বেট ক্লেইম — বোনাস টাকা + টার্নওভার বোনাস
async function claimFreeBet(userId, freeBetId, lang = 'bn') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT * FROM free_bets WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
      [freeBetId, userId]
    );
    const fb = r.rows[0];
    if (!fb) {
      await client.query('ROLLBACK');
      return { success: false, message: t(lang, 'freebet_not_found_or_used') };
    }

    // টাকা যোগ + টার্নওভার বোনাস তৈরি
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [fb.amount, userId]);
    // শুধু first_deposit সারিতে নতুন সেটিং; অন্য ফ্রি বেটে বিদ্যমান আচরণ (কনফিগের বোনাস গুণক)।
    const bonusOpts = fb.reason === FIRST_DEPOSIT_REASON
      ? { multiplier: await getFreeBetTurnoverMultiplier(client) }
      : undefined;
    await createBonus(client, userId, 'deposit', fb.amount, bonusOpts);

    await client.query(
      `UPDATE free_bets SET status = 'used', used_at = NOW() WHERE id = $1 AND status = 'active'`,
      [freeBetId]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'free_bet', 'ফ্রি বেট ক্লেইম')`,
      [userId, fb.amount]
    );

    await client.query('COMMIT');
    return { success: true, amount: fb.amount, message: t(lang, 'freebet_received').replace('{value}', fb.amount) };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimFreeBet error:', e.message);
    return { success: false, message: t(lang, 'common_server_error') };
  } finally {
    client.release();
  }
}

module.exports = {
  grantFreeBet, hasFreeBetReason, getAllFreeBets, claimFreeBet,
  grantFreeBetWithClient, grantFirstDepositFreeBet, firstDepositFreeBetAmount, getFreeBetTurnoverMultiplier,
  FIRST_DEPOSIT_REASON
};
