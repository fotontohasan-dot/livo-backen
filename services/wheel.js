// services/wheel.js
// লাকি হুইল — দিনে একবার ঘুরিয়ে পুরস্কার (কয়েন)।
// পুরস্কারগুলো নির্দিষ্ট, সার্ভারেই র‍্যান্ডম নির্বাচন (ক্লায়েন্ট ঠকাতে পারবে না)।

const { pool } = require('../db');

// হুইলের ঘর (পুরস্কার) — weight যত বেশি, আসার সম্ভাবনা তত বেশি
const SEGMENTS = [
  { prize: 5,    weight: 30 },
  { prize: 10,   weight: 25 },
  { prize: 20,   weight: 18 },
  { prize: 50,   weight: 12 },
  { prize: 100,  weight: 8 },
  { prize: 200,  weight: 4 },
  { prize: 500,  weight: 2 },
  { prize: 1000, weight: 1 }
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

// সব সম্ভাব্য পুরস্কার (ফ্রন্টএন্ডে হুইল আঁকতে)
function getSegments() {
  return SEGMENTS.map(s => s.prize);
}

// আজ স্পিন করা হয়েছে কিনা
async function canSpin(userId) {
  const r = await pool.query(
    `SELECT * FROM wheel_spins WHERE user_id = $1 AND spin_date = $2`,
    [userId, today()]
  );
  if (r.rows[0]) {
    return { canSpin: false, prize: r.rows[0].prize };
  }
  return { canSpin: true, prize: null };
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

    // পুরস্কার নির্বাচন
    const prize = pickPrize();

    // রেকর্ড + কয়েন
    await client.query(
      `INSERT INTO wheel_spins (user_id, spin_date, prize) VALUES ($1, $2, $3)`,
      [userId, today(), prize]
    );
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

    await client.query('COMMIT');

    // ফ্রন্টএন্ডে কোন ঘরে থামবে তার ইনডেক্স
    const index = SEGMENTS.findIndex(s => s.prize === prize);
    return { success: true, prize, index, message: `${prize} কয়েন জিতেছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('wheel spin error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

async function getHistory(userId) {
  try {
    const res = await pool.query(
      `SELECT prize, TO_CHAR(spin_date, 'YYYY-MM-DD') as spin_date
       FROM wheel_spins
       WHERE user_id = $1
       ORDER BY spin_date DESC LIMIT 10`,
      [userId]
    );
    return res.rows;
  } catch (e) {
    console.error('getHistory error:', e.message);
    return [];
  }
}

module.exports = { getSegments, canSpin, spin, getHistory };
