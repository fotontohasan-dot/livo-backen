// services/missions.js
// মিশন — ডেইলি (প্রতিদিন), উইকলি (এই সপ্তাহ), স্পেশাল (নির্দিষ্ট ইভেন্ট সময়কাল)।

const { pool } = require('../db');

function today() {
  return new Date().toISOString().slice(0, 10);
}

// সপ্তাহের শুরু (সোমবার) — YYYY-MM-DD
function weekStart() {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
function weekEnd() {
  const d = new Date(weekStart());
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

// প্রতিটা বাজিতে ডেইলি প্রোগ্রেস আপডেট (উইকলি/স্পেশাল এখান থেকেই অ্যাগ্রিগেট হয়)
async function updateMissionProgress(userId, stake) {
  if (!stake || stake <= 0) return;
  try {
    await pool.query(
      `INSERT INTO user_missions (user_id, mission_date, bet_count, turnover)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (user_id, mission_date)
       DO UPDATE SET bet_count = user_missions.bet_count + 1,
                     turnover = user_missions.turnover + $3`,
      [userId, today(), stake]
    );
  } catch (e) {
    console.error('updateMissionProgress error:', e.message);
  }
}

function buildMission(d, progress, claimed) {
  const target = Number(d.target_value);
  const done = progress >= target;
  const pct = Math.min(100, Math.floor((progress / target) * 100));
  return {
    id: d.id,
    title: d.title,
    reward: d.reward,
    period: d.period,
    target,
    progress: progress > target ? target : progress,
    pct,
    done,
    claimed
  };
}

// ডেইলি মিশনের প্রোগ্রেস (আজকের row থেকে)
async function getDailyMissions(userId) {
  const defs = (await pool.query(`SELECT * FROM mission_defs WHERE active = true AND period = 'daily' ORDER BY reward ASC`)).rows;
  const um = await pool.query(`SELECT * FROM user_missions WHERE user_id = $1 AND mission_date = $2`, [userId, today()]);
  const row = um.rows[0] || { bet_count: 0, turnover: 0, claimed_ids: [] };
  const claimedIds = row.claimed_ids || [];
  return defs.map(d => {
    const progress = d.target_type === 'bet_count' ? Number(row.bet_count) : Number(row.turnover);
    return buildMission(d, progress, claimedIds.includes(d.id));
  });
}

// উইকলি মিশনের প্রোগ্রেস (এই সপ্তাহের সব দিনের যোগফল)
async function getWeeklyMissions(userId) {
  const defs = (await pool.query(`SELECT * FROM mission_defs WHERE active = true AND period = 'weekly' ORDER BY reward ASC`)).rows;
  const agg = await pool.query(
    `SELECT COALESCE(SUM(bet_count),0) AS bet_count, COALESCE(SUM(turnover),0) AS turnover
     FROM user_missions WHERE user_id = $1 AND mission_date BETWEEN $2 AND $3`,
    [userId, weekStart(), weekEnd()]
  );
  const row = agg.rows[0];
  const claims = (await pool.query(
    `SELECT mission_id FROM mission_claims WHERE user_id = $1 AND period_key = $2`,
    [userId, weekStart()]
  )).rows.map(r => r.mission_id);

  return defs.map(d => {
    const progress = d.target_type === 'bet_count' ? Number(row.bet_count) : Number(row.turnover);
    return buildMission(d, progress, claims.includes(d.id));
  });
}

// স্পেশাল মিশনের প্রোগ্রেস (মিশনের নিজের start_date - end_date সময়কালের যোগফল)
async function getSpecialMissions(userId) {
  const defs = (await pool.query(
    `SELECT * FROM mission_defs WHERE active = true AND period = 'special'
     AND CURRENT_DATE BETWEEN start_date AND end_date ORDER BY reward ASC`
  )).rows;

  const missions = [];
  for (const d of defs) {
    const agg = await pool.query(
      `SELECT COALESCE(SUM(bet_count),0) AS bet_count, COALESCE(SUM(turnover),0) AS turnover
       FROM user_missions WHERE user_id = $1 AND mission_date BETWEEN $2 AND $3`,
      [userId, d.start_date, d.end_date]
    );
    const row = agg.rows[0];
    const claimed = (await pool.query(
      `SELECT 1 FROM mission_claims WHERE user_id = $1 AND mission_id = $2 AND period_key = $3`,
      [userId, d.id, String(d.start_date)]
    )).rows.length > 0;
    const progress = d.target_type === 'bet_count' ? Number(row.bet_count) : Number(row.turnover);
    missions.push(buildMission(d, progress, claimed));
  }
  return missions;
}

// সব মিশন একসাথে (ট্যাব অনুযায়ী)
async function getMissions(userId) {
  const [daily, weekly, special] = await Promise.all([
    getDailyMissions(userId),
    getWeeklyMissions(userId),
    getSpecialMissions(userId)
  ]);
  return { daily, weekly, special };
}

async function claimMission(userId, missionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const d = (await client.query(`SELECT * FROM mission_defs WHERE id = $1 AND active = true`, [missionId])).rows[0];
    if (!d) {
      await client.query('ROLLBACK');
      return { success: false, message: 'মিশন পাওয়া যায়নি।' };
    }

    if (d.period === 'daily') {
      const um = await client.query(
        `SELECT * FROM user_missions WHERE user_id = $1 AND mission_date = $2 FOR UPDATE`,
        [userId, today()]
      );
      const row = um.rows[0];
      if (!row) { await client.query('ROLLBACK'); return { success: false, message: 'আজ এখনো কোনো অগ্রগতি নেই।' }; }

      const claimedIds = row.claimed_ids || [];
      if (claimedIds.includes(missionId)) { await client.query('ROLLBACK'); return { success: false, message: 'এই মিশন আগেই ক্লেইম করা হয়েছে।' }; }

      const progress = d.target_type === 'bet_count' ? Number(row.bet_count) : Number(row.turnover);
      if (progress < Number(d.target_value)) { await client.query('ROLLBACK'); return { success: false, message: 'মিশন এখনো সম্পূর্ণ হয়নি।' }; }

      await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [d.reward, userId]);
      await client.query(`UPDATE user_missions SET claimed_ids = array_append(claimed_ids, $1) WHERE id = $2`, [missionId, row.id]);
    } else {
      // উইকলি / স্পেশাল — mission_claims দিয়ে ট্র্যাক
      const periodKey = d.period === 'weekly' ? weekStart() : String(d.start_date);
      const dateFrom = d.period === 'weekly' ? weekStart() : d.start_date;
      const dateTo = d.period === 'weekly' ? weekEnd() : d.end_date;

      const already = await client.query(
        `SELECT 1 FROM mission_claims WHERE user_id = $1 AND mission_id = $2 AND period_key = $3`,
        [userId, missionId, periodKey]
      );
      if (already.rows.length > 0) { await client.query('ROLLBACK'); return { success: false, message: 'এই মিশন আগেই ক্লেইম করা হয়েছে।' }; }

      const agg = await client.query(
        `SELECT COALESCE(SUM(bet_count),0) AS bet_count, COALESCE(SUM(turnover),0) AS turnover
         FROM user_missions WHERE user_id = $1 AND mission_date BETWEEN $2 AND $3`,
        [userId, dateFrom, dateTo]
      );
      const row = agg.rows[0];
      const progress = d.target_type === 'bet_count' ? Number(row.bet_count) : Number(row.turnover);
      if (progress < Number(d.target_value)) { await client.query('ROLLBACK'); return { success: false, message: 'মিশন এখনো সম্পূর্ণ হয়নি।' }; }

      await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [d.reward, userId]);
      await client.query(
        `INSERT INTO mission_claims (user_id, mission_id, period_key) VALUES ($1, $2, $3)`,
        [userId, missionId, periodKey]
      );
    }

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'mission', $3)`,
      [userId, d.reward, `মিশন: ${d.title}`]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'মিশন সম্পন্ন!', $2, 'success')`,
      [userId, `আপনি "${d.title}" মিশন শেষ করে ${d.reward} কয়েন পেয়েছেন!`]
    );

    await client.query('COMMIT');
    return { success: true, reward: d.reward, message: `${d.reward} কয়েন পেয়েছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimMission error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

module.exports = { updateMissionProgress, getMissions, claimMission };
