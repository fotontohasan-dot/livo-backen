// services/streak.js
// উইন স্ট্রিক বোনাস — পরপর ক্যাসিনো গেম জিতলে স্ট্রিক বাড়ে, হারলে ০।
// নির্দিষ্ট স্ট্রিকে পৌঁছালে অতিরিক্ত বোনাস কয়েন।

const { pool } = require('../db');

// পুরনো নিয়ম (ফিক্সড): 3win=50, 5win=150, 7win=400, 10win=1000 — বাতিল
// নতুন নিয়ম: প্রতি ৩টা টানা জয়ে (৩, ৬, ৯...) বাজির পরিমাণ অনুযায়ী ডায়নামিক বোনাস
// Bonus = Min(Max(বাজি × 20%, ২), ২০)
const STREAK_INTERVAL = 3;
const STREAK_MIN_BONUS = 2;
const STREAK_MAX_BONUS = 20;
const STREAK_PERCENT = 0.20;

function calcStreakBonus(betAmount) {
  const raw = Number(betAmount || 0) * STREAK_PERCENT;
  return Math.min(STREAK_MAX_BONUS, Math.max(STREAK_MIN_BONUS, Math.round(raw)));
}

// গেমের ফলাফল রেকর্ড করা।
// won = true (জিতেছে) হলে স্ট্রিক +১, false হলে ০।
// প্রতি ৩ জয়ে (multiples of 3) বাজির উপর ভিত্তি করে বোনাস দেয়।
// betAmount = এই জয়ের বাজির পরিমাণ (বোনাস ক্যালকুলেশনে ব্যবহৃত হয়)
// ফেরত: { streak, bonus, milestone } — bonus > 0 হলে মাইলস্টোন হিট
async function recordGameResult(userId, won, betAmount) {
  try {
    if (!won) {
      // হারলে স্ট্রিক রিসেট
      await pool.query(`UPDATE users SET win_streak = 0 WHERE id = $1`, [userId]);
      return { streak: 0, bonus: 0, milestone: 0 };
    }

    // স্ট্রিক বৃদ্ধি ও মাইলস্টোন বোনাস — একই ট্রানজেকশনে।
    //
    // আগে স্ট্রিক আলাদা কোয়েরিতে কমিট হয়ে যেত, তারপর বোনাস আলাদা ট্রানজেকশনে।
    // বোনাস ব্যর্থ হলে স্ট্রিক বেড়েই থাকত কিন্তু বোনাস হারিয়ে যেত, আর পরের
    // জয়ে স্ট্রিক ৪ হয়ে যাওয়ায় মাইলস্টোনটা আর কখনো ফিরত না।
    //
    // FOR UPDATE লক: একই ইউজারের দুটো জয় একসাথে সেটেল হলে আগে দুটোই একই
    // স্ট্রিক নম্বর দেখতে পারত এবং একই মাইলস্টোনের বোনাস দুবার দিত। লকের
    // ফলে দুটো জয় ক্রমানুসারে প্রক্রিয়া হয়।
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

      const upd = await client.query(
        `UPDATE users
           SET win_streak = COALESCE(win_streak,0) + 1,
               best_streak = GREATEST(COALESCE(best_streak,0), COALESCE(win_streak,0) + 1)
         WHERE id = $1
         RETURNING win_streak`,
        [userId]
      );
      const streak = upd.rows[0] ? upd.rows[0].win_streak : 0;

      // প্রতি ৩ জয়ে বোনাস (৩, ৬, ৯, ১২...)
      if (streak > 0 && streak % STREAK_INTERVAL === 0) {
        const bonus = calcStreakBonus(betAmount);
        await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonus, userId]);
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description)
           VALUES ($1, $2, 'win_streak', $3)`,
          [userId, bonus, `${streak} টানা জয় বোনাস`]
        );
        await client.query(
          `INSERT INTO notifications (user_id, title, message, type)
           VALUES ($1, 'উইন স্ট্রিক!', $2, 'success')`,
          [userId, `🔥 ${streak} টানা জয়! আপনি ${bonus} কয়েন বোনাস পেয়েছেন!`]
        );
        await client.query('COMMIT');
        return { streak, bonus, milestone: streak };
      }

      await client.query('COMMIT');
      return { streak, bonus: 0, milestone: 0 };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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

  // পরের মাইলস্টোন (পরের ৩-এর গুণিতক)
  const next = (Math.floor(current / STREAK_INTERVAL) + 1) * STREAK_INTERVAL;

  const history = (await pool.query(
    `SELECT amount, description, created_at FROM coin_transactions
     WHERE user_id = $1 AND type = 'win_streak' ORDER BY created_at DESC LIMIT 20`,
    [userId]
  )).rows;

  return {
    current,
    best,
    nextMilestone: next,
    nextBonusNote: `বাজির ২০% (সর্বনিম্ন ${STREAK_MIN_BONUS}, সর্বোচ্চ ${STREAK_MAX_BONUS} কয়েন)`,
    interval: STREAK_INTERVAL,
    minBonus: STREAK_MIN_BONUS,
    maxBonus: STREAK_MAX_BONUS,
    history
  };
}

module.exports = { recordGameResult, getStreak, calcStreakBonus };
