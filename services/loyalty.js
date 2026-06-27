// services/loyalty.js
// লয়্যালটি পয়েন্ট — প্রতি বাজিতে পয়েন্ট জমে, পরে কয়েনে রূপান্তর করা যায়।
// নিয়ম: প্রতি ১০০ বাজিতে ১ পয়েন্ট। ১০০ পয়েন্ট = ১০ কয়েন (রূপান্তরে)।

const { pool } = require('../db');

const POINTS_PER_100_STAKE = 1;   // প্রতি ১০০ বাজিতে ১ পয়েন্ট
const POINT_TO_COIN = 0.1;        // ১ পয়েন্ট = ০.১ কয়েন (১০০ পয়েন্ট = ১০ কয়েন)
const MIN_REDEEM = 100;           // সর্বনিম্ন ১০০ পয়েন্ট রূপান্তর

// ==================== বাজিতে পয়েন্ট যোগ ====================
async function addPoints(userId, stake) {
  if (!stake || stake <= 0) return;
  const points = Math.floor(stake / 100) * POINTS_PER_100_STAKE;
  if (points <= 0) return;
  try {
    await pool.query(`UPDATE users SET loyalty_points = COALESCE(loyalty_points,0) + $1 WHERE id = $2`, [points, userId]);
    await pool.query(
      `INSERT INTO loyalty_ledger (user_id, points, reason) VALUES ($1, $2, 'earn')`,
      [userId, points]
    );
  } catch (e) {
    console.error('addPoints error:', e.message);
  }
}

// ==================== পয়েন্ট অবস্থা ====================
async function getLoyalty(userId) {
  const u = await pool.query(`SELECT loyalty_points FROM users WHERE id = $1`, [userId]);
  const points = u.rows[0] ? (u.rows[0].loyalty_points || 0) : 0;

  const history = (await pool.query(
    `SELECT * FROM loyalty_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  )).rows;

  return {
    points,
    coinValue: Math.floor(points * POINT_TO_COIN),
    minRedeem: MIN_REDEEM,
    pointToCoin: POINT_TO_COIN,
    history
  };
}

// ==================== পয়েন্ট কয়েনে রূপান্তর ====================
async function redeemPoints(userId, redeemPoints) {
  const pts = parseInt(redeemPoints);
  if (isNaN(pts) || pts < MIN_REDEEM) {
    return { success: false, message: `সর্বনিম্ন ${MIN_REDEEM} পয়েন্ট রূপান্তর করা যায়।` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query(`SELECT loyalty_points FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const have = u.rows[0] ? (u.rows[0].loyalty_points || 0) : 0;

    if (have < pts) {
      await client.query('ROLLBACK');
      return { success: false, message: 'পর্যাপ্ত পয়েন্ট নেই।' };
    }

    const coins = Math.floor(pts * POINT_TO_COIN);
    if (coins <= 0) {
      await client.query('ROLLBACK');
      return { success: false, message: 'রূপান্তরের পরিমাণ খুব কম।' };
    }

    await client.query(`UPDATE users SET loyalty_points = loyalty_points - $1, coins = coins + $2 WHERE id = $3`, [pts, coins, userId]);
    await client.query(
      `INSERT INTO loyalty_ledger (user_id, points, reason) VALUES ($1, $2, 'redeem')`,
      [userId, -pts]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'loyalty_redeem', $3)`,
      [userId, coins, `${pts} পয়েন্ট রূপান্তর`]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'পয়েন্ট রূপান্তর', $2, 'success')`,
      [userId, `${pts} পয়েন্ট = ${coins} কয়েন যোগ হয়েছে!`]
    );

    await client.query('COMMIT');
    return { success: true, coins, message: `${coins} কয়েন পেয়েছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('redeemPoints error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

module.exports = { addPoints, getLoyalty, redeemPoints };
