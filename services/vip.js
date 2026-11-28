// services/vip.js
// VIP লেভেল সিস্টেম — মোট লাইফটাইম টার্নওভার (বাজি) অনুযায়ী লেভেল।
// বাজি ধরলে total_turnover বাড়ে; নতুন লেভেলে পৌঁছালে আপগ্রেড বোনাস।

const { pool } = require('../db');
const { createBonus } = require('./turnover');

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
      // লেভেল আপগ্রেড ও আপগ্রেড বোনাস — একই ট্রানজেকশনে।
      //
      // আগে লেভেল আলাদা কোয়েরিতে কমিট হয়ে যেত, তারপর বোনাস আলাদা ট্রানজেকশনে।
      // বোনাস ব্যর্থ হলে ইউজার লেভেল পেয়ে যেত কিন্তু বোনাস হারাত — আর
      // `vip_level < $1` গার্ডের কারণে পরের বাজিতেও আর কখনো বোনাসটা পেত না,
      // কারণ লেভেল ইতিমধ্যে বেড়ে গেছে। টাকাটা নিঃশব্দে হারিয়ে যেত।
      //
      // গার্ডটা রাখা হয়েছে — সমান্তরাল দুটো বাজি একই আপগ্রেডের বোনাস দুবার
      // দিতে পারবে না; শুধু যে ট্রানজেকশন আসলে লেভেল বাড়িয়েছে সেটাই বোনাস দেয়।
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const levelUp = await client.query(
          `UPDATE users SET vip_level = $1 WHERE id = $2 AND COALESCE(vip_level, 0) < $1 RETURNING id`,
          [newLevel, userId]
        );
        if (levelUp.rowCount === 0) {
          await client.query('ROLLBACK');
          return;
        }

        if (bonus > 0) {
          await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonus, userId]);
          await createBonus(client, userId, 'daily', bonus); // টার্নওভার ৫x
          await client.query(
            `INSERT INTO coin_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'vip_upgrade', $3)`,
            [userId, bonus, `VIP ${name} আপগ্রেড বোনাস`]
          );
        }
        // আপগ্রেড ও পুরস্কার ইতিহাস — একই ট্রানজেকশনে (অ্যাডমিন VIP হিস্ট্রি/অ্যানালিটিক্স এই টেবিল পড়ে)
        await client.query(
          `INSERT INTO vip_upgrade_history (user_id, from_level, to_level, bonus, total_turnover_at_upgrade)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, currentLevel, newLevel, bonus, totalTurnover]
        );
        if (bonus > 0) {
          await client.query(
            `INSERT INTO vip_reward_history (user_id, vip_level, reward_type, amount, description)
             VALUES ($1, $2, 'upgrade_bonus', $3, $4)`,
            [userId, newLevel, bonus, `VIP ${name} আপগ্রেড বোনাস`]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'VIP আপগ্রেড!', $2, 'success')`,
        [userId, `অভিনন্দন! আপনি VIP ${name} (লেভেল ${newLevel}) হয়েছেন।${bonus > 0 ? ' বোনাস: ' + bonus + ' টাকা।' : ''}`]
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

// ==================== Admin: VIP Level Management ====================
async function listVipLevelsAdmin() {
  return (await pool.query(`SELECT * FROM vip_levels ORDER BY level ASC`)).rows;
}

async function upsertVipLevel(data) {
  const level = parseInt(data.level, 10);
  if (!Number.isFinite(level) || level < 0) throw new Error('অবৈধ VIP লেভেল নম্বর');

  const name = String(data.name || '').trim().slice(0, 40) || `Level ${level}`;
  const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; };

  const existing = await pool.query(`SELECT id FROM vip_levels WHERE level = $1`, [level]);
  const fields = {
    name,
    min_turnover: num(data.min_turnover),
    upgrade_bonus: num(data.upgrade_bonus),
    daily_bonus: num(data.daily_bonus),
    weekly_bonus: num(data.weekly_bonus),
    monthly_bonus: num(data.monthly_bonus),
    cashback_percent: num(data.cashback_percent),
    withdrawal_limit: num(data.withdrawal_limit),
    deposit_bonus_percent: num(data.deposit_bonus_percent),
    birthday_bonus: num(data.birthday_bonus),
    priority_support: !!data.priority_support,
    exclusive_events: String(data.exclusive_events || '').slice(0, 500),
    icon: String(data.icon || '👑').slice(0, 10),
    is_active: data.is_active === undefined ? true : !!data.is_active
  };

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE vip_levels SET name=$1, min_turnover=$2, upgrade_bonus=$3, daily_bonus=$4, weekly_bonus=$5,
        monthly_bonus=$6, cashback_percent=$7, withdrawal_limit=$8, deposit_bonus_percent=$9, birthday_bonus=$10,
        priority_support=$11, exclusive_events=$12, icon=$13, is_active=$14, updated_at=NOW()
       WHERE level = $15`,
      [fields.name, fields.min_turnover, fields.upgrade_bonus, fields.daily_bonus, fields.weekly_bonus,
       fields.monthly_bonus, fields.cashback_percent, fields.withdrawal_limit, fields.deposit_bonus_percent,
       fields.birthday_bonus, fields.priority_support, fields.exclusive_events, fields.icon, fields.is_active, level]
    );
    return { created: false, level };
  } else {
    await pool.query(
      `INSERT INTO vip_levels (level, name, min_turnover, upgrade_bonus, daily_bonus, weekly_bonus, monthly_bonus,
        cashback_percent, withdrawal_limit, deposit_bonus_percent, birthday_bonus, priority_support, exclusive_events, icon, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [level, fields.name, fields.min_turnover, fields.upgrade_bonus, fields.daily_bonus, fields.weekly_bonus,
       fields.monthly_bonus, fields.cashback_percent, fields.withdrawal_limit, fields.deposit_bonus_percent,
       fields.birthday_bonus, fields.priority_support, fields.exclusive_events, fields.icon, fields.is_active]
    );
    return { created: true, level };
  }
}

async function toggleVipLevelActive(level, isActive) {
  await pool.query(`UPDATE vip_levels SET is_active = $1, updated_at = NOW() WHERE level = $2`, [!!isActive, level]);
}

// ==================== Admin: VIP Analytics Dashboard ====================
async function getVipAnalytics() {
  const perLevel = await pool.query(`
    SELECT vl.level, vl.name, vl.icon, vl.is_active,
      COUNT(u.id) AS user_count,
      COALESCE(SUM(u.total_turnover), 0) AS total_turnover
    FROM vip_levels vl
    LEFT JOIN users u ON u.vip_level = vl.level
    GROUP BY vl.level, vl.name, vl.icon, vl.is_active
    ORDER BY vl.level ASC
  `);

  const bonusByLevel = await pool.query(`
    SELECT vip_level AS level,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'upgrade_bonus'), 0) AS total_upgrade_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'daily_bonus'), 0) AS total_daily_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'weekly_bonus'), 0) AS total_weekly_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'monthly_bonus'), 0) AS total_monthly_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'cashback'), 0) AS total_cashback,
      COALESCE(SUM(amount), 0) AS total_all
    FROM vip_reward_history
    GROUP BY vip_level
  `);
  const bonusMap = {};
  bonusByLevel.rows.forEach(r => { bonusMap[r.level] = r; });

  const upgradeStats = await pool.query(`
    SELECT to_level, COUNT(*) AS upgrade_count, COALESCE(SUM(bonus),0) AS total_bonus_paid
    FROM vip_upgrade_history GROUP BY to_level ORDER BY to_level ASC
  `);

  const totals = await pool.query(`
    SELECT COALESCE(SUM(amount),0) AS grand_total_bonus FROM vip_reward_history
  `);

  return {
    perLevel: perLevel.rows.map(r => ({
      level: r.level, name: r.name, icon: r.icon, isActive: r.is_active,
      userCount: parseInt(r.user_count, 10),
      totalTurnover: Number(r.total_turnover),
      totalUpgradeBonus: Number(bonusMap[r.level]?.total_upgrade_bonus || 0),
      totalDailyBonus: Number(bonusMap[r.level]?.total_daily_bonus || 0),
      totalWeeklyBonus: Number(bonusMap[r.level]?.total_weekly_bonus || 0),
      totalMonthlyBonus: Number(bonusMap[r.level]?.total_monthly_bonus || 0),
      totalCashback: Number(bonusMap[r.level]?.total_cashback || 0),
      totalAll: Number(bonusMap[r.level]?.total_all || 0)
    })),
    upgradeStats: upgradeStats.rows.map(r => ({
      toLevel: r.to_level, upgradeCount: parseInt(r.upgrade_count, 10), totalBonusPaid: Number(r.total_bonus_paid)
    })),
    grandTotalBonus: Number(totals.rows[0].grand_total_bonus)
  };
}

// ==================== Admin: সব ইউজারের VIP রিওয়ার্ড/আপগ্রেড হিস্ট্রি (audit view) ====================
async function listAllRewardHistory({ page = 1, limit = 50, rewardType = null } = {}) {
  const params = [];
  let where = '';
  if (rewardType) { params.push(rewardType); where = `WHERE h.reward_type = $${params.length}`; }
  const offset = (page - 1) * limit;
  const countRes = await pool.query(`SELECT COUNT(*) FROM vip_reward_history h ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);
  const listParams = [...params, limit, offset];
  const rowsRes = await pool.query(
    `SELECT h.*, u.username FROM vip_reward_history h LEFT JOIN users u ON u.id = h.user_id ${where}
     ORDER BY h.created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function listAllUpgradeHistory({ page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;
  const countRes = await pool.query(`SELECT COUNT(*) FROM vip_upgrade_history`);
  const total = parseInt(countRes.rows[0].count, 10);
  const rowsRes = await pool.query(
    `SELECT h.*, u.username FROM vip_upgrade_history h LEFT JOIN users u ON u.id = h.user_id
     ORDER BY h.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = {
  addVipTurnover, getVipStatus,
  // অ্যাডমিন (7dd4627 থেকে পুনরুদ্ধার)
  listVipLevelsAdmin, upsertVipLevel, toggleVipLevelActive,
  getVipAnalytics, listAllRewardHistory, listAllUpgradeHistory
};
