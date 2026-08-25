// services/accumulator.js
// অ্যাকুমুলেটর (পার্লে) — একসাথে একাধিক সিলেকশন, সব জিতলে অডস গুণ হয়ে বড় পেআউট।
// ৩+ সিলেকশনে Boost (বাড়তি %) অডসের সাথে যোগ হয়।

const { pool } = require('../db');
const { addTurnover } = require('./turnover');
const { distributeCommission } = require('./referral');
const { addBet } = require('./cashback');
const { addVipTurnover } = require('./vip');
const { updateMissionProgress } = require('./missions');
const { addPoints } = require('./loyalty');
const { t } = require('../utils/i18n');
const { resolveOdd } = require('./marketOdds');
const { getSetting } = require('./settings');

const MIN_STAKE = 10;
const MAX_SELECTIONS = 12;
// অন্য দুটো বাজি-পথ (routes/games.js, routes/matches.js) site_settings-এর max_bet
// প্রয়োগ করে, কিন্তু অ্যাকুমুলেটরে কোনো উপরের সীমাই ছিল না — একই কনফিগ এখানেও প্রয়োগ
// করা হচ্ছে যাতে সিলিং সব পথে অভিন্ন থাকে।
const FALLBACK_MAX_STAKE = 50000;

async function effectiveMaxStake() {
  const raw = Number(await getSetting('max_bet'));
  return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_MAX_STAKE;
}

// সিলেকশন সংখ্যা অনুযায়ী Boost শতাংশ
function boostFor(count) {
  if (count >= 5) return 30;
  if (count === 4) return 20;
  if (count === 3) return 10;
  return 0; // ১-২ সিলেকশনে বুস্ট নেই
}

// অ্যাকুমুলেটর বাজি স্থাপন
// selections = [{ match_id, market_id, market_name, runner, odd }, ...]
async function placeAccumulator(userId, stake, selections, lang = 'bn') {
  stake = parseInt(stake);
  if (isNaN(stake) || stake < MIN_STAKE) {
    return { success: false, message: t(lang, 'accumulator_min_stake').replace('{value}', MIN_STAKE) };
  }
  const maxStake = await effectiveMaxStake();
  if (stake > maxStake) {
    return { success: false, message: t(lang, 'accumulator_max_stake').replace('{value}', maxStake) };
  }
  if (!Array.isArray(selections) || selections.length < 2) {
    return { success: false, message: t(lang, 'accumulator_min_selections') };
  }
  if (selections.length > MAX_SELECTIONS) {
    return { success: false, message: t(lang, 'accumulator_max_selections').replace('{value}', MAX_SELECTIONS) };
  }

  // ডুপ্লিকেট ম্যাচ চেক (একই ম্যাচে দুই সিলেকশন নয়)
  const matchIds = selections.map(s => s.match_id);
  if (new Set(matchIds).size !== matchIds.length) {
    return { success: false, message: t(lang, 'accumulator_duplicate_match') };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // প্রতিটা মার্কেট যাচাই + অডস সার্ভার থেকে নেওয়া (ক্লায়েন্টের পাঠানো অডস বিশ্বাস নয়)
    let totalOdd = 1;
    const verified = [];
    for (const sel of selections) {
      const m = await client.query(`SELECT * FROM markets WHERE id = $1`, [sel.market_id]);
      const market = m.rows[0];
      if (!market || market.status !== 'open') {
        await client.query('ROLLBACK');
        return { success: false, message: t(lang, 'accumulator_market_closed') };
      }
      // ==================== অডস — একমাত্র authoritative উৎস DB ====================
      // আগে এখানে `let odd = parseFloat(sel.odd)` দিয়ে ক্লায়েন্টের অডস নেওয়া হতো এবং
      // শুধুমাত্র market.odds[sel.runner] সত্যি হলে সেটা DB-র মান দিয়ে overwrite হতো।
      // markets.odds ডিফল্ট '{}' হওয়ায় (migrations.js) — বা runner কি-টা odds-এ না
      // থাকলে — ক্লায়েন্টের পাঠানো অডসই ব্যবহৃত হতো, potential_win সেখান থেকেই হিসাব
      // হতো, আর সেটেলমেন্ট সেই potential_win হুবহু পে করত। এখন services/marketOdds.js
      // দিয়ে fail-closed: runner অবশ্যই market.odds-এর প্রকৃত কী হতে হবে।
      const resolved = resolveOdd(market, sel.runner);
      if (!resolved.ok) {
        await client.query('ROLLBACK');
        const key = (resolved.reason === 'unknown_runner' || resolved.reason === 'invalid_runner')
          ? 'accumulator_invalid_runner'
          : 'accumulator_invalid_odds';
        return { success: false, message: t(lang, key) };
      }
      const odd = resolved.odd;
      totalOdd *= odd;
      verified.push({
        match_id: market.match_id,   // ক্লায়েন্টের match_id নয় — DB-র মার্কেট রো-ই কর্তৃপক্ষ
        market_id: sel.market_id,
        market_name: market.name,
        runner: resolved.runner,
        odd
      });
    }

    const boost = boostFor(verified.length);
    totalOdd = parseFloat(totalOdd.toFixed(2));
    const potentialWin = Math.floor(stake * totalOdd * (1 + boost / 100));

    // ব্যালেন্স কাটা
    const upd = await client.query(
      `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins`,
      [stake, userId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: t(lang, 'common_insufficient_coins') };
    }

    // acca তৈরি
    const acca = await client.query(
      `INSERT INTO accumulators (user_id, stake, total_odd, boost_percent, potential_win, selection_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
      [userId, stake, totalOdd, boost, potentialWin, verified.length]
    );
    const accaId = acca.rows[0].id;

    for (const v of verified) {
      await client.query(
        `INSERT INTO accumulator_selections (acca_id, match_id, market_id, market_name, runner, odd)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [accaId, v.match_id, v.market_id, v.market_name, v.runner, v.odd]
      );
    }

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'accumulator', $3)`,
      [userId, -stake, `অ্যাকুমুলেটর বাজি (${verified.length} সিলেকশন)`]
    );

    await client.query('COMMIT');

    // রিওয়ার্ড সার্ভিসগুলো (স্পোর্টস টার্নওভার)
    addTurnover(userId, 'sports', stake).catch(e => console.error('turnover:', e.message));
    distributeCommission(userId, stake).catch(e => console.error('commission:', e.message));
    addBet(userId, stake, 'sports').catch(e => console.error('cashback:', e.message));
    addVipTurnover(userId, stake).catch(e => console.error('vip:', e.message));
    updateMissionProgress(userId, stake).catch(e => console.error('mission:', e.message));
    addPoints(userId, stake).catch(e => console.error('loyalty:', e.message));

    return {
      success: true,
      accaId,
      totalOdd,
      boost,
      potentialWin,
      message: t(lang, 'accumulator_bet_placed').replace('{value}', potentialWin)
    };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('placeAccumulator error:', e.message);
    return { success: false, message: t(lang, 'common_server_error') };
  } finally {
    client.release();
  }
}

// ইউজারের অ্যাকুমুলেটর তালিকা (সিলেকশন সহ)
async function getUserAccumulators(userId) {
  const accas = (await pool.query(
    `SELECT * FROM accumulators WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [userId]
  )).rows;

  for (const a of accas) {
    a.selections = (await pool.query(
      `SELECT * FROM accumulator_selections WHERE acca_id = $1 ORDER BY id ASC`,
      [a.id]
    )).rows;
  }
  return accas;
}

// ওপেন ম্যাচ ও মার্কেট (অ্যাকুমুলেটর তৈরিতে দেখানোর জন্য)
async function getOpenMarkets() {
  const rows = (await pool.query(
    `SELECT mk.id AS market_id, mk.name AS market_name, mk.type, mk.odds,
            m.id AS match_id, m.title, m.team_a, m.team_b, m.sport
     FROM markets mk
     JOIN matches m ON mk.match_id = m.id
     WHERE mk.status = 'open'
     ORDER BY m.start_time ASC NULLS LAST, m.id DESC
     LIMIT 60`
  )).rows;

  // ম্যাচ অনুযায়ী গ্রুপ
  const matchesMap = {};
  for (const r of rows) {
    if (!matchesMap[r.match_id]) {
      matchesMap[r.match_id] = {
        match_id: r.match_id,
        title: r.title || `${r.team_a || 'Team A'} vs ${r.team_b || 'Team B'}`,
        sport: r.sport,
        markets: []
      };
    }
    matchesMap[r.match_id].markets.push({
      market_id: r.market_id,
      market_name: r.market_name,
      odds: r.odds || {}
    });
  }
  return Object.values(matchesMap);
}

// মার্কেট settle হলে — ওই মার্কেটের acca সিলেকশন won/lost, তারপর প্রভাবিত acca নিষ্পত্তি
// একই DB ট্রানজ্যাকশন client দিয়ে ডাকা হয় (admin settle রুট থেকে)
async function settleSelectionsForMarket(client, marketId, winningRunner) {
  // ১) এই মার্কেটের pending acca সিলেকশন আপডেট
  const sels = (await client.query(
    `SELECT * FROM accumulator_selections WHERE market_id = $1 AND status = 'pending' FOR UPDATE`,
    [marketId]
  )).rows;

  const affectedAccaIds = new Set();
  const notifsToEmit = []; // {userId, row} — কলার (routes/admin.js) এগুলো real-time emitToUser()-এ পাঠায়
  for (const sel of sels) {
    const won = String(sel.runner) === String(winningRunner);
    await client.query(
      `UPDATE accumulator_selections SET status = $1 WHERE id = $2`,
      [won ? 'won' : 'lost', sel.id]
    );
    affectedAccaIds.add(sel.acca_id);
  }

  // ২) প্রভাবিত প্রতিটি acca চেক করে নিষ্পত্তি
  for (const accaId of affectedAccaIds) {
    const accaRes = await client.query(
      `SELECT * FROM accumulators WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [accaId]
    );
    const acca = accaRes.rows[0];
    if (!acca) continue;

    const all = (await client.query(
      `SELECT status FROM accumulator_selections WHERE acca_id = $1`,
      [accaId]
    )).rows;

    const anyLost = all.some(x => x.status === 'lost');
    const anyPending = all.some(x => x.status === 'pending');

    if (anyLost) {
      // কোনো একটি হারলেই পুরো acca হার
      await client.query(
        `UPDATE accumulators SET status = 'lost', settled_at = NOW() WHERE id = $1`,
        [accaId]
      );
      const ln = await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'অ্যাকুমুলেটর', $2, 'error') RETURNING *`,
        [acca.user_id, 'দুঃখিত, আপনার অ্যাকুমুলেটর বাজিটি হেরে গেছে।']
      );
      notifsToEmit.push({ userId: acca.user_id, row: ln.rows[0] });
    } else if (!anyPending) {
      // সব জিতেছে — পেআউট
      const payout = acca.potential_win;
      await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [payout, acca.user_id]);
      await client.query(
        `UPDATE accumulators SET status = 'won', settled_at = NOW() WHERE id = $1`,
        [accaId]
      );
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'accumulator_win', 'অ্যাকুমুলেটর জয়')`,
        [acca.user_id, payout]
      );
      const wn = await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'অ্যাকুমুলেটর জয়!', $2, 'success') RETURNING *`,
        [acca.user_id, `অভিনন্দন! আপনি অ্যাকুমুলেটরে ${payout} কয়েন জিতেছেন!`]
      );
      notifsToEmit.push({ userId: acca.user_id, row: wn.rows[0] });
    }
    // anyPending হলে এখনো অন্য সিলেকশন বাকি — কিছু করি না
  }

  // আগে এখানে affectedAccaIds.size (একটা সংখ্যা) রিটার্ন হতো, কিন্তু কলার
  // (routes/admin.js POST /markets/:marketId/settle) সেটাকে notifsToEmit.push(...accaNotifs)
  // দিয়ে spread করার চেষ্টা করত — সংখ্যা iterable না হওয়ায় প্রতিবার TypeError থ্রো করত
  // (COMMIT-এর পরে, তাই আসল সেটেলমেন্ট ঠিকই হয়ে যেত কিন্তু অ্যাডমিনকে ভুলভাবে "সেটেল সমস্যা!"
  // দেখানো হতো, real-time notification/audit log কখনো পাঠানো হতো না)। এখন প্রকৃত
  // {userId, row} নোটিফিকেশন অবজেক্টের অ্যারে রিটার্ন করা হয়, যেটা কলারের প্রত্যাশার সাথে মেলে।
  return notifsToEmit;
}

module.exports = { placeAccumulator, getUserAccumulators, getOpenMarkets, boostFor, MIN_STAKE, settleSelectionsForMarket };
