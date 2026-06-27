// services/missions.js
// ডেইলি মিশন — প্রতিদিন কিছু কাজ (বাজি ধরা, টার্নওভার) করলে রিওয়ার্ড।

const { pool } = require('../db');

function today() {
  return new Date().toISOString().slice(0, 10);
}

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

async function getMissions(userId) {
  const defs = (await pool.query(
    `SELECT * FROM mission_defs WHERE active = true ORDER BY reward ASC`
  )).rows;

  const um = await pool.query(
    `SELECT * FROM user_missions WHERE user_id = $1 AND mission_date = $2`,
    [userId, today()]
  );
  const row = um.rows[0] || { bet_count: 0, turnover: 0, claimed_ids: [] };
  const claimedIds = row.claimed_ids || [];

  const missions = defs.map(d => {
    let progress = 0;
    if (d.target_type === 'bet_count') progress = Number(row.bet_count);
    else if (d.target_type === 'turnover') progress = Number(row.turnover);

    const target = Number(d.target_value);
    const done = progress >= target;
    const claimed = claimedIds.includes(d.id);
    const pct = Math.min(100, Math.floor((progress / target) * 100));

    return {
      id: d.id,
      title: d.title,
      reward: d.reward,
      target,
      progress: progress > target ? target : progress,
      pct,
      done,
      claimed
    };
  });

  return missions;
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

    const um = await client.query(
      `SELECT * FROM user_missions WHERE user_id = $1 AND mission_date = $2 FOR UPDATE`,
      [userId, today()]
    );
    const row = um.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { success: false, message: 'আজ এখনো কোনো অগ্রগতি নেই।' };
    }

    const claimedIds = row.claimed_ids || [];
    if (claimedIds.includes(missionId)) {
      await client.query('ROLLBACK');
      return { success: false, message: 'এই মিশন আগেই ক্লেইম করা হয়েছে।' };
    }

    let progress = 0;
    if (d.target_type === 'bet_count') progress = Number(row.bet_count);
    else if (d.target_type === 'turnover') progress = Number(row.turnover);

    if (progress < Number(d.target_value)) {
      await client.query('ROLLBACK');
      return { success: false, message: 'মিশন এখনো সম্পূর্ণ হয়নি।' };
    }

    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [d.reward, userId]);
    await client.query(
      `UPDATE user_missions SET claimed_ids = array_append(claimed_ids, $1) WHERE id = $2`,
      [missionId, row.id]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'mission', $3)`,
      [userId, d.reward, `মিশন: ${d.title}`]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'মিশন সম্পন্ন!', $2, 'success')`,
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
