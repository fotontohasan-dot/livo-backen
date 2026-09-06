// services/freebet.js
// ফ্রি বেট — সিস্টেম/অ্যাডমিন ইউজারকে ফ্রি বেট দেয়।
// ইউজার ক্লেইম করলে সেই পরিমাণ বোনাস কয়েন পায় (টার্নওভার শর্ত সহ — স্পোর্টস ৫x / ক্যাসিনো ৩৫x)।

const { pool } = require('../db');
const { createBonus } = require('./turnover');
const { t } = require('../utils/i18n');

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

// ফ্রি বেট ক্লেইম — বোনাস কয়েন + টার্নওভার বোনাস
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

    // কয়েন যোগ + টার্নওভার বোনাস তৈরি
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [fb.amount, userId]);
    await createBonus(client, userId, 'deposit', fb.amount);

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

module.exports = { grantFreeBet, hasFreeBetReason, getAllFreeBets, claimFreeBet };
