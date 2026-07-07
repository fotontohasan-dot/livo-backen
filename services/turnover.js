// services/turnover.js
// টার্নওভার (Wagering) সিস্টেমের সব লজিক এক জায়গায়।
// অন্য ফাইল থেকে শুধু এই ফাংশনগুলো ডাকলেই হবে।

const { pool } = require('../db');
const { getSetting } = require('./settings');

// ==================== বোনাসের গুণ (multiplier) নিয়ম ====================
// deposit.sports এখন অ্যাডমিন প্যানেলের 'turnover_multiplier' সেটিং থেকে আসে (ডিফল্ট ৫x)
const RULES = {
  deposit: { sports: 5, casino: 35 },  // ডিপোজিট বোনাস: স্পোর্টস ৫x (ডিফল্ট), ক্যাসিনো ৩৫x
  daily:   { sports: 3, casino: 0 }    // দৈনিক রিওয়ার্ড: স্পোর্টস ৩x, ক্যাসিনো প্রযোজ্য নয়
};

// ==================== ১. বোনাস তৈরি ====================
// ডিপোজিট বোনাস বা দৈনিক রিওয়ার্ড দেওয়ার সময় এটা ডাকা হবে।
// type = 'deposit' বা 'daily'
async function createBonus(client, userId, type, bonusAmount) {
  const rule = { ...RULES[type] };
  if (!rule || bonusAmount <= 0) return;

  if (type === 'deposit') {
    rule.sports = Number(await getSetting('turnover_multiplier')) || rule.sports;
  }

  const sportsReq = bonusAmount * rule.sports;
  const casinoReq = bonusAmount * rule.casino;

  // client থাকলে (transaction-এর ভেতর) সেটা ব্যবহার করি, নাহলে সরাসরি pool
  const db = client || pool;
  await db.query(
    `INSERT INTO bonuses (user_id, bonus_type, bonus_amount, sports_required, casino_required, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [userId, type, bonusAmount, sportsReq, casinoReq]
  );
}

// ==================== ২. বেট ধরলে টার্নওভার আপডেট ====================
// category = 'sports' বা 'casino'
// stake = বেটের পরিমাণ
// প্রতিটা active বোনাসের done বাড়ানো হবে; required পূরণ হলে completed।
async function addTurnover(userId, category, stake) {
  if (!['sports', 'casino'].includes(category)) return;
  if (!stake || stake <= 0) return;

  try {
    // এই ইউজারের সব active বোনাস
    const res = await pool.query(
      `SELECT * FROM bonuses WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC`,
      [userId]
    );

    for (const b of res.rows) {
      if (category === 'sports') {
        const newDone = Number(b.sports_done) + Number(stake);
        await pool.query(`UPDATE bonuses SET sports_done = $1, updated_at = NOW() WHERE id = $2`, [newDone, b.id]);
      } else {
        // casino_required 0 হলে (daily reward) ক্যাসিনো গণনা হবে না
        if (Number(b.casino_required) > 0) {
          const newDone = Number(b.casino_done) + Number(stake);
          await pool.query(`UPDATE bonuses SET casino_done = $1, updated_at = NOW() WHERE id = $2`, [newDone, b.id]);
        }
      }

      // শর্ত পূরণ হয়েছে কিনা চেক করে completed করা
      await checkAndComplete(b.id);
    }
  } catch (err) {
    console.error('addTurnover error:', err.message);
  }
}

// একটা বোনাসের শর্ত পূরণ হয়েছে কিনা দেখে status আপডেট
async function checkAndComplete(bonusId) {
  const r = await pool.query(`SELECT * FROM bonuses WHERE id = $1`, [bonusId]);
  const b = r.rows[0];
  if (!b || b.status !== 'active') return;

  // ডিপোজিট বোনাস: স্পোর্টস বা ক্যাসিনো — যেকোনো একটা পূরণ হলেই completed
  // দৈনিক রিওয়ার্ড: শুধু স্পোর্টস পূরণ হলে completed
  let done = false;
  if (b.bonus_type === 'deposit') {
    const sportsOk = Number(b.sports_required) > 0 && Number(b.sports_done) >= Number(b.sports_required);
    const casinoOk = Number(b.casino_required) > 0 && Number(b.casino_done) >= Number(b.casino_required);
    done = sportsOk || casinoOk;
  } else {
    done = Number(b.sports_done) >= Number(b.sports_required);
  }

  if (done) {
    await pool.query(`UPDATE bonuses SET status = 'completed', updated_at = NOW() WHERE id = $1`, [bonusId]);
  }
}

// ==================== ৩. উইথড্রর আগে চেক ====================
// কোনো active বোনাস থাকলে — উইথড্র আটকাবে।
// ফেরত দেয়: { allowed: true/false, pending: [...বাকি টার্নওভার...] }
async function canWithdraw(userId) {
  const res = await pool.query(
    `SELECT * FROM bonuses WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  if (res.rows.length === 0) {
    return { allowed: true, pending: [] };
  }

  // বাকি টার্নওভার হিসাব
  const pending = res.rows.map(b => ({
    type: b.bonus_type,
    sportsLeft: Math.max(0, Number(b.sports_required) - Number(b.sports_done)),
    casinoLeft: Number(b.casino_required) > 0 ? Math.max(0, Number(b.casino_required) - Number(b.casino_done)) : 0
  }));

  return { allowed: false, pending };
}

module.exports = { createBonus, addTurnover, canWithdraw, RULES };
