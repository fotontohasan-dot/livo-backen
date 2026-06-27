// services/social.js
// সোশ্যাল শেয়ার রিওয়ার্ড — দিনে একবার শেয়ার করলে বোনাস কয়েন।
// বাস্তব শেয়ার যাচাই সম্ভব নয়, তাই দিনে একবার ক্লেইমের সুযোগ দেওয়া হয়।

const { pool } = require('../db');

const SHARE_BONUS = 20; // প্রতিদিন শেয়ারে ২০ কয়েন

function today() {
  return new Date().toISOString().slice(0, 10);
}

// আজ শেয়ার বোনাস নেওয়া হয়েছে কিনা
async function getShareStatus(userId) {
  const r = await pool.query(
    `SELECT id FROM social_shares WHERE user_id = $1 AND share_date = $2`,
    [userId, today()]
  );
  return {
    bonus: SHARE_BONUS,
    claimed: r.rows.length > 0,
    available: r.rows.length === 0
  };
}

// শেয়ার বোনাস ক্লেইম
async function claimShare(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dup = await client.query(
      `SELECT id FROM social_shares WHERE user_id = $1 AND share_date = $2 FOR UPDATE`,
      [userId, today()]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: 'আজ শেয়ার বোনাস আগেই নেওয়া হয়েছে। আগামীকাল আবার আসুন।' };
    }

    await client.query(
      `INSERT INTO social_shares (user_id, share_date, bonus) VALUES ($1, $2, $3)`,
      [userId, today(), SHARE_BONUS]
    );
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [SHARE_BONUS, userId]);
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'social_share', 'সোশ্যাল শেয়ার বোনাস')`,
      [userId, SHARE_BONUS]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'শেয়ার বোনাস!', $2, 'success')`,
      [userId, `শেয়ার করার জন্য ${SHARE_BONUS} কয়েন পেয়েছেন!`]
    );

    await client.query('COMMIT');
    return { success: true, bonus: SHARE_BONUS, message: `${SHARE_BONUS} কয়েন পেয়েছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimShare error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

module.exports = { getShareStatus, claimShare, SHARE_BONUS };
