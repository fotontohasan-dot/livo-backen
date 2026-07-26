// services/vip.js
// VIP লেভেল সিস্টেম — মোট লাইফটাইম টার্নওভার (বাজি) অনুযায়ী লেভেল।
// বাজি ধরলে total_turnover বাড়ে; নতুন লেভেলে পৌঁছালে আপগ্রেড বোনাস।
//
// ==================== প্রিমিয়াম VIP আপগ্রেড (নতুন, additive) ====================
// এই ফাইলে আগের addVipTurnover() ও getVipStatus() অক্ষত রাখা হয়েছে (কোনো ফিচার ভাঙেনি)।
// নিচে নতুন যোগ হয়েছে: Daily/Weekly/Monthly VIP বোনাস ক্লেইম, VIP লেভেল-ভিত্তিক বেনিফিটস,
// Reward/Upgrade History এবং অ্যাডমিন ম্যানেজমেন্ট + অ্যানালিটিক্স হেল্পার।

const { pool } = require('../db');

let notifyService = null;
function getNotify() {
  // lazy require — circular dependency এড়াতে (notify.js কোথাও vip.js ইমপোর্ট করে না,
  // কিন্তু ভবিষ্যতে নিরাপদ থাকার জন্য lazy রাখা হলো)
  if (!notifyService) {
    try { notifyService = require('./notify'); } catch (e) { notifyService = {}; }
  }
  return notifyService;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function weekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ভবিষ্যতে চাইলে VIP লেভেল ধরে রাখার শর্ত (Protection Rule) এখানে যোগ করা যাবে —
// এখন ডিফল্ট নীতি: VIP লেভেল কখনো নিজে থেকে কমে না (lifetime turnover-ভিত্তিক), শুধু বাড়ে।
// এটাই আগের সিস্টেমের আচরণ, তাই backward compatible রাখা হলো।
async function getUserLevelRow(userId) {
  const u = await pool.query(`SELECT vip_level FROM users WHERE id = $1`, [userId]);
  const level = u.rows[0] ? (u.rows[0].vip_level || 0) : 0;
  const lvl = await pool.query(`SELECT * FROM vip_levels WHERE level = $1`, [level]);
  return lvl.rows[0] || null;
}

// একটা VIP রিওয়ার্ড ইউজারকে দেওয়া + coin_transactions + vip_reward_history + notification,
// একই ট্রানজেকশনে (atomic) — সব ক্লেইম ফাংশন এই একটাই হেল্পার ব্যবহার করে (duplicate code এড়াতে)।
async function grantVipReward(client, { userId, level, rewardType, amount, description, notifyTitle }) {
  if (amount > 0) {
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [amount, userId]);
  }
  await client.query(
    `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)`,
    [userId, amount, `vip_${rewardType}`, description]
  );
  await client.query(
    `INSERT INTO vip_reward_history (user_id, vip_level, reward_type, amount, description) VALUES ($1, $2, $3, $4, $5)`,
    [userId, level, rewardType, amount, description]
  );
  const notifRes = await client.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'success') RETURNING *`,
    [userId, notifyTitle || 'VIP রিওয়ার্ড!', description]
  );
  return notifRes.rows[0];
}

// ==================== বাজিতে টার্নওভার যোগ + লেভেল চেক ====================
// গেম/স্পোর্টস বাজির পর ডাকা হবে।
// নিরাপত্তা নোট: পুরো সিকোয়েন্স (টার্নওভার আপডেট → লেভেল চেক → আপগ্রেড বোনাস) এখন
// একটা single DB transaction-এ চলে। প্রথম UPDATE-টাই ইউজারের row-এ লক ধরে রাখে
// (COMMIT পর্যন্ত), তাই একই ইউজারের জন্য একসাথে আসা একাধিক addVipTurnover() কল
// সিরিয়ালাইজড হয়ে যায় — কেউ দুইবার একই আপগ্রেড বোনাস পাবে না (Race Condition/Duplicate-Bonus প্রতিরোধ)।
async function addVipTurnover(userId, amount) {
  if (!amount || amount <= 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // মোট টার্নওভার বাড়াও — এই UPDATE-ই row-level lock নেয়, transaction শেষ না হওয়া পর্যন্ত
    const upd = await client.query(
      `UPDATE users SET total_turnover = COALESCE(total_turnover,0) + $1 WHERE id = $2 RETURNING total_turnover, vip_level`,
      [amount, userId]
    );
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return; }

    const totalTurnover = Number(upd.rows[0].total_turnover);
    const currentLevel = upd.rows[0].vip_level || 0;

    // এই টার্নওভারে সর্বোচ্চ কোন লেভেল প্রাপ্য?
    const lvlRes = await client.query(
      `SELECT * FROM vip_levels WHERE min_turnover <= $1 AND is_active = true ORDER BY level DESC LIMIT 1`,
      [totalTurnover]
    );
    if (lvlRes.rows.length === 0) { await client.query('COMMIT'); return; }

    const newLevel = lvlRes.rows[0].level;

    // লেভেল বেড়েছে? — আপগ্রেড বোনাস
    if (newLevel > currentLevel) {
      const bonus = lvlRes.rows[0].upgrade_bonus || 0;
      const name = lvlRes.rows[0].name;

      // idempotency guard: WHERE-এ পুরনো vip_level মিলিয়ে conditional update —
      // (ট্রানজেকশন লক ছাড়াও) ডাবল-চেক হিসেবে defense-in-depth
      const levelUpd = await client.query(
        `UPDATE users SET vip_level = $1 WHERE id = $2 AND vip_level = $3`,
        [newLevel, userId, currentLevel]
      );
      if (levelUpd.rowCount === 0) {
        // অন্য কোনো concurrent কল ইতিমধ্যে আপগ্রেড করে ফেলেছে — বোনাস আর দ্বিতীয়বার দেওয়া হবে না
        await client.query('COMMIT');
        return;
      }

      if (bonus > 0) {
        await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonus, userId]);
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description)
           VALUES ($1, $2, 'vip_upgrade', $3)`,
          [userId, bonus, `VIP ${name} আপগ্রেড বোনাস`]
        );
      }
      const notifRow = (await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'VIP আপগ্রেড!', $2, 'success') RETURNING *`,
        [userId, `অভিনন্দন! আপনি VIP ${name} (লেভেল ${newLevel}) হয়েছেন।${bonus > 0 ? ' বোনাস: ' + bonus + ' কয়েন।' : ''}`]
      )).rows[0];

      await client.query(
        `INSERT INTO vip_upgrade_history (user_id, from_level, to_level, bonus, total_turnover_at_upgrade)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, currentLevel, newLevel, bonus, totalTurnover]
      );
      if (bonus > 0) {
        await client.query(
          `INSERT INTO vip_reward_history (user_id, vip_level, reward_type, amount, description)
           VALUES ($1, $2, 'upgrade_bonus', $3, $4)`,
          [userId, newLevel, bonus, `VIP ${name} আপগ্রেড বোনাস`]
        );
      }

      await client.query('COMMIT');

      try {
        const { logEvent: logAuditEvent } = require('./auditLog');
        await logAuditEvent({
          actorType: 'system', actorId: userId,
          action: 'VIP_AUTO_UPGRADE', category: 'financial', riskLevel: 'low',
          details: { userId, fromLevel: currentLevel, toLevel: newLevel, bonus, totalTurnover }
        });
      } catch (auditErr) {
        console.error('vip upgrade audit log error (non-blocking):', auditErr.message);
      }

      if (notifRow) { const n = getNotify(); if (n.emitToUser) n.emitToUser(userId, notifRow); }
    } else {
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('addVipTurnover error:', e.message);
  } finally {
    client.release();
  }
}

/**
 * ==================== ডিপোজিট বোনাস (VIP Deposit Bonus) ====================
 * সফল (approved) ডিপোজিটের পর ইউজারের বর্তমান VIP লেভেল অনুযায়ী deposit_bonus_percent
 * প্রয়োগ করে। routes/payment.js-এর creditApprovedDeposit()-এর ভেতর থেকে, deposit approve-এর
 * SAME transaction-এর client দিয়ে কল করা হয় (SAVEPOINT-এ wrap করা, ব্যর্থ হলেও মূল ডিপোজিট আটকাবে না)।
 * Server-side-only হিসেবে ডিজাইন করা — ক্লায়েন্ট থেকে percent/amount কিছুই পাঠানো হয় না,
 * সম্পূর্ণটাই vip_levels টেবিল থেকে DB-সাইডে গণনা হয়।
 */
async function applyVipDepositBonus(client, userId, depositAmount) {
  if (!depositAmount || depositAmount <= 0) return 0;

  const userRes = await client.query(`SELECT vip_level FROM users WHERE id = $1`, [userId]);
  if (!userRes.rows[0]) return 0;
  const level = userRes.rows[0].vip_level || 0;

  const lvlRes = await client.query(`SELECT * FROM vip_levels WHERE level = $1 AND is_active = true`, [level]);
  const lvl = lvlRes.rows[0];
  if (!lvl || !lvl.deposit_bonus_percent || lvl.deposit_bonus_percent <= 0) return 0;

  const bonus = Math.floor((Number(depositAmount) * Number(lvl.deposit_bonus_percent)) / 100);
  if (bonus <= 0) return 0;

  await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonus, userId]);
  await client.query(
    `INSERT INTO coin_transactions (user_id, amount, type, description)
     VALUES ($1, $2, 'vip_deposit_bonus', $3)`,
    [userId, bonus, `VIP ${lvl.name} ডিপোজিট বোনাস (${lvl.deposit_bonus_percent}%)`]
  );
  await client.query(
    `INSERT INTO vip_reward_history (user_id, vip_level, reward_type, amount, description)
     VALUES ($1, $2, 'deposit_bonus', $3, $4)`,
    [userId, level, bonus, `৳${depositAmount} ডিপোজিটে ${lvl.deposit_bonus_percent}% VIP বোনাস`]
  );

  try {
    const { logEvent: logAuditEvent } = require('./auditLog');
    await logAuditEvent({
      actorType: 'system', actorId: userId,
      action: 'VIP_DEPOSIT_BONUS', category: 'financial', riskLevel: 'low',
      details: { userId, level, depositAmount, bonus, percent: lvl.deposit_bonus_percent }
    });
  } catch (auditErr) {
    console.error('vip deposit-bonus audit log error (non-blocking):', auditErr.message);
  }

  return bonus;
}

// ==================== VIP স্ট্যাটাস দেখা ====================
async function getVipStatus(userId) {
  const u = await pool.query(
    `SELECT total_turnover, vip_level FROM users WHERE id = $1`,
    [userId]
  );
  const totalTurnover = u.rows[0] ? Number(u.rows[0].total_turnover) : 0;
  const level = u.rows[0] ? (u.rows[0].vip_level || 0) : 0;

  const levels = (await pool.query(`SELECT * FROM vip_levels ORDER BY level ASC`)).rows;

  const current = levels.find(l => l.level === level) || levels[0];
  const next = levels.find(l => l.level === level + 1) || null;

  let progress = 1000;
  let toNext = 0;
  if (next) {
    const span = Number(next.min_turnover) - Number(current.min_turnover);
    const done = totalTurnover - Number(current.min_turnover);
    // Scale progress to 1000 instead of 100 as requested
    progress = span > 0 ? Math.min(1000, Math.floor((done / span) * 1000)) : 0;
    toNext = Math.max(0, Number(next.min_turnover) - totalTurnover);
  }

  return { totalTurnover, level, current, next, progress, toNext, levels };
}

// ==================== Daily VIP Bonus Claim ====================
async function getDailyBonusStatus(userId) {
  const lvl = await getUserLevelRow(userId);
  const amount = lvl ? Number(lvl.daily_bonus || 0) : 0;
  const claimed = await pool.query(
    `SELECT id FROM daily_rewards WHERE user_id = $1 AND reward_type = 'vip_daily' AND claim_date = $2`,
    [userId, today()]
  );
  return {
    level: lvl ? lvl.level : 0,
    levelName: lvl ? lvl.name : null,
    amount,
    claimed: claimed.rows.length > 0,
    available: amount > 0 && claimed.rows.length === 0
  };
}

async function claimDailyBonus(userId) {
  const status = await getDailyBonusStatus(userId);
  if (status.claimed) return { success: false, message: 'আজকের VIP দৈনিক বোনাস আগেই নেওয়া হয়েছে।' };
  if (!status.available) return { success: false, message: 'আপনার লেভেলে দৈনিক বোনাস নেই।' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id FROM daily_rewards WHERE user_id = $1 AND reward_type = 'vip_daily' AND claim_date = $2 FOR UPDATE`,
      [userId, today()]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: 'আজকের VIP দৈনিক বোনাস আগেই নেওয়া হয়েছে।' };
    }
    await client.query(
      `INSERT INTO daily_rewards (user_id, reward_type, amount, claim_date) VALUES ($1, 'vip_daily', $2, $3)`,
      [userId, status.amount, today()]
    );
    const notifRow = await grantVipReward(client, {
      userId, level: status.level, rewardType: 'daily_bonus', amount: status.amount,
      description: `VIP দৈনিক বোনাস (${status.levelName}) — ${status.amount} কয়েন`,
      notifyTitle: 'VIP দৈনিক বোনাস পেয়েছেন!'
    });
    await client.query('COMMIT');
    const n = getNotify(); if (n.emitToUser && notifRow) n.emitToUser(userId, notifRow);
    return { success: true, amount: status.amount, message: `${status.amount} কয়েন দৈনিক VIP বোনাস পেয়েছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimDailyBonus error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

// ==================== Weekly VIP Reward (লেভেল-ভিত্তিক ফ্ল্যাট বোনাস; নিট-লস ভিত্তিক
// সাধারণ সাপ্তাহিক ক্যাশব্যাক থেকে আলাদা — services/periodicReward.js অপরিবর্তিত থাকছে) ====================
async function getWeeklyVipStatus(userId) {
  const lvl = await getUserLevelRow(userId);
  const amount = lvl ? Number(lvl.weekly_bonus || 0) : 0;
  const wk = weekKey();
  const claimed = await pool.query(
    `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'vip_weekly' AND period_key = $2`,
    [userId, wk]
  );
  return {
    level: lvl ? lvl.level : 0,
    levelName: lvl ? lvl.name : null,
    amount, weekKey: wk,
    claimed: claimed.rows.length > 0,
    available: amount > 0 && claimed.rows.length === 0
  };
}

async function claimWeeklyVipReward(userId) {
  const status = await getWeeklyVipStatus(userId);
  if (status.claimed) return { success: false, message: 'এই সপ্তাহের VIP রিওয়ার্ড আগেই নেওয়া হয়েছে।' };
  if (!status.available) return { success: false, message: 'আপনার লেভেলে সাপ্তাহিক VIP রিওয়ার্ড নেই।' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'vip_weekly' AND period_key = $2 FOR UPDATE`,
      [userId, status.weekKey]
    );
    if (dup.rows.length > 0) { await client.query('ROLLBACK'); return { success: false, message: 'এই সপ্তাহের VIP রিওয়ার্ড আগেই নেওয়া হয়েছে।' }; }
    await client.query(
      `INSERT INTO periodic_claims (user_id, claim_type, period_key, amount) VALUES ($1, 'vip_weekly', $2, $3)`,
      [userId, status.weekKey, status.amount]
    );
    const notifRow = await grantVipReward(client, {
      userId, level: status.level, rewardType: 'weekly_bonus', amount: status.amount,
      description: `সাপ্তাহিক VIP রিওয়ার্ড (${status.levelName}) — ${status.amount} কয়েন`,
      notifyTitle: 'সাপ্তাহিক VIP রিওয়ার্ড পেয়েছেন!'
    });
    await client.query('COMMIT');
    const n = getNotify(); if (n.emitToUser && notifRow) n.emitToUser(userId, notifRow);
    return { success: true, amount: status.amount, message: `${status.amount} কয়েন সাপ্তাহিক VIP রিওয়ার্ড পেয়েছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimWeeklyVipReward error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

// ==================== Monthly VIP Reward ====================
async function getMonthlyVipStatus(userId) {
  const lvl = await getUserLevelRow(userId);
  const amount = lvl ? Number(lvl.monthly_bonus || 0) : 0;
  const mk = monthKey();
  const claimed = await pool.query(
    `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'vip_monthly' AND period_key = $2`,
    [userId, mk]
  );
  return {
    level: lvl ? lvl.level : 0,
    levelName: lvl ? lvl.name : null,
    amount, monthKey: mk,
    claimed: claimed.rows.length > 0,
    available: amount > 0 && claimed.rows.length === 0
  };
}

async function claimMonthlyVipReward(userId) {
  const status = await getMonthlyVipStatus(userId);
  if (status.claimed) return { success: false, message: 'এই মাসের VIP রিওয়ার্ড আগেই নেওয়া হয়েছে।' };
  if (!status.available) return { success: false, message: 'আপনার লেভেলে মাসিক VIP রিওয়ার্ড নেই।' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'vip_monthly' AND period_key = $2 FOR UPDATE`,
      [userId, status.monthKey]
    );
    if (dup.rows.length > 0) { await client.query('ROLLBACK'); return { success: false, message: 'এই মাসের VIP রিওয়ার্ড আগেই নেওয়া হয়েছে।' }; }
    await client.query(
      `INSERT INTO periodic_claims (user_id, claim_type, period_key, amount) VALUES ($1, 'vip_monthly', $2, $3)`,
      [userId, status.monthKey, status.amount]
    );
    const notifRow = await grantVipReward(client, {
      userId, level: status.level, rewardType: 'monthly_bonus', amount: status.amount,
      description: `মাসিক VIP রিওয়ার্ড (${status.levelName}) — ${status.amount} কয়েন`,
      notifyTitle: 'মাসিক VIP রিওয়ার্ড পেয়েছেন!'
    });
    await client.query('COMMIT');
    const n = getNotify(); if (n.emitToUser && notifRow) n.emitToUser(userId, notifRow);
    return { success: true, amount: status.amount, message: `${status.amount} কয়েন মাসিক VIP রিওয়ার্ড পেয়েছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimMonthlyVipReward error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

// ==================== VIP লেভেল-ভিত্তিক বেনিফিটস (Benefits Page) ====================
async function getVipBenefits(level) {
  const r = await pool.query(`SELECT * FROM vip_levels WHERE level = $1`, [level]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    level: row.level,
    name: row.name,
    icon: row.icon || '👑',
    minTurnover: Number(row.min_turnover),
    upgradeBonus: Number(row.upgrade_bonus || 0),
    dailyBonus: Number(row.daily_bonus || 0),
    weeklyBonus: Number(row.weekly_bonus || 0),
    monthlyBonus: Number(row.monthly_bonus || 0),
    cashbackPercent: Number(row.cashback_percent || 0),
    withdrawalLimit: Number(row.withdrawal_limit || 0), // 0 = সীমাহীন
    depositBonusPercent: Number(row.deposit_bonus_percent || 0),
    birthdayBonus: Number(row.birthday_bonus || 0),
    prioritySupport: !!row.priority_support,
    exclusiveEvents: row.exclusive_events || '',
    isActive: row.is_active !== false
  };
}

async function getAllVipBenefits() {
  const r = await pool.query(`SELECT level FROM vip_levels ORDER BY level ASC`);
  const out = [];
  for (const row of r.rows) out.push(await getVipBenefits(row.level));
  return out;
}

// ==================== Reward / Claim / Upgrade History (ইউজারের জন্য) ====================
async function getRewardHistory(userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const countRes = await pool.query(`SELECT COUNT(*) FROM vip_reward_history WHERE user_id = $1`, [userId]);
  const total = parseInt(countRes.rows[0].count, 10);
  const rowsRes = await pool.query(
    `SELECT * FROM vip_reward_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function getUpgradeHistory(userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const countRes = await pool.query(`SELECT COUNT(*) FROM vip_upgrade_history WHERE user_id = $1`, [userId]);
  const total = parseInt(countRes.rows[0].count, 10);
  const rowsRes = await pool.query(
    `SELECT * FROM vip_upgrade_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// ==================== Admin: VIP Level Management ====================
async function listVipLevelsAdmin() {
  return (await pool.query(`SELECT * FROM vip_levels ORDER BY level ASC`)).rows;
}

async function upsertVipLevel(data) {
  const level = parseInt(data.level, 10);
  if (!Number.isFinite(level) || level < 0) throw new Error('অবৈধ VIP লেভেল নম্বর');

  const name = String(data.name || '').trim().slice(0, 40) || `Level ${level}`;
  const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; };

  const existing = await pool.query(`SELECT id FROM vip_levels WHERE level = $1`, [level]);
  const fields = {
    name,
    min_turnover: num(data.min_turnover),
    upgrade_bonus: num(data.upgrade_bonus),
    daily_bonus: num(data.daily_bonus),
    weekly_bonus: num(data.weekly_bonus),
    monthly_bonus: num(data.monthly_bonus),
    cashback_percent: num(data.cashback_percent),
    withdrawal_limit: num(data.withdrawal_limit),
    deposit_bonus_percent: num(data.deposit_bonus_percent),
    birthday_bonus: num(data.birthday_bonus),
    priority_support: !!data.priority_support,
    exclusive_events: String(data.exclusive_events || '').slice(0, 500),
    icon: String(data.icon || '👑').slice(0, 10),
    is_active: data.is_active === undefined ? true : !!data.is_active
  };

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE vip_levels SET name=$1, min_turnover=$2, upgrade_bonus=$3, daily_bonus=$4, weekly_bonus=$5,
        monthly_bonus=$6, cashback_percent=$7, withdrawal_limit=$8, deposit_bonus_percent=$9, birthday_bonus=$10,
        priority_support=$11, exclusive_events=$12, icon=$13, is_active=$14, updated_at=NOW()
       WHERE level = $15`,
      [fields.name, fields.min_turnover, fields.upgrade_bonus, fields.daily_bonus, fields.weekly_bonus,
       fields.monthly_bonus, fields.cashback_percent, fields.withdrawal_limit, fields.deposit_bonus_percent,
       fields.birthday_bonus, fields.priority_support, fields.exclusive_events, fields.icon, fields.is_active, level]
    );
    return { created: false, level };
  } else {
    await pool.query(
      `INSERT INTO vip_levels (level, name, min_turnover, upgrade_bonus, daily_bonus, weekly_bonus, monthly_bonus,
        cashback_percent, withdrawal_limit, deposit_bonus_percent, birthday_bonus, priority_support, exclusive_events, icon, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [level, fields.name, fields.min_turnover, fields.upgrade_bonus, fields.daily_bonus, fields.weekly_bonus,
       fields.monthly_bonus, fields.cashback_percent, fields.withdrawal_limit, fields.deposit_bonus_percent,
       fields.birthday_bonus, fields.priority_support, fields.exclusive_events, fields.icon, fields.is_active]
    );
    return { created: true, level };
  }
}

async function toggleVipLevelActive(level, isActive) {
  await pool.query(`UPDATE vip_levels SET is_active = $1, updated_at = NOW() WHERE level = $2`, [!!isActive, level]);
}

// ==================== Admin: VIP Analytics Dashboard ====================
async function getVipAnalytics() {
  const perLevel = await pool.query(`
    SELECT vl.level, vl.name, vl.icon, vl.is_active,
      COUNT(u.id) AS user_count,
      COALESCE(SUM(u.total_turnover), 0) AS total_turnover
    FROM vip_levels vl
    LEFT JOIN users u ON u.vip_level = vl.level
    GROUP BY vl.level, vl.name, vl.icon, vl.is_active
    ORDER BY vl.level ASC
  `);

  const bonusByLevel = await pool.query(`
    SELECT vip_level AS level,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'upgrade_bonus'), 0) AS total_upgrade_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'daily_bonus'), 0) AS total_daily_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'weekly_bonus'), 0) AS total_weekly_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'monthly_bonus'), 0) AS total_monthly_bonus,
      COALESCE(SUM(amount) FILTER (WHERE reward_type = 'cashback'), 0) AS total_cashback,
      COALESCE(SUM(amount), 0) AS total_all
    FROM vip_reward_history
    GROUP BY vip_level
  `);
  const bonusMap = {};
  bonusByLevel.rows.forEach(r => { bonusMap[r.level] = r; });

  const upgradeStats = await pool.query(`
    SELECT to_level, COUNT(*) AS upgrade_count, COALESCE(SUM(bonus),0) AS total_bonus_paid
    FROM vip_upgrade_history GROUP BY to_level ORDER BY to_level ASC
  `);

  const totals = await pool.query(`
    SELECT COALESCE(SUM(amount),0) AS grand_total_bonus FROM vip_reward_history
  `);

  return {
    perLevel: perLevel.rows.map(r => ({
      level: r.level, name: r.name, icon: r.icon, isActive: r.is_active,
      userCount: parseInt(r.user_count, 10),
      totalTurnover: Number(r.total_turnover),
      totalUpgradeBonus: Number(bonusMap[r.level]?.total_upgrade_bonus || 0),
      totalDailyBonus: Number(bonusMap[r.level]?.total_daily_bonus || 0),
      totalWeeklyBonus: Number(bonusMap[r.level]?.total_weekly_bonus || 0),
      totalMonthlyBonus: Number(bonusMap[r.level]?.total_monthly_bonus || 0),
      totalCashback: Number(bonusMap[r.level]?.total_cashback || 0),
      totalAll: Number(bonusMap[r.level]?.total_all || 0)
    })),
    upgradeStats: upgradeStats.rows.map(r => ({
      toLevel: r.to_level, upgradeCount: parseInt(r.upgrade_count, 10), totalBonusPaid: Number(r.total_bonus_paid)
    })),
    grandTotalBonus: Number(totals.rows[0].grand_total_bonus)
  };
}

// ==================== Admin: সব ইউজারের VIP রিওয়ার্ড/আপগ্রেড হিস্ট্রি (audit view) ====================
async function listAllRewardHistory({ page = 1, limit = 50, rewardType = null } = {}) {
  const params = [];
  let where = '';
  if (rewardType) { params.push(rewardType); where = `WHERE h.reward_type = $${params.length}`; }
  const offset = (page - 1) * limit;
  const countRes = await pool.query(`SELECT COUNT(*) FROM vip_reward_history h ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);
  const listParams = [...params, limit, offset];
  const rowsRes = await pool.query(
    `SELECT h.*, u.username FROM vip_reward_history h LEFT JOIN users u ON u.id = h.user_id ${where}
     ORDER BY h.created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function listAllUpgradeHistory({ page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;
  const countRes = await pool.query(`SELECT COUNT(*) FROM vip_upgrade_history`);
  const total = parseInt(countRes.rows[0].count, 10);
  const rowsRes = await pool.query(
    `SELECT h.*, u.username FROM vip_upgrade_history h LEFT JOIN users u ON u.id = h.user_id
     ORDER BY h.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return { rows: rowsRes.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = {
  // বিদ্যমান (অপরিবর্তিত)
  addVipTurnover, getVipStatus,
  // নতুন — VIP Deposit Bonus (স্বয়ংক্রিয়, সার্ভার-সাইড)
  applyVipDepositBonus,
  // Daily/Weekly/Monthly VIP বোনাস
  getDailyBonusStatus, claimDailyBonus,
  getWeeklyVipStatus, claimWeeklyVipReward,
  getMonthlyVipStatus, claimMonthlyVipReward,
  // বেনিফিটস + হিস্ট্রি
  getVipBenefits, getAllVipBenefits,
  getRewardHistory, getUpgradeHistory,
  // অ্যাডমিন
  listVipLevelsAdmin, upsertVipLevel, toggleVipLevelActive,
  getVipAnalytics, listAllRewardHistory, listAllUpgradeHistory,
  getUserLevelRow
};
