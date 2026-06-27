// services/freebet.js
// ফ্রি বেট — অ্যাডমিন বা সিস্টেম ইউজারকে ফ্রি বেট দেয়।
// ফ্রি বেট দিয়ে বাজি ধরলে স্টেক নিজের ব্যালেন থেকে কাটে না।
// জিতলে শুধু লাভ (winnings) ব্যালন্সে যোগ হয়, স্টেক ফেরত আসে না (সন্ডার্ড নিয়ম)।

const { pool } = require('../db');

// ইউজারকে ফ্রি বেট দেওয়া (অ্যাডমিন/সিস্টেম)
async function grantFreeBet(userId, amount, reason) {
  if (!amount || amount <= 0) return;
  try {
    await pool.query(
      `INSERT INTO free_bets (user_id, amount, reason, status) VALUES ($1, $2, $3, 'active')`,
      [userId, amount, reason || 'reward']
    );
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'ফ্রি বেট!', $2, 'success')`,
      [userId, `আপনি ${amount} টাকার একটি ফ্রি বেট পেয়েছেন! বাজি ধরে ব্যবহার করুন।`]
    );
  } catch (e) {
    console.error('grantFreeBet error:', e.message);
  }
}

// ইউজারের active ফ্রি বেটগুলো
async function getActiveFreeBets(userId) {
  const r = await pool.query(
    `SELECT * FROM free_bets WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC`,
    [userId]
  );
  return r.rows;
}

// সব ফ্রি বেট (হিস্ট্রি সহ)
async function getAllFreeBets(userId) {
  const r = await pool.query(
    `SELECT * FROM free_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [userId]
  );
  return r.rows;
}

// একটা ফ্রি বেট ব্যবহার করা (used হিসেবে চিহত)
// transaction client দিয়ে ডাকা যায় (বাজির সাথে এক লেনদেনে)
async function useFreeBet(client, freeBetId, userId) {
  const db = client || pool;
  const r = await db.query(
    `UPDATE free_bets SET status = 'used', used_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'active'
     RETURNING amount`,
    [freeBetId, userId]
  );
  return r.rows[0] || null;
}

module.exports = { grantFreeBet, getActiveFreeBets, getAllFreeBets, useFreeBet };
