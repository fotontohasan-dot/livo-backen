// services/dailyReward.js
// দৈনিক টিয়ার রিওয়ার্ড সিস্টেমের সব লজিক এক জায়গায়।
// নিয়ম: প্রতিদিন ইউজার যত স্পোর্টস টার্নওভার করবে, টিয়ার অনুযায়ী তত বোনাস।
// দিন বদলালে (reward_date) অটো রিসেট — নতুন দিনের নতুন রো।

const { pool } = require('../db');

// আজকের তারিখ (সার্ভার লোকাল) — YYYY-MM-DD
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ==================== ১. বেট ধরলে দৈনিক টার্নওভার আপডেট ====================
// শুধু স্পোর্টস বেটে ডাকা হবে।
// race condition এড়াতে UPSERT (INSERT ... ON CONFLICT) ব্যবহার।
async function updateDailyTurnover(userId, betAmount) {
  if (!betAmount || betAmount <= 0) return;
  try {
    await pool.query(
      `INSERT INTO user_daily_rewards (user_id, reward_date, sports_turnover)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, reward_date)
       DO UPDATE SET sports_turnover = user_daily_rewards.sports_turnover + $3`,
      [userId, today(), betAmount]
    );
  } catch (err) {
    console.error('updateDailyTurnover error:', err.message);
  }
}

// ==================== ২. আজকের রিওয়ার্ড অবস্থা ====================
// ফেরত দেয়: {turnover, currentTier, nextTier, claimed, claimedAmount, tiers}
async function getTodayReward(userId) {
  // সব টিয়ার (ছোট থেকে বড়)
  const tierRes = await pool.query(
    `SELECT * FROM daily_reward_tiers ORDER BY min_turnover ASC`
  );
  const tiers = tierRes.rows;

  // আজকের রেকর্ড
  const r = await pool.query(
    `SELECT * FROM user_daily_rewards WHERE user_id = $1 AND reward_date = $2`,
    [userId, today()]
  );
  const row = r.rows[0];
  const turnover = row ? Number(row.sports_turnover) : 0;
  const claimed = row ? row.claimed : false;
  const claimedAmount = row ? row.claimed_amount : 0;

  // এখন কোন টিয়ারে আছে (সর্বোচ্চ যেটা ছুঁয়েছে), আর পরের টিয়ার কী
  let currentTier = null;
  let nextTier = null;
  for (const t of tiers) {
    if (turnover >= Number(t.min_turnover)) {
      currentTier = t;
    } else {
      nextTier = t;
      break;
    }
  }

  return { turnover, currentTier, nextTier, claimed, claimedAmount, tiers };
}

// ==================== ৩. রিওয়ার্ড ক্লেইম ====================
// নিরাপত্তা: transaction + FOR UPDATE, দিনে একবারই, টিয়ার সার্ভারে যাচাই।
// ফেরত দেয়: {success, amount, message}
async function claimDailyReward(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // আজকের রো লক করা (race condition প্রতিরোধ)
    const r = await client.query(
      `SELECT * FROM user_daily_rewards WHERE user_id = $1 AND reward_date = $2 FOR UPDATE`,
      [userId, today()]
    );
    const row = r.rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      return { success: false, message: 'আজ কোনো স্পোর্টস বেট করেননি।' };
    }
    if (row.claimed) {
      await client.query('ROLLBACK');
      return { success: false, message: 'আজকের রিওয়ার্ড আগেই নেওয়া হয়েছে।' };
    }

    // সার্ভারে টিয়ার যাচাই — turnover অনুযায়ী সর্বোচ্চ বোনাস
    const turnover = Number(row.sports_turnover);
    const tierRes = await client.query(
      `SELECT bonus_amount FROM daily_reward_tiers
       WHERE min_turnover <= $1 ORDER BY min_turnover DESC LIMIT 1`,
      [turnover]
    );

    if (tierRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: 'রিওয়ার্ড পেতে আরও বেট করুন।' };
    }

    const bonusAmount = tierRes.rows[0].bonus_amount;

    // কয়েন যোগ
    await client.query(
      `UPDATE users SET coins = coins + $1 WHERE id = $2`,
      [bonusAmount, userId]
    );

    // রিওয়ার্ড claimed চিহ্নিত
    await client.query(
      `UPDATE user_daily_rewards
         SET claimed = true, claimed_amount = $1, claimed_at = NOW()
       WHERE id = $2`,
      [bonusAmount, row.id]
    );

    // লেনদেন রেকর্ড
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'daily_reward', 'দৈনিক টিয়ার রিওয়ার্ড')`,
      [userId, bonusAmount]
    );

    // নোটিফিকেশন
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'দৈনিক রিওয়ার্ড!', $2, 'success')`,
      [userId, `আপনি ${bonusAmount} কয়েন দৈনিক রিওয়ার্ড পেয়েছেন!`]
    );

    await client.query('COMMIT');
    return { success: true, amount: bonusAmount, message: `${bonusAmount} কয়েন পেয়েছেন!` };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('claimDailyReward error:', err.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

module.exports = { updateDailyTurnover, getTodayReward, claimDailyReward };
