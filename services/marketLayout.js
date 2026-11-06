// services/marketLayout.js
// ---------------------------------------------------------------------------
// ম্যাচ পেজে মার্কেট কীভাবে দেখাবে (ট্যাব, লাইন, লেবেল) তা ঠিক করে।
// দেখানো আর সার্ভারের অডস এক জিনিস থেকেই আসে: market.odds (না থাকলে oddsResolver-এর ডিফল্ট)।
// ---------------------------------------------------------------------------
const { DEFAULT_ODDS } = require('./oddsResolver');

const ORDER = ['0', '1x', '12', 'x2', 'draw', '1', 'over', 'under', 'odd', 'even', 'yes', 'no'];
const STATIC_LABELS = { over: 'Over', under: 'Under', odd: 'Odd', even: 'Even', yes: 'Yes', no: 'No', draw: 'Draw' };

function orderKeys(keys) {
  const rank = (k) => {
    const i = ORDER.indexOf(k);
    return i === -1 ? 100 : i;
  };
  // 0,1,2,3,4,5+ (ডেলিভারি রান) — সংখ্যার ক্রমে
  const numeric = (k) => (/^\d+\+?$/.test(k) ? parseInt(k, 10) : NaN);
  return keys.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const na = numeric(a), nb = numeric(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

function labelFor(key, type, teamA, teamB) {
  if (type === 'bookmaker' || type === 'match_odds') {
    if (key === '0') return teamA;
    if (key === '1') return teamB;
  }
  if (type === 'double_chance') {
    if (key === '1x') return `${teamA} or Draw`;
    if (key === '12') return `${teamA} or ${teamB}`;
    if (key === 'x2') return `Draw or ${teamB}`;
  }
  return STATIC_LABELS[key] || String(key);
}

function categoryFor(market, isFootball) {
  const type = market.type;
  const name = String(market.name || '');
  if (type === 'bookmaker' || type === 'match_odds' || type === 'double_chance') return 'match';
  if (isFootball) return 'goals';
  if (/first over/i.test(name)) return 'over';
  if (type === 'yes_no') return 'batsman';
  if (/total runs/i.test(name) && !/^match /i.test(name)) return 'innings';
  return 'match';
}

// raw: market.odds — অবজেক্ট বা (পুরনো অ্যাডমিন-মার্কেটে) একক সংখ্যা
function runnersFor(market, teamA, teamB) {
  const type = market.type;
  const raw = market.odds;
  let map = null;

  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length) {
    map = raw;
  } else if (type === 'bookmaker') {
    map = DEFAULT_ODDS.bookmaker;
  } else if (typeof raw === 'number' || (typeof raw === 'string' && raw !== '')) {
    // অ্যাডমিনের তৈরি একক-অডস মার্কেট: পুরো সারিটাই এক রানার ('yes')
    map = { yes: raw };
  } else {
    map = DEFAULT_ODDS.default;
  }

  const depth = (market.depth && typeof market.depth === 'object' && !Array.isArray(market.depth)) ? market.depth : {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  return orderKeys(Object.keys(map)).map((key) => {
    const d = depth[key] || {};
    const lay = num(d.lay);
    return {
      key,
      label: labelFor(key, type, teamA, teamB),
      odd: Number(map[key]),
      lay: lay !== null && lay > 1 ? lay : null,   // null → Lay বক্স নিষ্ক্রিয়
      backSize: num(d.back_size),
      laySize: num(d.lay_size),
      suspended: d.suspended === true
    };
  }).filter((r) => Number.isFinite(r.odd) && r.odd > 1);
}

// match: { sport, teams:[a,b] }
function buildMarketView(markets, match) {
  const teamA = (match.teams && match.teams[0]) || 'Team A';
  const teamB = (match.teams && match.teams[1]) || 'Team B';
  const isFootball = String(match.sport || '').toLowerCase() === 'football';

  let ouSeen = 0;
  const out = [];
  for (const m of markets || []) {
    const runners = runnersFor(m, teamA, teamB);
    if (!runners.length) continue;
    let popular = m.type === 'bookmaker' || m.type === 'match_odds';
    if (m.type === 'over_under' && ouSeen < 2) { popular = true; ouSeen += 1; }
    out.push({
      id: m.id,
      type: m.type,
      name: m.name,
      status: m.status || 'open',
      category: categoryFor(m, isFootball),
      popular,
      runners
    });
  }

  const tabs = [{ id: 'all', label: 'All' }];
  if (out.some((m) => m.popular)) tabs.push({ id: 'popular', label: 'Popular' });
  const cats = isFootball
    ? [['match', 'Match'], ['goals', 'Goals']]
    : [['match', 'Match'], ['innings', 'Innings'], ['over', 'Over'], ['batsman', 'Batsman']];
  for (const [id, label] of cats) {
    if (out.some((m) => m.category === id)) tabs.push({ id, label });
  }
  return { markets: out, tabs };
}

module.exports = { buildMarketView, runnersFor, categoryFor };
