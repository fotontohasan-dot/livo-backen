// services/streak.js
// উইন স্ট্রিক বোনাস — পরপর ক্যাসিনো গেম জিতলে স্ট্রিক বাড়ে, হারলে ০।
// নির্দিষ্ট স্ট্রিকে পৌঁছালে অতিরিক্ত বোনাস কয়েন।

const { pool } = require('../db');

// স্ট্রিক মাইলস্টোন → মাল্টিপ্লায়ার (বেট অ্যামাউন্টের উপর ভিত্তি করে)
const MILESTONE_MULTIPLIERS = {
  3: 0.1,    // ৩ জয়ে ১০% বোনাস
  5: 0.5,    // ৫ জয়ে ৫০% বোনাস
  7: 1.0,    // ৭ জয়ে ১০০% বোনাস
  10: 5.0    // ১০ জয়ে ৫০০% বোনাস
};

// গেমের ফলাফল রেকর্ড করা।
// won = true (জিতেছে) হলে স্ট্রিক +১, false হলে ০।
// স্ট্রিক মাইলস্টোনে পৌঁছালে বোনাস দেয়।
async function recordGameResult(userId, won, betAmount = 0) {
  try {
    if (!won) {
      // হারলে স্ট্রিক রিসেট
      await pool.query(`UPDATE users SET win_streak = 0 WHERE id = $1`, [userId]);
      return { streak: 0, bonus: 0, milestone: 0 };
    }

    // জিতলে স্ট্রিক +১ + best_streak আপডেট
    const upd = await pool.query(
      `UPDATE users
         SET win_streak = COALESCE(win_streak,0) + 1,
             best_streak = GREATEST(COALESCE(best_streak,0), COALESCE(win_streak,0) + 1)
       WHERE id = $1
       RETURNING win_streak`,
      [userId]
    );
    const streak = upd.rows[0] ? upd.rows[0].win_streak : 0;

    // এই স্ট্রিক কি কোনো মাইলস্টোন?
    const multiplier = MILESTONE_MULTIPLIERS[streak] || 0;
    const bonus = multiplier > 0 ? (betAmount * multiplier) : 0;

    if (bonus > 0) {
      await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonus, userId]);
      await pool.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'win_streak', $3)`,
        [userId, bonus, `${streak} টানা জয় বোনাস (বেট: ${betAmount})`]
      );
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'উইন স্ট্রিক!', $2, 'success')`,
        [userId, `🔥 ${streak} টানা জয়! আপনি ${bonus} কয়েন বোনাস পেয়েছেন!`]
      );
      return { streak, bonus, milestone: streak };
    }

    return { streak, bonus: 0, milestone: 0 };
  } catch (e) {
    console.error('recordGameResult error:', e.message);
    return { streak: 0, bonus: 0, milestone: 0 };
  }
}

// স্ট্রিক অবস্থা দেখা
async function getStreak(userId) {
  const u = await pool.query(`SELECT win_streak, best_streak FROM users WHERE id = $1`, [userId]);
  const current = u.rows[0] ? (u.rows[0].win_streak || 0) : 0;
  const best = u.rows[0] ? (u.rows[0].best_streak || 0) : 0;

  // পরের মাইলস্টোন
  const milestones = Object.keys(MILESTONE_MULTIPLIERS).map(Number).sort((a, b) => a - b);
  const next = milestones.find(m => m > current) || null;

  const history = (await pool.query(
    `SELECT amount, description, created_at FROM coin_transactions
     WHERE user_id = $1 AND type = 'win_streak' ORDER BY created_at DESC LIMIT 20`,
    [userId]
  )).rows;

  return {
    current,
    best,
    nextMilestone: next,
    nextMultiplier: next ? MILESTONE_MULTIPLIERS[next] : 0,
    milestones: milestones.map(m => ({ streak: m, multiplier: MILESTONE_MULTIPLIERS[m] })),
    history
  };
}

module.exports = { recordGameResult, getStreak };
