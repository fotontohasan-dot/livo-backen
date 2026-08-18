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

// আজ ডিপোজিট করেছে কিনা — শুধু ডিপোজিট করলেই সোনার ডিম আনলক হবে
async function hasQualifyingActivityToday(userId) {
  const d = todayStr();

  const dep = await pool.query(
    `SELECT 1 FROM payment_requests
     WHERE user_id=$1 AND type='deposit' AND status='approved'
       AND (updated_at + interval '6 hours')::date = $2
     LIMIT 1`,
    [userId, d]
  );
  return !!dep.rows[0];
}

async function getRewardStatus(userId) {
  const redDone = await hasClaimedToday(userId, 'red_packet');
  const eggDone = await hasClaimedToday(userId, 'golden_egg');
  const qualifies = await hasQualifyingActivityToday(userId);
  return {
    redPacket: { claimed: redDone, locked: !redDone && !qualifies },
    goldenEgg: { claimed: eggDone, locked: !eggDone && !qualifies }
  };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function claimRedPacket(userId) {
  if (await hasClaimedToday(userId, 'red_packet')) {
    return { ok: false, message: 'আজকের লাল প্যাকেট ইতিমধ্যে নেওয়া হয়েছে' };
  }
  if (!(await hasQualifyingActivityToday(userId))) {
    return { ok: false, message: '🔒 প্যাকেট লক করা আছে। আজ ডিপোজিট করুন, তারপর দাবি করতে পারবেন।' };
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
    // ব্যালেন্স বাড়ানোর পাশাপাশি coin_transactions লেজারেও লিখতে হয়। আগে শুধু
    // daily_rewards ও bonuses টেবিলে লেখা হতো, coin_transactions-এ কিছুই যেত না —
    // ফলে ইউজারের ব্যালেন্স আর লেনদেন-ইতিহাসের যোগফল স্থায়ীভাবে আলাদা হয়ে যেত এবং
    // /profile/transactions-এ এই কয়েনগুলো কোথা থেকে এল তা দেখাই যেত না।
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'red_packet', 'লাল খামের দৈনিক পুরস্কার')`,
      [userId, amount]
    );
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
  if (!(await hasQualifyingActivityToday(userId))) {
    return { ok: false, message: '🔒 ডিম লক করা আছে। আজ ডিপোজিট করুন, তারপর ভাঙতে পারবেন।' };
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
    // উপরের মতোই — লেজার এন্ট্রি ছাড়া ব্যালেন্স বাড়ানো হয় না
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'golden_egg', 'গোল্ডেন এগের দৈনিক পুরস্কার')`,
      [userId, wonAmount]
    );
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
