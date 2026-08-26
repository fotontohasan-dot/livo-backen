// services/contest.js
// রেফারেল কনটেস্ট — চলতি মাসে কে সবচেয়ে বেশি রেফার করেছে তার লিডারবোর্ড।
// মাস শেষে অ্যাডমিন শীর্ষ রেফারকারীদের প্রাইজ দেবে (ম্যানুয়ালি)।

const { pool } = require('../db');

// প্রাইজ কাঠামো (শুধু দেখানোর জন্য — বাস্তব প্রাইজ অ্যাডমিন দেবে)
const PRIZES = [
  { rank: 1, prize: '৫,০০০ টাকা / স্মার্টফোন' },
  { rank: 2, prize: '৩,০০০ টাকা' },
  { rank: 3, prize: '২,০০০ টাকা' },
  { rank: 4, prize: '১,০০০ টাকা' },
  { rank: 5, prize: '৫০০ টাকা' }
];

// চলতি মাসের লিডারবোর্ড (টপ ২০)
async function getLeaderboard(currentUserId) {
  // চলতি মাসের শুরু
  const r = await pool.query(
    `SELECT u.id, u.username,
            COUNT(rf.id) AS referrals
     FROM referrals rf
     JOIN users u ON rf.referrer_id = u.id
     WHERE to_char(rf.created_at, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')
     GROUP BY u.id, u.username
     ORDER BY referrals DESC, u.id ASC
     LIMIT 20`
  );

  const leaders = r.rows.map((row, i) => ({
    rank: i + 1,
    username: row.username,
    referrals: parseInt(row.referrals),
    isMe: row.id === currentUserId,
    prize: (PRIZES.find(p => p.rank === i + 1) || {}).prize || null
  }));

  // আমার নিজের অবস্থান (যদি টপ ২০-তে না থাকি)
  let myRank = null;
  const mine = leaders.find(l => l.isMe);
  if (!mine) {
    const mr = await pool.query(
      `SELECT COUNT(rf.id) AS referrals
       FROM referrals rf
       WHERE rf.referrer_id = $1
         AND to_char(rf.created_at, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')`,
      [currentUserId]
    );
    myRank = { referrals: parseInt(mr.rows[0].referrals) };
  }

  // চলতি মাসের নাম
  const monthName = new Date().toLocaleDateString('bn-BD', { month: 'long', year: 'numeric' });

  return { leaders, myRank, prizes: PRIZES, monthName };
}

// একটা নির্দিষ্ট অতীত মাসের (monthsBack মাস আগে) টপ ৫ বিজয়ী — user_id সহ, যাতে
// payout tracking (routes/adminLeaderboard.js) রেকর্ড তৈরির সময় ইউজারকে পিন করতে পারে।
// getPastContests() এই ফাংশনটাই ভেতরে ব্যবহার করে, তাই দুই জায়গায় একই কুয়েরি রাখা লাগে না।
async function getContestWinnersForMonth(monthsBack) {
  const r = await pool.query(
    `SELECT u.id, u.username, COUNT(rf.id) AS referrals
     FROM referrals rf
     JOIN users u ON rf.referrer_id = u.id
     WHERE to_char(rf.created_at, 'YYYY-MM') = to_char(CURRENT_DATE - ($1 || ' months')::interval, 'YYYY-MM')
     GROUP BY u.id, u.username
     ORDER BY referrals DESC, u.id ASC
     LIMIT 5`,
    [monthsBack]
  );
  const monthDate = new Date(new Date().setMonth(new Date().getMonth() - monthsBack));
  const monthKey = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
  const monthName = monthDate.toLocaleDateString('bn-BD', { month: 'long', year: 'numeric' });
  const leaders = r.rows.map((row, idx) => ({
    rank: idx + 1,
    userId: row.id,
    username: row.username,
    referrals: parseInt(row.referrals),
    prize: (PRIZES.find(p => p.rank === idx + 1) || {}).prize || null
  }));
  return { monthKey, monthName, leaders };
}

// আগের মাসগুলোর ফলাফল (টপ ৫, শেষ ৩ মাস)
async function getPastContests(currentUserId, monthsBack = 3) {
  const results = [];
  for (let i = 1; i <= monthsBack; i++) {
    const { monthName, leaders } = await getContestWinnersForMonth(i);
    if (leaders.length === 0) continue;
    results.push({
      monthName,
      leaders: leaders.map(l => ({ ...l, isMe: l.userId === currentUserId }))
    });
  }
  return results;
}

module.exports = { getLeaderboard, getPastContests, getContestWinnersForMonth, PRIZES };
