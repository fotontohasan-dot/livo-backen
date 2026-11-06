// services/liveData.js
// Validates/normalises the optional `live` object a feed sends per match so the
// scoreboard can be rendered safely (all values are clamped, trimmed and typed;
// nothing from the feed is ever trusted as markup).
//
// cricket : { runs, wickets, overs, runRate, target, batsmen:[{name,runs,balls,fours,sixes,strike}],
//             bowler:{name,overs,maidens,runs,wickets}, balls:["0","1","4","6","W"] }
// football: { clock, period, halves:[[h,a],[h,a]], momentum(0-100 = home share) }
// tennis  : { sets:[[a,b],...], game:[a,b], server:0|1, momentum(0-100) }

const MAX_JSON = 4096;

function kindOf(sport) {
  const s = String(sport || '').toLowerCase();
  if (s === 'football' || s === 'soccer') return 'football';
  if (s === 'tennis') return 'tennis';
  if (s === 'cricket') return 'cricket';
  return null;
}
const txt = (v, n = 40) => (v === undefined || v === null ? '' : String(v).replace(/[\u0000-\u001f]/g, '').slice(0, n));
function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const pair = (v, f) => { const a = arr(v, 2); return a.length === 2 ? [f(a[0]), f(a[1])] : null; };

function cricket(raw) {
  const out = { kind: 'cricket' };
  out.runs = num(raw.runs, 0, 9999);
  out.wickets = num(raw.wickets, 0, 10);
  out.overs = txt(raw.overs, 8);
  out.runRate = num(raw.runRate, 0, 99);
  out.target = num(raw.target, 0, 9999);
  out.batsmen = arr(raw.batsmen, 2).map((b) => ({
    name: txt(b && b.name, 40),
    runs: num(b && b.runs, 0, 999) || 0,
    balls: num(b && b.balls, 0, 999) || 0,
    fours: num(b && b.fours, 0, 99) || 0,
    sixes: num(b && b.sixes, 0, 99) || 0,
    strike: !!(b && b.strike)
  })).filter((b) => b.name);
  const bw = raw.bowler;
  out.bowler = bw && txt(bw.name, 40) ? {
    name: txt(bw.name, 40), overs: txt(bw.overs, 6),
    maidens: num(bw.maidens, 0, 99) || 0, runs: num(bw.runs, 0, 999) || 0, wickets: num(bw.wickets, 0, 10) || 0
  } : null;
  out.balls = arr(raw.balls, 12).map((b) => txt(b, 3).toUpperCase()).filter((b) => /^(W|WD|NB|LB|B|\d{1,2})$/.test(b));
  const has = out.runs !== null || out.batsmen.length || out.balls.length;
  return has ? out : null;
}

function football(raw) {
  const out = { kind: 'football', clock: txt(raw.clock, 10), period: txt(raw.period, 12) };
  out.halves = arr(raw.halves, 2).map((h) => pair(h, (x) => num(x, 0, 99) || 0)).filter(Boolean);
  out.momentum = num(raw.momentum, 0, 100);
  return out.clock || out.period || out.halves.length || out.momentum !== null ? out : null;
}

function tennis(raw) {
  const out = { kind: 'tennis' };
  out.sets = arr(raw.sets, 5).map((s) => pair(s, (x) => num(x, 0, 99) || 0)).filter(Boolean);
  out.game = pair(raw.game, (x) => txt(x, 3));
  out.server = raw.server === 0 || raw.server === 1 ? raw.server : null;
  out.momentum = num(raw.momentum, 0, 100);
  return out.sets.length || out.game || out.momentum !== null ? out : null;
}

function sanitizeLive(sport, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = kindOf(sport);
  if (!kind) return null;
  const out = { cricket, football, tennis }[kind](raw);
  if (!out) return null;
  return JSON.stringify(out).length <= MAX_JSON ? out : null;
}

// Placeholder shown when the feed has not (yet) sent live stats. The page renders
// "Waiting for live feed…" for a live match and hydrates as soon as a real
// `liveUpdate` arrives. Never null for a known sport, so renderers need no special cases.
function emptyLive(sport) {
  const kind = kindOf(sport);
  return kind ? { kind, waiting: true } : null;
}

// stored JSONB (or null) -> something safe to hand to the client
function liveForClient(sport, stored) {
  return (stored && typeof stored === 'object' && stored.kind) ? stored : emptyLive(sport);
}

module.exports = { sanitizeLive, kindOf, emptyLive, liveForClient };
