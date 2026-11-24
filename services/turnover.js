// services/turnover.js
// Turnover System V2 — একমাত্র সক্রিয় টার্নওভার সিস্টেম।
//
// নিয়ম:
//   • বোনাস নিলে   : required = (Deposit + Bonus) × multiplier   (admin: turnover_multiplier)
//   • বোনাস না নিলে : required = Deposit × 1                      (admin: turnover_no_bonus_multiplier)
//   • প্রতিটি Deposit-এর টার্নওভার আলাদা সারিতে (deposit_turnovers), পুরোনোটা আগে পূরণ হয় (FIFO)।
//   • যোগ্য Casino/Sports বেটের অঙ্ক জিতুক-হারুক গোনা হয় (Sports: সেটেলমেন্টের পর)।
//   • Void/Cancelled/Refund এবং (ডিফল্টে) Cash-out গোনা হয় না; Sports-এ min odds প্রযোজ্য।
//   • টার্নওভার ১০০% হলে ওই Deposit-এর লক নিজে থেকে খোলে (status = 'completed')।
//   • পুরোনো `bonuses` টেবিল শুধু আর্কাইভ — এই ফাইল সেটা আর পড়ে/লেখে না।
//   • একই বেট দুবার গোনা ঠেকাতে turnover_events(user_id, ref) UNIQUE।

const { pool } = require('../db');
const { getSetting } = require('./settings');

const DEFAULTS = {
  multiplier: 5,        // বোনাস সহ — admin: turnover_multiplier
  noBonusMultiplier: 1, // বোনাস ছাড়া — admin: turnover_no_bonus_multiplier
  minOdds: 1.5,         // Sports ন্যূনতম odds — admin: turnover_min_odds (0 = বন্ধ)
  expiryHours: 0,       // 0 = মেয়াদ নেই — admin: turnover_expiry_hours
  cashoutCounts: false  // admin: turnover_cashout_counts ('1' হলে Cash-out গোনা হবে)
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const CONFIG_KEYS = ['turnover_multiplier', 'turnover_no_bonus_multiplier', 'turnover_min_odds', 'turnover_expiry_hours', 'turnover_cashout_counts'];

// db = কলারের খোলা transaction client (থাকলে)। কলার আগে থেকেই একটা pool কানেকশন ধরে রেখেছে; এই অবস্থায়
// getSetting() ক্যাশ-মিসে pool থেকে আরেকটা কানেকশন চায়। একসাথে অনেক settlement চললে সব কানেকশন
// ধরা থাকে, settings-এর কানেকশন আর পাওয়া যায় না → পরস্পরের অপেক্ষায় আটকে (timeout)। তাই client থাকলে
// সেটা দিয়েই পড়ি; কোনো কী না পেলে (বা client না থাকলে) আগের মতো getSetting()।
async function readConfigValues(db) {
  const values = {};
  if (db && typeof db.query === 'function') {
    try {
      const r = await db.query('SELECT key, value FROM site_settings WHERE key = ANY($1::text[])', [CONFIG_KEYS]);
      for (const row of (r && r.rows) || []) values[row.key] = row.value;
    } catch (_) { /* নিচে getSetting() ফলব্যাক */ }
  }
  const missing = CONFIG_KEYS.filter((k) => values[k] === undefined);
  const fetched = await Promise.all(missing.map((k) => getSetting(k)));
  missing.forEach((k, i) => { values[k] = fetched[i]; });
  return CONFIG_KEYS.map((k) => values[k]);
}

async function loadConfig(db) {
  const [m, nb, mo, ex, co] = await readConfigValues(db);
  const multiplier = num(m, DEFAULTS.multiplier);
  const noBonusMultiplier = num(nb, DEFAULTS.noBonusMultiplier);
  return {
    multiplier: multiplier > 0 ? multiplier : DEFAULTS.multiplier,
    noBonusMultiplier: noBonusMultiplier > 0 ? noBonusMultiplier : DEFAULTS.noBonusMultiplier,
    minOdds: num(mo, DEFAULTS.minOdds),
    expiryHours: num(ex, DEFAULTS.expiryHours),
    cashoutCounts: String(co) === '1'
  };
}

// ==================== ১. Deposit-এর টার্নওভার তৈরি ====================
// Deposit approve হলে (routes/payment.js creditApprovedDeposit) প্রতিবার ডাকা হয়।
// bonusAmount > 0 হলে (Deposit+Bonus)×multiplier, নাহলে Deposit×1।
async function createDepositTurnover(client, { userId, depositId = null, depositAmount, bonusAmount = 0, source = 'deposit', multiplierOverride = null, status: reqStatus = 'active' }) {
  const pendingReview = reqStatus === 'pending_review';
  const deposit = Math.max(0, Math.round(Number(depositAmount) || 0));
  const bonus = Math.max(0, Math.round(Number(bonusAmount) || 0));
  if (deposit + bonus <= 0) return null;

  const cfg = await loadConfig(client);
  const ov = Number(multiplierOverride);
  // multiplierOverride: নির্দিষ্ট উৎসের (যেমন প্রথম-ডিপোজিট ফ্রি বেট) আলাদা গুণক; না দিলে আগের নিয়ম
  const multiplier = Number.isFinite(ov) && ov > 0 ? ov : (bonus > 0 ? cfg.multiplier : cfg.noBonusMultiplier);
  const required = (deposit + bonus) * multiplier;
  const expiresAt = !pendingReview && cfg.expiryHours > 0 ? new Date(Date.now() + cfg.expiryHours * 3600 * 1000) : null;

  const db = client || pool;
  // status = 'pending_review' হলে এন্ট্রি তৈরি হয় কিন্তু ওয়েজারিং শুরু হয় না: addTurnover / getTurnoverStatus /
  // canWithdraw / forfeitBonuses / expireDue সবাই status = 'active' ফিল্টার করে, তাই এটা গোনাও হয় না, লকও করে না —
  // অ্যাডমিন ছাড় দিলে (releaseDepositTurnover) তবেই 'active' হয়।
  const status = pendingReview ? 'pending_review' : 'active';
  const r = await db.query(
    `INSERT INTO deposit_turnovers
       (user_id, deposit_id, source, deposit_amount, bonus_amount, multiplier, required, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (deposit_id) WHERE deposit_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, depositId, source, deposit, bonus, multiplier, required, status, expiresAt]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

// পুরোনো কলারদের জন্য শিম (referral, freebet, redpacket…): বোনাস-অনলি এন্ট্রি,
// Deposit = 0, তাই required = Bonus × multiplier — একই নিয়ম, একই সিস্টেম।
async function createBonus(client, userId, type, bonusAmount, options = {}) {
  // pending_review: এন্ট্রি তৈরি হয় (deposit_turnovers.status = 'pending_review') কিন্তু গোনা/লক হয় না, অ্যাডমিন ছাড় না দেওয়া পর্যন্ত।
  const depositId = Number.isInteger(options.depositId) ? options.depositId : null;
  return createDepositTurnover(client, {
    userId, depositId, depositAmount: 0, bonusAmount, source: type,
    multiplierOverride: options.multiplier,
    status: options.status === 'pending_review' ? 'pending_review' : 'active'
  });
}

// ==================== ২ক. pending_review ছাড় (অ্যাডমিন অনুমোদন) ====================
// pending_review এন্ট্রি 'active' করে; মেয়াদ (থাকলে) এখান থেকে শুরু। শুধু pending_review সারিতেই কাজ করে।
async function releaseDepositTurnover(client, id) {
  const cfg = await loadConfig(client);
  const expiresAt = cfg.expiryHours > 0 ? new Date(Date.now() + cfg.expiryHours * 3600 * 1000) : null;
  const r = await (client || pool).query(
    `UPDATE deposit_turnovers SET status = 'active', expires_at = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'pending_review' RETURNING id`,
    [id, expiresAt]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

// ==================== ২. মেয়াদ শেষ হওয়া এন্ট্রি ====================
// মেয়াদ পার হলে: বোনাস অংশ (ব্যালেন্সে যতটুকু আছে) কাটা, লক খোলা। একই transaction-এ।
async function expireDue(client, userId) {
  const due = await client.query(
    `SELECT id, bonus_amount FROM deposit_turnovers
      WHERE user_id = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
      ORDER BY id
      FOR UPDATE`,
    [userId]
  );
  if (due.rows.length === 0) return 0;
  const totalBonus = due.rows.reduce((s, b) => s + (Number(b.bonus_amount) || 0), 0);
  let deducted = 0; // মোট কাটা (হিসাব অপরিবর্তিত) — নিচে প্রতিটি সারির expired_deducted-এ ভাগ হয়
  if (totalBonus > 0) {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const bal = await client.query('SELECT coins FROM users WHERE id = $1', [userId]);
    deducted = Math.max(0, Math.min(totalBonus, Math.round(Number(bal.rows[0]?.coins) || 0)));
    if (deducted > 0) {
      await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [deducted, userId]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1,$2,'bonus_forfeit','টার্নওভারের মেয়াদ শেষ — বোনাস বাতিল')`,
        [userId, -deducted]
      );
    }
  }
  // প্রতিটি সারির নিজস্ব কাটা-ভাগ (সেন্ট-পূর্ণসংখ্যায়, ভাসমান ভুল এড়াতে); ভাগের যোগফল = কাটা মোট।
  const shares = splitExpiredDeduction(due.rows.map((r) => r.bonus_amount), deducted);
  await client.query(
    `UPDATE deposit_turnovers d SET status = 'expired', expired_deducted = v.ded, updated_at = NOW()
       FROM unnest($1::int[], $2::numeric[]) AS v(id, ded)
      WHERE d.id = v.id AND d.status = 'active'`,
    [due.rows.map((r) => r.id), shares.map((c) => (c / 100).toFixed(2))]
  );
  return due.rows.length;
}

// কাটা মোট (deducted, টাকায়) সারিগুলোর bonus_amount-এর মধ্যে ভাগ করে; সেন্ট-পূর্ণসংখ্যার অ্যারে ফেরত দেয়।
// • ব্যালেন্স যথেষ্ট (কাটা ≥ মোট বোনাস): প্রতিটি সারি তার পুরো bonus_amount।
// • কম হলে: bonus_amount-এর অনুপাতে (নিচের দিকে গোল); বাকি সেন্ট শেষ বোনাস-সারি নেয়,
//   সারির bonus_amount ছাড়ালে বাকিটা তার আগের সারিতে যায়।
// যোগফল সবসময় ঠিক কাটা মোটের সমান; কোনো সারি নিজের bonus_amount-এর বেশি পায় না।
function splitExpiredDeduction(bonusAmounts, deducted) {
  const bonusC = bonusAmounts.map((v) => Math.max(0, Math.round((Number(v) || 0) * 100)));
  const totalC = bonusC.reduce((s, c) => s + c, 0);
  const dedC = Math.max(0, Math.min(Math.round((Number(deducted) || 0) * 100), totalC));
  if (dedC >= totalC) return bonusC.slice();
  const shares = bonusC.map((c) => Math.floor((dedC * c) / totalC));
  let rest = dedC - shares.reduce((s, c) => s + c, 0);
  for (let i = bonusC.length - 1; i >= 0 && rest > 0; i--) {
    if (bonusC[i] <= 0) continue;
    const take = Math.min(rest, bonusC[i] - shares[i]);
    shares[i] += take;
    rest -= take;
  }
  return shares;
}

// ==================== ৩. যোগ্য বেট সেটেল/প্লেস হলে টার্নওভার ====================
// addTurnover(client, userId, category, stake, opts)  — অথবা পুরোনো addTurnover(userId, category, stake)
// opts: { ref, odds, kind: 'bet'|'cashout'|'void'|'cancelled'|'refund' }
//   ref   — একই বেট দুবার গোনা ঠেকায় (যেমন "bet:123", "casino:<txId>")
//   odds  — Sports-এ min odds যাচাই
async function addTurnover(a, b, c, d, e) {
  const hasClient = !!(a && typeof a.query === 'function');
  const client = hasClient ? a : null;
  const userId = hasClient ? b : a;
  const category = hasClient ? c : b;
  const stake = Number(hasClient ? d : c);
  const opts = (hasClient ? e : d) || {};

  if (!['sports', 'casino'].includes(category)) return { counted: 0 };
  if (!Number.isFinite(stake) || stake <= 0) return { counted: 0 };

  const kind = opts.kind || 'bet';
  if (['void', 'cancelled', 'canceled', 'refund', 'refunded'].includes(kind)) return { counted: 0, reason: kind };

  const cfg = await loadConfig(client);
  if (kind === 'cashout' && !cfg.cashoutCounts) return { counted: 0, reason: 'cashout' };
  if (category === 'sports' && cfg.minOdds > 0) {
    const odds = Number(opts.odds);
    // odds অজানা হলে গোনা হয় না (fail-closed): ভুল হিসাবে লক খোলার চেয়ে নিরাপদ।
    if (!Number.isFinite(odds) || odds < cfg.minOdds) return { counted: 0, reason: 'min_odds' };
  }

  const own = !client;
  const db = client || (await pool.connect());
  try {
    if (own) await db.query('BEGIN');

    if (opts.ref) {
      const ev = await db.query(
        `INSERT INTO turnover_events (user_id, ref, category, amount) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, ref) DO NOTHING RETURNING id`,
        [userId, String(opts.ref), category, stake]
      );
      if (ev.rowCount === 0) { if (own) await db.query('ROLLBACK'); return { counted: 0, reason: 'duplicate' }; }
    }

    await expireDue(db, userId);

    const rows = (await db.query(
      `SELECT id, required, sports_done, casino_done FROM deposit_turnovers
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at ASC, id ASC FOR UPDATE`,
      [userId]
    )).rows;

    let remaining = stake;
    let counted = 0;
    const col = category === 'sports' ? 'sports_done' : 'casino_done';
    for (const row of rows) {
      if (remaining <= 0) break;
      const left = Number(row.required) - Number(row.sports_done) - Number(row.casino_done);
      if (left <= 0) {
        await db.query(`UPDATE deposit_turnovers SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='active'`, [row.id]);
        continue;
      }
      const apply = Math.min(remaining, left);
      // অ্যাটমিক ইনক্রিমেন্ট (lost-update নেই); পূর্ণ হলে একই স্টেটমেন্টে completed → লক খোলে।
      await db.query(
        `UPDATE deposit_turnovers
            SET ${col} = ${col} + $1,
                status = CASE WHEN sports_done + casino_done + $1 >= required THEN 'completed' ELSE status END,
                completed_at = CASE WHEN sports_done + casino_done + $1 >= required THEN NOW() ELSE completed_at END,
                updated_at = NOW()
          WHERE id = $2 AND status = 'active'`,
        [apply, row.id]
      );
      remaining -= apply;
      counted += apply;
    }

    if (own) await db.query('COMMIT');
    return { counted };
  } catch (err) {
    if (own) await db.query('ROLLBACK').catch(() => {});
    console.error('addTurnover error:', err.message);
    throw err; // নীরবে গেলা হয় না — কলার/কিউ রিট্রাই করতে পারবে
  } finally {
    if (own) db.release();
  }
}

// ==================== ৪. স্ট্যাটাস / ড্যাশবোর্ড ====================
function shape(b) {
  const required = Number(b.required) || 0;
  const sportsDone = Number(b.sports_done) || 0;
  const casinoDone = Number(b.casino_done) || 0;
  const completed = sportsDone + casinoDone;
  const remaining = Math.max(0, required - completed);
  const percent = required > 0 ? Math.min(100, Math.floor((completed / required) * 100)) : 100;
  return {
    id: b.id, depositId: b.deposit_id, type: b.source,
    depositAmount: Number(b.deposit_amount) || 0, bonusAmount: Number(b.bonus_amount) || 0,
    multiplier: Number(b.multiplier) || 0, expiresAt: b.expires_at || null,
    required, completed, remaining, percent, sportsDone, casinoDone,
    // withdraw popup-এর ফিল্টার/পুরোনো কনসিউমারের জন্য
    sportsLeft: remaining, casinoLeft: 0
  };
}

async function getTurnoverStatus(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireDue(client, userId);
    const res = await client.query(
      `SELECT * FROM deposit_turnovers WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC, id ASC`,
      [userId]
    );
    await client.query('COMMIT');
    const items = res.rows.map(shape);
    const required = items.reduce((s, i) => s + i.required, 0);
    const completed = items.reduce((s, i) => s + i.completed, 0);
    return {
      items, required, completed,
      remaining: Math.max(0, required - completed),
      percent: required > 0 ? Math.min(100, Math.floor((completed / required) * 100)) : 100,
      sportsDone: items.reduce((s, i) => s + i.sportsDone, 0),
      casinoDone: items.reduce((s, i) => s + i.casinoDone, 0)
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ==================== ৫. উইথড্র গেট ====================
// কোনো active Deposit-টার্নওভার বাকি থাকলে উইথড্র লক। ১০০% হলেই স্বয়ংক্রিয় আনলক।
async function canWithdraw(userId) {
  const st = await getTurnoverStatus(userId);
  if (st.items.length === 0) return { allowed: true, pending: [], summary: st };
  return { allowed: false, pending: st.items, summary: st };
}

// ==================== ৬. বোনাস বাতিল করে লক খোলা (আগের ফিচার অপরিবর্তিত) ====================
async function forfeitBonuses(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const res = await client.query(
      `SELECT id, bonus_amount FROM deposit_turnovers WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
      [userId]
    );
    if (res.rows.length === 0) { await client.query('ROLLBACK'); return { forfeited: 0, deducted: 0 }; }
    const totalBonus = res.rows.reduce((s, b) => s + Math.round(Number(b.bonus_amount) || 0), 0);
    const bal = await client.query('SELECT coins FROM users WHERE id = $1', [userId]);
    const deducted = Math.max(0, Math.min(totalBonus, Math.round(Number(bal.rows[0]?.coins) || 0)));
    if (deducted > 0) {
      await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [deducted, userId]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1,$2,'bonus_forfeit','বোনাস বাতিল করে উইথড্র আনলক')`,
        [userId, -deducted]
      );
    }
    await client.query(`UPDATE deposit_turnovers SET status='forfeited', updated_at=NOW() WHERE user_id=$1 AND status='active'`, [userId]);
    await client.query('COMMIT');
    return { forfeited: res.rows.length, deducted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createDepositTurnover, createBonus, releaseDepositTurnover, addTurnover, canWithdraw, getTurnoverStatus, forfeitBonuses, expireDue, loadConfig, DEFAULTS };
