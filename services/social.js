// services/social.js
// **দৈনিক ক্লেইম বোনাস** — নামে "শেয়ার", কিন্তু শেয়ার যাচাই করা হয় না।
//
// কোনো প্ল্যাটফর্ম (Facebook/WhatsApp/Telegram) আমাদের জানায় না যে ইউজার
// সত্যিই কিছু শেয়ার করেছে কি না। তাই বাস্তবে যা হয়: ইউজার বোতাম চাপলে
// দিনে একবার বোনাস পায় — শেয়ার করুক বা না করুক।
//
// এটা নিজে কোনো নিরাপত্তা সমস্যা নয় (বোনাস দিনে একবার, সীমাবদ্ধ), কিন্তু
// ফিচারটাকে "শেয়ার করলে পুরস্কার" বলে উপস্থাপন করা ভুল — ইউজার ভাবে
// শেয়ার না করলে পাবে না, আর আমরা এমন কিছু যাচাই করার দাবি করি যা করি না।
//
// সত্যিকারের যাচাই চাইলে প্ল্যাটফর্মের share/post API ও OAuth লাগবে —
// সেটা আলাদা কাজ। ততক্ষণ UI-তে এটাকে দৈনিক বোনাস হিসেবেই দেখানো উচিত।

const { pool } = require('../db');
const { t } = require('../utils/i18n');
const { today: businessToday } = require('../utils/businessTime');

const SHARE_BONUS = 20; // প্রতিদিন ২০ কয়েন

// দিনের সংজ্ঞা কেন্দ্রীয় ব্যবসায়িক টাইমজোন থেকে — আগে UTC ধরা হতো, ফলে
// বাংলাদেশ সময় সন্ধ্যা ৬টায় "আজ" বদলে যেত এবং একই সন্ধ্যায় দুবার ক্লেইম
// করা যেত।
function today() {
  return businessToday();
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
async function claimShare(userId, lang = 'bn') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dup = await client.query(
      `SELECT id FROM social_shares WHERE user_id = $1 AND share_date = $2 FOR UPDATE`,
      [userId, today()]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: t(lang, 'social_share_bonus_claimed') };
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
    return { success: true, bonus: SHARE_BONUS, message: t(lang, 'reward_coins_received_share').replace('{value}', SHARE_BONUS) };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimShare error:', e.message);
    return { success: false, message: t(lang, 'common_server_error') };
  } finally {
    client.release();
  }
}

module.exports = { getShareStatus, claimShare, SHARE_BONUS };
