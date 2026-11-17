// Referral V2 টেস্ট-হেল্পার: সত্যিকারের Postgres-এ ইউজার, রেফারেল ও payment_requests ডিপোজিট বানায়।
const { pool } = require('../../db');
const { uniquePhone } = require('./app');

let seq = 0;
function uniq() { return `${Date.now()}_${process.pid}_${++seq}_${Math.random().toString(36).slice(2, 7)}`; }

async function makeUser(prefix = 'u', { phone, coins = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`${prefix}_${uniq()}`, phone || uniquePhone(), coins]
  );
  return r.rows[0].id;
}

async function link(referrerId, referredId) {
  await pool.query(
    `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT (referred_id) DO NOTHING`,
    [referrerId, referredId]
  );
}

// status: 'pending' (অনুমোদনের অপেক্ষায়) বা 'approved' (ইতিমধ্যে নিশ্চিত — ইঞ্জিন সরাসরি চালানোর জন্য)
async function makeDeposit(userId, amount, { status = 'pending', wantBonus = false, account } = {}) {
  const r = await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status, want_bonus)
     VALUES ($1, 'deposit', 'bkash', $2, $3, $4, $5, $6) RETURNING id`,
    [userId, amount, `TRX${uniq()}`, account || `acct_${uniq()}`, status, wantBonus]
  );
  return r.rows[0].id;
}

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

async function reward(referredId) {
  const r = await pool.query('SELECT * FROM referral_rewards WHERE referred_user_id = $1', [referredId]);
  return r.rows[0] || null;
}

// users-এ FK রাখা সব টেবিল ডাইনামিকভাবে সাফ করে (হাতে তালিকা রাখলে অসম্পূর্ণ cleanup অন্য সুটকে ফ্লেক করায়)
async function cleanup(ids) {
  const t = await pool.query(`
    SELECT DISTINCT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'users' AND ccu.column_name = 'id'`);
  // referral_reward_adjustments আগে (referral_rewards-এর FK)
  await pool.query(`DELETE FROM referral_reward_adjustments WHERE reward_id IN
    (SELECT id FROM referral_rewards WHERE referrer_id = ANY($1::int[]) OR referred_user_id = ANY($1::int[]))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM referral_rewards WHERE referrer_id = ANY($1::int[]) OR referred_user_id = ANY($1::int[])`, [ids]).catch(() => {});
  for (const id of ids) {
    for (const { table_name, column_name } of t.rows) {
      await pool.query(`DELETE FROM ${table_name} WHERE ${column_name} = $1`, [id]).catch(() => {});
    }
  }
  for (const id of ids) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

module.exports = { makeUser, link, makeDeposit, coins, reward, cleanup, uniq };

// ইঞ্জিন সরাসরি চালানোর শর্টকাট: approved ডিপোজিট বানিয়ে ইঞ্জিন ডাকে (পুরোনো processReferralDeposit-এর প্রতিস্থাপন)।
async function runEngine(referredId, amount, opts = {}) {
  const engine = require('../../services/referralRewards');
  const depositId = await makeDeposit(referredId, amount, { status: 'approved', ...opts });
  return engine.processReferralReward(referredId, depositId);
}
module.exports.runEngine = runEngine;
