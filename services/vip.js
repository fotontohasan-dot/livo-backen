// services/vip.js
// VIP লেভেল সিস্টেম — মোট লাইফটাইম টার্নওভার (বাজি) অনুযায়ী লেভেল।
// বাজি ধরলে total_turnover বাড়ে; নতুন লেভেলে পৌঁছালে আপগ্রেড বোনাস।

const { pool } = require('../db');

// ==================== বাজিতে টার্নওভার যোগ + লেভেল চেক ====================
// গেম/স্পোর্টস বাজির পর ডাকা হবে।
async function addVipTurnover(userId, amount) {
  if (!amount || amount <= 0) return;
  try {
    // মোট টার্নওভার বাড়াও
    const upd = await pool.query(
      `UPDATE users SET total_turnover = COALESCE(total_turnover,0) + $1 WHERE id = $2 RETURNING total_turnover, vip_level`,
      [amount, userId]
    );
    if (upd.rowCount === 0) return;

    const totalTurnover = Number(upd.rows[0].total_turnover);
    const currentLevel = upd.rows[0].vip_level || 0;

    // এই টার্নওভারে সর্বোচ্চ কোন লেভেল প্রাপ্য?
    const lvlRes = await pool.query(
      `SELECT * FROM vip_levels WHERE min_turnover <= $1 ORDER BY level DESC LIMIT 1`,
      [totalTurnover]
    );
    if (lvlRes.rows.length === 0) return;

    const newLevel = lvlRes.rows[0].level;

    // লেভেল বেড়েছে? — আপগ্রেড বোনাস
    if (newLevel > currentLevel) {
      const bonus = lvlRes.rows[0].upgrade_bonus || 0;
      const name = lvlRes.rows[0].name;

      // লেভেল আপগ্রেডটা atomic ভাবে করা হয় (`vip_level < $1` গার্ড সহ)। আগে শর্তহীন UPDATE ছিল,
      // আর উপরের currentLevel পড়া হয়েছিল আলাদা কোয়েরিতে — একই ইউজারের দুইটা বাজি একসাথে এলে
      // দুটোই একই পুরনো currentLevel দেখত, দুটোই newLevel > currentLevel পেত এবং দুটোই
      // upgrade_bonus ক্রেডিট করত (একই আপগ্রেডের বোনাস দুইবার)। এখন কেবল যে কোয়েরিটা আসলে
      // লেভেল বাড়িয়েছে (rowCount === 1) সেটাই বোনাস দেয়; হেরে যাওয়া কলটা কিছুই করে না।
      const levelUp = await pool.query(
        `UPDATE users SET vip_level = $1 WHERE id = $2 AND COALESCE(vip_level, 0) < $1 RETURNING id`,
        [newLevel, userId]
      );
      if (levelUp.rowCount === 0) return;

      if (bonus > 0) {
        await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonus, userId]);
        await pool.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description)
           VALUES ($1, $2, 'vip_upgrade', $3)`,
          [userId, bonus, `VIP ${name} আপগ্রেড বোনাস`]
        );
      }
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'VIP আপগ্রেড!', $2, 'success')`,
        [userId, `অভিনন্দন! আপনি VIP ${name} (লেভেল ${newLevel}) হয়েছেন।${bonus > 0 ? ' বোনাস: ' + bonus + ' কয়েন।' : ''}`]
      );
    }
  } catch (e) {
    console.error('addVipTurnover error:', e.message);
  }
}

// ==================== VIP স্ট্যাটাস দেখা ====================
async function getVipStatus(userId) {
  const u = await pool.query(
    `SELECT total_turnover, vip_level FROM users WHERE id = $1`,
    [userId]
  );
  const totalTurnover = u.rows[0] ? Number(u.rows[0].total_turnover) : 0;
  const level = u.rows[0] ? (u.rows[0].vip_level || 0) : 0;

  const levels = (await pool.query(`SELECT * FROM vip_levels ORDER BY level ASC`)).rows;

  const current = levels.find(l => l.level === level) || levels[0];
  const next = levels.find(l => l.level === level + 1) || null;

  let progress = 1000;
  let toNext = 0;
  if (next) {
    const span = Number(next.min_turnover) - Number(current.min_turnover);
    const done = totalTurnover - Number(current.min_turnover);
    // Scale progress to 1000 instead of 100 as requested
    progress = span > 0 ? Math.min(1000, Math.floor((done / span) * 1000)) : 0;
    toNext = Math.max(0, Number(next.min_turnover) - totalTurnover);
  }

  return { totalTurnover, level, current, next, progress, toNext, levels };
}

module.exports = { addVipTurnover, getVipStatus };
