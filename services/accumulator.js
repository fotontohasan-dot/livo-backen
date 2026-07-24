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

const MIN_STAKE = 10;
const MAX_SELECTIONS = 12;

// সিলেকশন সংখ্যা অনুযায়ী Boost শতাংশ
function boostFor(count) {
  if (count >= 5) return 30;
  if (count === 4) return 20;
  if (count === 3) return 10;
  return 0; // ১-২ সিলেকশনে বুস্ট নেই
}

// অ্যাকুমুলেটর বাজি স্থাপন
// selections = [{ match_id, market_id, market_name, runner, odd }, ...]
async function placeAccumulator(userId, stake, selections) {
  stake = parseInt(stake);
  if (isNaN(stake) || stake < MIN_STAKE) {
    return { success: false, message: `সর্বনিম্ন স্টেক ${MIN_STAKE} কয়েন।` };
  }
  if (!Array.isArray(selections) || selections.length < 2) {
    return { success: false, message: 'অ্যাকুমুলেটরে কমপক্ষে ২টি সিলেকশন লাগবে।' };
  }
  if (selections.length > MAX_SELECTIONS) {
    return { success: false, message: `সর্বোচ্চ ${MAX_SELECTIONS}টি সিলেকশন।` };
  }

  // ডুপ্লিকেট ম্যাচ চেক (একই ম্যাচে দুই সিলেকশন নয়)
  const matchIds = selections.map(s => s.match_id);
  if (new Set(matchIds).size !== matchIds.length) {
    return { success: false, message: 'একই ম্যাচ থেকে একাধিক সিলেকশন নেওয়া যাবে না।' };
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
        return { success: false, message: 'একটি মার্কেট এখন বাজির জন্য খোলা নেই।' };
      }
      // অডস বের করা — odds JSONB তে runner→odd, নাহলে ক্লায়েন্ট অডস (fallback)
      let odd = parseFloat(sel.odd);
      try {
        if (market.odds && sel.runner && market.odds[sel.runner]) {
          odd = parseFloat(market.odds[sel.runner]);
        }
      } catch (e) {}
      if (isNaN(odd) || odd <= 1) {
        await client.query('ROLLBACK');
        return { success: false, message: 'একটি সিলেকশনের অডস অকার্যকর।' };
      }
      totalOdd *= odd;
      verified.push({
        match_id: sel.match_id,
        market_id: sel.market_id,
        market_name: market.name,
        runner: sel.runner || null,
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
      return { success: false, message: 'পর্যাপ্ত কয়েন নেই।' };
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
      message: `অ্যাকুমুলেটর বাজি সফল! সম্ভাব্য জয়: ${potentialWin} কয়েন`
    };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('placeAccumulator error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
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

  const notifsToEmit = [];
  const affectedAccaIds = new Set();
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
      const n = await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'অ্যাকুমুলেটর', $2, 'error') RETURNING *`,
        [acca.user_id, 'দুঃখিত, আপনার অ্যাকুমুলেটর বাজিটি হেরে গেছে।']
      );
      notifsToEmit.push({ userId: acca.user_id, row: n.rows[0] });
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
      const n = await client.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1, 'অ্যাকুমুলেটর জয়!', $2, 'success') RETURNING *`,
        [acca.user_id, `অভিনন্দন! আপনি অ্যাকুমুলেটরে ${payout} কয়েন জিতেছেন!`]
      );
      notifsToEmit.push({ userId: acca.user_id, row: n.rows[0] });
    }
    // anyPending হলে এখনো অন্য সিলেকশন বাকি — কিছু করি না
  }

  return notifsToEmit;
}

module.exports = { placeAccumulator, getUserAccumulators, getOpenMarkets, boostFor, MIN_STAKE, settleSelectionsForMarket };
