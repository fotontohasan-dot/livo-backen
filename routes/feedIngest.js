// POST /api/admin/feed-update
// Receives the admin's live sports JSON, upserts matches + markets in PostgreSQL,
// invalidates the Redis cache and pushes the change to viewers over Socket.io.
//
// Auth: header `x-feed-key` must equal env FEED_API_KEY (constant-time compare).
// Payload:
// {
//   "provider": "manual",                       // optional, default "admin_feed"
//   "matches": [{
//     "external_id": "123", "sport": "cricket", "league": "IPL",
//     "team_a": "A", "team_b": "B", "status": "live",
//     "start_time": "2026-11-05T14:00:00Z",
//     "score_a": "120/3", "score_b": "", "overs": "14.2",
//     "markets": [{
//       "key": "mo", "type": "bookmaker", "name": "Match Odds", "status": "open",
//       "runners": [{ "key": "0", "name": "A", "back": 1.85, "lay": 1.87, "back_size": 5000, "lay_size": 3200 }]
//     }]
//   }]
// }
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const cache = require('../services/cache');
const { emitFeedUpdate } = require('../services/socket');

const router = express.Router();

const MAX_MATCHES = 200;
const MAX_MARKETS = 50;
const MAX_RUNNERS = 30;
const MATCH_STATUSES = new Set(['upcoming', 'live', 'finished', 'cancelled']);
const MARKET_STATUSES = new Set(['open', 'suspended']);
const MAX_ODD = 1000;

function keyOk(provided) {
  const expected = process.env.FEED_API_KEY;
  if (!expected) return null; // not configured
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const str = (v, max = 200) => (v === undefined || v === null ? null : String(v).slice(0, max));
function odd(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n > 1 && n <= MAX_ODD ? n : null;
}
function size(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

router.post('/', async (req, res) => {
  const ok = keyOk(req.get('x-feed-key'));
  if (ok === null) return res.status(503).json({ success: false, message: 'Feed key not configured' });
  if (!ok) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const body = req.body || {};
  const list = Array.isArray(body.matches) ? body.matches : null;
  if (!list || list.length === 0 || list.length > MAX_MATCHES) {
    return res.status(400).json({ success: false, message: `matches must be an array of 1-${MAX_MATCHES}` });
  }
  const provider = str(body.provider, 40) || 'admin_feed';

  const results = [];
  const pushes = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, m] of list.entries()) {
      const externalId = str(m && m.external_id);
      if (!externalId || !m.sport || !m.team_a || !m.team_b) {
        results.push({ index: i, ok: false, error: 'external_id, sport, team_a, team_b required' });
        continue;
      }
      const status = String(m.status || 'upcoming').toLowerCase();
      if (!MATCH_STATUSES.has(status)) {
        results.push({ index: i, ok: false, error: `invalid status "${m.status}"` });
        continue;
      }
      const startTime = m.start_time ? new Date(m.start_time) : null;
      if (startTime && Number.isNaN(startTime.getTime())) {
        results.push({ index: i, ok: false, error: 'invalid start_time' });
        continue;
      }

      await client.query('SAVEPOINT m');
      try {
        const fields = [
          str(m.sport, 30).toLowerCase(), str(m.league), str(m.team_a), str(m.team_b),
          `${str(m.team_a)} vs ${str(m.team_b)}`, status, str(m.score_a, 50), str(m.score_b, 50), str(m.overs, 50), startTime
        ];
        const found = await client.query(
          'SELECT id FROM matches WHERE provider = $1 AND external_id = $2 FOR UPDATE', [provider, externalId]);
        let matchId;
        if (found.rows[0]) {
          matchId = found.rows[0].id;
          await client.query(
            `UPDATE matches SET sport=$1, league=$2, team_a=$3, team_b=$4, title=$5, status=$6,
                    score_a=$7, score_b=$8, overs=$9, start_time=COALESCE($10, start_time), synced_at=NOW()
             WHERE id=$11`, [...fields, matchId]);
        } else {
          const ins = await client.query(
            `INSERT INTO matches (sport, league, team_a, team_b, title, status, score_a, score_b, overs, start_time,
                                  provider, external_id, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING id`, [...fields, provider, externalId]);
          matchId = ins.rows[0].id;
        }

        const markets = Array.isArray(m.markets) ? m.markets.slice(0, MAX_MARKETS) : [];
        const marketPush = [];
        for (const mk of markets) {
          const mkKey = str(mk.key || mk.name, 80);
          const mkStatus = String(mk.status || 'open').toLowerCase();
          if (!mkKey || !mk.name || !MARKET_STATUSES.has(mkStatus)) continue;

          const odds = {};
          const depth = {};
          for (const r of (Array.isArray(mk.runners) ? mk.runners.slice(0, MAX_RUNNERS) : [])) {
            const rk = str(r.key, 40);
            if (!rk) continue;
            const back = odd(r.back);
            if (back !== null) odds[rk] = back; // oddsResolver reads only this back price
            depth[rk] = { name: str(r.name, 80), back, lay: odd(r.lay), back_size: size(r.back_size), lay_size: size(r.lay_size) };
          }

          const existing = await client.query(
            'SELECT id, status FROM markets WHERE match_id=$1 AND market_key=$2 FOR UPDATE', [matchId, mkKey]);
          let row;
          if (existing.rows[0]) {
            // never reopen a market an admin closed or settled
            if (!MARKET_STATUSES.has(existing.rows[0].status)) continue;
            row = (await client.query(
              `UPDATE markets SET type=$1, name=$2, odds=$3, depth=$4, status=$5, updated_at=NOW()
               WHERE id=$6 RETURNING id, type, name, status, odds, depth`,
              [str(mk.type, 50) || 'bookmaker', str(mk.name), odds, depth, mkStatus, existing.rows[0].id])).rows[0];
          } else {
            row = (await client.query(
              `INSERT INTO markets (match_id, market_key, type, name, odds, depth, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, type, name, status, odds, depth`,
              [matchId, mkKey, str(mk.type, 50) || 'bookmaker', str(mk.name), odds, depth, mkStatus])).rows[0];
          }
          marketPush.push(row);
        }
        await client.query('RELEASE SAVEPOINT m');
        pushes.push({ match: { id: matchId, status, score_a: fields[6], score_b: fields[7], overs: fields[8] }, markets: marketPush });
        results.push({ index: i, ok: true, match_id: matchId, markets: marketPush.length });
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT m');
        console.error('feed-update match error:', err.message);
        results.push({ index: i, ok: false, error: 'database error' });
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('feed-update error:', err.message);
    return res.status(500).json({ success: false, message: 'Feed update failed' });
  } finally {
    client.release();
  }

  // After commit: clear cached lists, then push to connected clients.
  cache.del('matches:live').catch(() => {});
  for (const p of pushes) emitFeedUpdate(p.match, p.markets);

  res.json({ success: true, processed: results.filter(r => r.ok).length, results });
});

module.exports = router;
