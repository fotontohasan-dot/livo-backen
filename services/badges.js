// services/badges.js
// ব্যাজ ও অর্জন — ইউজারের কার্যকলাপ অনুযায়ী স্বয়ংক্রিয় ব্যাজ।
// ব্যাজ পাওয়ার শর্ত এখানে কোডে ঠিক করা; অর্জিত ব্যাজ user_badges টেবিলে রাখা হয়।

const { pool } = require('../db');

// সব ব্যাজের সংজ্ঞা
// check(stats) → true হলে ব্যাজ প্রাপ্য
const BADGES = [
  { code: 'first_bet',     icon: '🎯', name: 'প্রথম বাজি',        desc: 'প্রথমবার বাজি ধরেছেন',           reward: 20,  check: s => s.totalBets >= 1 },
  { code: 'bet_50',        icon: '🎲', name: 'খেলোয়াড়',          desc: '৫০টি বাজি ধরেছেন',              reward: 100, check: s => s.totalBets >= 50 },
  { code: 'bet_500',       icon: '🏅', name: 'অভিজ্ঞ',            desc: '৫০০টি বাজি ধরেছেন',             reward: 500, check: s => s.totalBets >= 500 },
  { code: 'first_deposit', icon: '💰', name: 'প্রথম ডিপোজিট',     desc: 'প্রথমবার ডিপোজিট করেছেন',        reward: 50,  check: s => s.totalDeposited >= 1 },
  { code: 'deposit_10k',   icon: '💎', name: 'বড় বিনিয়োগকারী',   desc: 'মোট ১০,০০০+ ডিপোজিট করেছেন',     reward: 300, check: s => s.totalDeposited >= 10000 },
  { code: 'turnover_100k', icon: '🔥', name: 'হাই রোলার',         desc: 'মোট ১,০০,০০০+ টার্নওভার',        reward: 800, check: s => s.totalTurnover >= 100000 },
  { code: 'streak_5',      icon: '⚡', name: 'উইন স্ট্রিক',        desc: '৫ টানা জয় করেছেন',              reward: 200, check: s => s.bestStreak >= 5 },
  { code: 'vip_silver',    icon: '🥈', name: 'সিলভার VIP',        desc: 'VIP সিলভার লেভেলে পৌঁছেছেন',     reward: 100, check: s => s.vipLevel >= 1 },
  { code: 'vip_gold',      icon: '🥇', name: 'গোল্ড VIP',         desc: 'VIP গোল্ড লেভেলে পৌঁছেছেন',      reward: 300, check: s => s.vipLevel >= 2 },
  { code: 'referrer',      icon: '🤝', name: 'রেফারার',           desc: 'অন্তত ১ জনকে রেফার করেছেন',      reward: 100, check: s => s.referrals >= 1 },
  { code: 'referrer_10',   icon: '👥', name: 'টিম লিডার',         desc: '১০ জনকে রেফার করেছেন',           reward: 500, check: s => s.referrals >= 10 }
];

// ইউজারের পরিসংখ্যান বের করা
async function getUserStats(userId) {
  const u = (await pool.query(
    `SELECT total_deposited, total_turnover, vip_level, best_streak FROM users WHERE id = $1`,
    [userId]
  )).rows[0] || {};

  const betsRow = (await pool.query(
    `SELECT COUNT(*) AS c FROM coin_transactions WHERE user_id = $1 AND type IN ('bet','game_play')`,
    [userId]
  )).rows[0];

  const refRow = (await pool.query(
    `SELECT COUNT(*) AS c FROM referrals WHERE referrer_id = $1`,
    [userId]
  )).rows[0];

  return {
    totalBets: parseInt(betsRow.c) || 0,
    totalDeposited: Number(u.total_deposited) || 0,
    totalTurnover: Number(u.total_turnover) || 0,
    vipLevel: u.vip_level || 0,
    bestStreak: u.best_streak || 0,
    referrals: parseInt(refRow.c) || 0
  };
}

// নতুন অর্জিত ব্যাজ চেক করে দেওয়া (যা আগে পায়নি)
// ফেরত: নতুন পাওয়া ব্যাজের তালিকা
async function checkBadges(userId) {
  try {
    const stats = await getUserStats(userId);

    const earned = (await pool.query(
      `SELECT badge_code FROM user_badges WHERE user_id = $1`,
      [userId]
    )).rows.map(r => r.badge_code);

    const newly = [];
    for (const b of BADGES) {
      if (earned.includes(b.code)) continue;
      if (b.check(stats)) {
        // গুরুত্বপূর্ণ: ON CONFLICT DO NOTHING কনফ্লিক্টটা "গিলে ফেলে" — কোনো এরর থ্রো হয় না।
        // আগে রিটার্ন ভ্যালু দেখা হতো না, ফলে দুইটা concurrent checkBadges() (routes/games.js ও
        // routes/matches.js প্রতিটা বাজিতে await ছাড়া এটা ডাকে, অর্থাৎ একই ইউজারের একাধিক কল
        // সহজেই ওভারল্যাপ করে) দুটোই earned-লিস্ট ফাঁকা দেখত, একজনের INSERT সফল হতো আর
        // অন্যজনেরটা নীরবে skip হতো — কিন্তু দুজনেই coins ক্রেডিট করত। একই ব্যাজের রিওয়ার্ড
        // বারবার ইস্যু করা সম্ভব ছিল (unlimited coin duplication)।
        // RETURNING id দিয়ে এখন শুধু যে কলটা আসলেই রো ইনসার্ট করেছে সেটাই রিওয়ার্ড দেয়।
        const insertedBadge = await pool.query(
          `INSERT INTO user_badges (user_id, badge_code) VALUES ($1, $2)
           ON CONFLICT (user_id, badge_code) DO NOTHING RETURNING id`,
          [userId, b.code]
        );
        if (insertedBadge.rowCount === 0) continue; // অন্য একটা concurrent কল ইতিমধ্যে এই ব্যাজ দিয়ে দিয়েছে

        if (b.reward > 0) {
          await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [b.reward, userId]);
          await pool.query(
            `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'badge', $3)`,
            [userId, b.reward, `ব্যাজ: ${b.name}`]
          );
        }
        await pool.query(
          `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'নতুন ব্যাজ!', $2, 'success')`,
          [userId, `${b.icon} "${b.name}" ব্যাজ অর্জন করেছেন! +${b.reward} কয়েন`]
        );
        newly.push(b);
      }
    }
    return newly;
  } catch (e) {
    console.error('checkBadges error:', e.message);
    return [];
  }
}

// প্রোফাইলে দেখানোর জন্য — সব ব্যাজ + অর্জিত কিনা
async function getBadges(userId) {
  const earned = (await pool.query(
    `SELECT badge_code, earned_at FROM user_badges WHERE user_id = $1`,
    [userId]
  )).rows;
  const earnedMap = {};
  earned.forEach(r => { earnedMap[r.badge_code] = r.earned_at; });

  return BADGES.map(b => ({
    icon: b.icon,
    name: b.name,
    desc: b.desc,
    reward: b.reward,
    earned: !!earnedMap[b.code],
    earnedAt: earnedMap[b.code] || null
  }));
}

module.exports = { checkBadges, getBadges, BADGES };
