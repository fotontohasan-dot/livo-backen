// services/wheel.js
// লাকি হুইল — দিনে একবার ঘুরিয়ে পুরস্কার (কয়েন)।
// পুরস্কারগুলো নির্দিষ্ট, সার্ভারেই র‍্যান্ডম নির্বাচন (ক্লায়েন্ট ঠকাতে পারবে না)।

const { pool } = require('../db');
const { t } = require('../utils/i18n');
// পুরস্কার নির্বাচন টাকার ফলাফল নির্ধারণ করে, তাই CSPRNG (services/rng.js) — Math.random() নয়।
const { secureRandom } = require('./rng');

// হুইলের ঘর (পুরস্কার) — weight যত বেশি, আসার সম্ভাবনা তত বেশি
const SEGMENTS = [
  { prize: 0,    weight: 25 }, // আবার চেষ্টা করুন
  { prize: 0,    weight: 25 }, // আবার চেষ্টা করুন
  { prize: 0,    weight: 15 }, // আবার চেষ্টা করুন
  { prize: 0,    weight: 15 }, // আবার চেষ্টা করুন
  { prize: 5,    weight: 45 },
  { prize: 5,    weight: 35 },
  { prize: 10,   weight: 25 },
  { prize: 10,   weight: 20 },
  { prize: 20,   weight: 8 },
  { prize: 50,   weight: 3 },
  { prize: 100,  weight: 1 },
  { prize: 500,  weight: 0.3 }
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

// সব সম্ভাব্য পুরস্কার (ফ্রন্টএন্ডে হুইল আঁকতে)
function getSegments() {
  return SEGMENTS.map(s => s.prize);
}

// আজ ডিপোজিট করেছে কিনা — শুধু ডিপোজিট করলেই হুইল আনলক হবে
async function hasQualifyingActivityToday(userId) {
  const d = today();

  const dep = await pool.query(
    `SELECT 1 FROM payment_requests
     WHERE user_id=$1 AND type='deposit' AND status='approved' AND updated_at::date = $2
     LIMIT 1`,
    [userId, d]
  );
  return !!dep.rows[0];
}

// আজ স্পিন করা হয়েছে কিনা
async function canSpin(userId) {
  const r = await pool.query(
    `SELECT * FROM wheel_spins WHERE user_id = $1 AND spin_date = $2`,
    [userId, today()]
  );
  if (r.rows[0]) {
    return { canSpin: false, prize: r.rows[0].prize, locked: false };
  }

  const qualifies = await hasQualifyingActivityToday(userId);
  if (!qualifies) {
    return { canSpin: false, prize: null, locked: true };
  }

  return { canSpin: true, prize: null, locked: false };
}

// weighted random — পুরস্কার নির্বাচন
function pickPrize() {
  const total = SEGMENTS.reduce((s, x) => s + x.weight, 0);
  let rnd = secureRandom() * total;
  for (const seg of SEGMENTS) {
    if (rnd < seg.weight) return seg.prize;
    rnd -= seg.weight;
  }
  return SEGMENTS[0].prize;
}

// স্পিন করা (দিনে একবার, transaction সহ)
async function spin(userId, lang = 'bn') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // আজ স্পিন করেছে কিনা (লক)
    const existing = await client.query(
      `SELECT id FROM wheel_spins WHERE user_id = $1 AND spin_date = $2 FOR UPDATE`,
      [userId, today()]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: t(lang, 'wheel_already_spun_today') };
    }

    // লক চেক: আজ ডিপোজিট বা গেম/বেট খেলা না থাকলে স্পিন করা যাবে না
    const qualifies = await hasQualifyingActivityToday(userId);
    if (!qualifies) {
      await client.query('ROLLBACK');
      return { success: false, message: t(lang, 'wheel_locked_deposit_required') };
    }

    // পুরস্কার নির্বাচন
    const prize = pickPrize();

    // রেকর্ড (প্রতিদিন একবার, prize=0 হলেও গণনা হবে)
    await client.query(
      `INSERT INTO wheel_spins (user_id, spin_date, prize) VALUES ($1, $2, $3)`,
      [userId, today(), prize]
    );

    if (prize > 0) {
      await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [prize, userId]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'lucky_wheel', 'লাকি হুইল পুরস্কার')`,
        [userId, prize]
      );
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'লাকি হুইল!', $2, 'success')`,
        [userId, `আপনি লাকি হুইলে ${prize} কয়েন জিতেছেন!`]
      );
    } else {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'লাকি হুইল', $2, 'info')`,
        [userId, 'এবার কিছু পাননি। আগামীকাল আবার চেষ্টা করুন!']
      );
    }

    await client.query('COMMIT');

    // ফ্রন্টএন্ডে কোন ঘরে থামবে তার ইনডেক্স
    const index = SEGMENTS.findIndex(s => s.prize === prize);
    const message = prize > 0 ? t(lang, 'reward_coins_won').replace('{value}', prize) : t(lang, 'wheel_no_prize');
    return { success: true, prize, index, message };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('wheel spin error:', e.message);
    return { success: false, message: t(lang, 'common_server_error') };
  } finally {
    client.release();
  }
}

/** ইউজারের সাম্প্রতিক স্পিন ইতিহাস — routes/profile.js-এর GET /wheel পেজ এটা দেখায়। */
async function getHistory(userId, limit = 10) {
  const res = await pool.query(
    `SELECT id, spin_date, prize, created_at FROM wheel_spins WHERE user_id = $1 ORDER BY spin_date DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

/**
 * আজকের স্পিনের সার্ভার-রেকর্ডেড ফলাফল পড়ে (রিড-অনলি)।
 *
 * কেন দরকার: POST /wheel/spin আগে রেসপন্সেই prize ও জয়ের বার্তা পাঠিয়ে দিত, অথচ
 * হুইলের অ্যানিমেশন চলত আরও ৪ সেকেন্ড। ফলে ইউজার হুইল থামার আগেই নেটওয়ার্ক রেসপন্সে
 * পুরস্কারটা দেখে ফেলতে পারত। এখন স্পিন রেসপন্সে শুধু কোন ঘরে থামবে সেই index যায়,
 * আর অ্যানিমেশন শেষ হওয়ার পর ফ্রন্টএন্ড এই ফাংশনের মাধ্যমে সার্ভার-নিশ্চিত ফলাফল আনে।
 *
 * এটা কোনো পুরস্কার হিসাব করে না — spin() যা ইতিমধ্যে wheel_spins-এ লিখে ফেলেছে
 * শুধু সেটাই ফেরত দেয়। পুরস্কার নির্বাচন, ওয়ালেট ক্রেডিট ও নোটিফিকেশন অপরিবর্তিত।
 */
async function getTodayResult(userId, lang = 'bn') {
  const r = await pool.query(
    `SELECT prize FROM wheel_spins WHERE user_id = $1 AND spin_date = $2`,
    [userId, today()]
  );
  if (!r.rows[0]) return null;
  const prize = Number(r.rows[0].prize);
  return {
    prize,
    message: prize > 0 ? t(lang, 'reward_coins_won').replace('{value}', prize) : t(lang, 'wheel_no_prize')
  };
}

module.exports = { getSegments, canSpin, spin, getHistory, getTodayResult };
