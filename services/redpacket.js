// services/redpacket.js
// লাল প্যাকেট + সোনার ডিম দৈনিক রিওয়ার্ড
const { pool } = require('../db');
const { createBonus } = require('./turnover');

function todayStr() {
  const d = new Date();
  const bd = new Date(d.getTime() + 6 * 3600 * 1000);
  return bd.toISOString().slice(0, 10);
}

async function hasClaimedToday(userId, type) {
  const r = await pool.query(
    `SELECT 1 FROM daily_rewards WHERE user_id=$1 AND reward_type=$2 AND claim_date=$3 LIMIT 1`,
    [userId, type, todayStr()]
  );
  return r.rows.length > 0;
}

async function getRewardStatus(userId) {
  const redDone = await hasClaimedToday(userId, 'red_packet');
  const eggDone = await hasClaimedToday(userId, 'golden_egg');
  return {
    redPacket: { claimed: redDone },
    goldenEgg: { claimed: eggDone }
  };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function claimRedPacket(userId) {
  if (await hasClaimedToday(userId, 'red_packet')) {
    return { ok: false, message: 'আজকের লাল প্যাকেট ইতিমধ্যে নেওয়া হয়েছে' };
  }
  const amount = randInt(10, 50);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO daily_rewards (user_id, reward_type, amount, claim_date)
       VALUES ($1, 'red_packet', $2, $3)`,
      [userId, amount, todayStr()]
    );
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [amount, userId]);
    await createBonus(client, userId, 'daily', amount);
    await client.query('COMMIT');
    return { ok: true, amount };
  } catch (e) {
    await client.query('ROLLBACK');
    return { ok: false, message: 'সমস্যা হয়েছে, আবার চেষ্টা করুন' };
  } finally {
    client.release();
  }
}

async function claimGoldenEgg(userId, pickedIndex) {
  if (await hasClaimedToday(userId, 'golden_egg')) {
    return { ok: false, message: 'আজকের সোনার ডিম ইতিমধ্যে নেওয়া হয়েছে' };
  }
  const wonAmount = randInt(10, 30);
  const reveal = [];
  for (let i = 0; i < 8; i++) {
    if (i === pickedIndex) reveal.push(wonAmount);
    else reveal.push(randInt(80, 999));
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO daily_rewards (user_id, reward_type, amount, claim_date)
       VALUES ($1, 'golden_egg', $2, $3)`,
      [userId, wonAmount, todayStr()]
    );
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [wonAmount, userId]);
    await createBonus(client, userId, 'daily', wonAmount);
    await client.query('COMMIT');
    return { ok: true, amount: wonAmount, reveal, pickedIndex };
  } catch (e) {
    await client.query('ROLLBACK');
    return { ok: false, message: 'সমস্যা হয়েছে, আবার চেষ্টা করুন' };
  } finally {
    client.release();
  }
}

module.exports = { getRewardStatus, claimRedPacket, claimGoldenEgg, hasClaimedToday };
