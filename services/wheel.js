// services/wheel.js
// লাকি হুইল — দিনে একবার ঘুরিয়ে পুরস্কার (কয়েন)।
// পুরস্কারগুলো নির্দিষ্ট, সার্ভারেই র‍্যান্ডম নির্বাচন (ক্লায়েন্ট ঠকাতে পারবে না)।

const { pool } = require('../db');

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
  let rnd = Math.random() * total;
  for (const seg of SEGMENTS) {
    if (rnd < seg.weight) return seg.prize;
    rnd -= seg.weight;
  }
  return SEGMENTS[0].prize;
}

// স্পিন করা (দিনে একবার, transaction সহ)
async function spin(userId) {
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
      return { success: false, message: 'আজ আপনি আগেই স্পিন করেছেন। আগামীকাল আবার আসুন।' };
    }

    // লক চেক: আজ ডিপোজিট বা গেম/বেট খেলা না থাকলে স্পিন করা যাবে না
    const qualifies = await hasQualifyingActivityToday(userId);
    if (!qualifies) {
      await client.query('ROLLBACK');
      return { success: false, message: 'হুইল লক করা আছে। আজ ডিপোজিট করুন, তারপর স্পিন করতে পারবেন।' };
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
    const message = prize > 0 ? `${prize} কয়েন জিতেছেন!` : 'এবার কিছু পাননি। আগামীকাল আবার চেষ্টা করুন!';
    return { success: true, prize, index, message };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('wheel spin error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

module.exports = { getSegments, canSpin, spin };
