// services/marketLayout.js
// ---------------------------------------------------------------------------
// ম্যাচ পেজে মার্কেট কীভাবে দেখাবে (ট্যাব, লাইন, লেবেল) তা ঠিক করে।
// দেখানো আর সার্ভারের অডস এক জিনিস থেকেই আসে: market.odds (না থাকলে oddsResolver-এর ডিফল্ট)।
// ---------------------------------------------------------------------------
const { DEFAULT_ODDS } = require('./oddsResolver');

// Player Performance markets (feed/admin supplied; never invented): over/under a player's runs,
// and player-vs-player head to head. Same Back/Lay + settle/void machinery as every other market.
const PLAYER_TYPES = new Set(['player_runs', 'player_h2h']);

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

const sportKind = (sport) => {
  const s = String(sport || '').toLowerCase();
  if (s === 'football' || s === 'soccer') return 'football';
  if (s === 'tennis') return 'tennis';
  return 'cricket'; // legacy default layout
};

// Tab ids: football  -> match (Full Time Result) | goals (Over/Under) | btts
//          tennis    -> match (Match Winner)     | set (Set Winner)   | games (Game Totals)
//          cricket   -> match | innings | over | batsman  (unchanged)
function categoryFor(market, kind) {
  if (typeof kind === 'boolean') kind = kind ? 'football' : 'cricket'; // backwards compatible
  const type = market.type;
  if (PLAYER_TYPES.has(type)) return 'player';
  const name = String(market.name || '');

  if (kind === 'football') {
    if (/both teams/i.test(name) || /\bbtts\b/i.test(name)) return 'btts';
    if (type === 'bookmaker' || type === 'match_odds' || type === 'double_chance') return 'match';
    return 'goals';
  }
  if (kind === 'tennis') {
    if (/games?/i.test(name)) return 'games';            // "Total Games…", "Set 1 Total Games…"
    if (/\bset\b/i.test(name)) return 'set';             // "Set 1 Winner", "Set Betting"
    return 'match';
  }

  if (type === 'bookmaker' || type === 'match_odds' || type === 'double_chance') return 'match';
  if (/first over/i.test(name)) return 'over';
  if (type === 'yes_no') return 'batsman';
  if (/total runs/i.test(name) && !/^match /i.test(name)) return 'innings';
  return 'match';
}

// raw: market.odds — অবজেক্ট বা (পুরনো অ্যাডমিন-মার্কেটে) একক সংখ্যা
// Each runner: { key, label, odd (back), lay (or null), status: 'open'|'suspended' }
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

  const depth = (market.depth && typeof market.depth === 'object') ? market.depth : {};
  const rstat = (market.runner_status && typeof market.runner_status === 'object') ? market.runner_status : {};

  return orderKeys(Object.keys(map)).map((key) => {
    const lay = depth[key] && Number(depth[key].lay);
    const isSusp = String(rstat[key] || 'open').toLowerCase() === 'suspended' || (depth[key] && depth[key].suspended === true);
    return {
      key,
      label: (PLAYER_TYPES.has(type) && depth[key] && typeof depth[key].name === 'string' && depth[key].name.trim())
        ? depth[key].name.trim().slice(0, 60) : labelFor(key, type, teamA, teamB),
      odd: Number(map[key]),
      lay: Number.isFinite(lay) && lay > 1 ? lay : null,
      backSize: depth[key] && Number.isFinite(Number(depth[key].back_size)) ? Number(depth[key].back_size) : null,
      laySize: depth[key] && Number.isFinite(Number(depth[key].lay_size)) ? Number(depth[key].lay_size) : null,
      suspended: isSusp,
      status: isSusp ? 'suspended' : 'open'
    };
  }).filter((r) => Number.isFinite(r.odd) && r.odd > 1);
}

const TABS_BY_SPORT = {
  football: [['match', 'Full Time Result'], ['goals', 'Goals (Over/Under)'], ['btts', 'Both Teams to Score']],
  tennis: [['match', 'Match Winner'], ['set', 'Set Winner'], ['games', 'Game Totals']],
  cricket: [['match', 'Match'], ['innings', 'Innings'], ['over', 'Over'], ['batsman', 'Batsman']]
};

// match: { sport, teams:[a,b] }
function buildMarketView(markets, match) {
  const teamA = (match.teams && match.teams[0]) || 'Team A';
  const teamB = (match.teams && match.teams[1]) || 'Team B';
  const kind = sportKind(match.sport);

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
      category: categoryFor(m, kind),
      popular,
      runners
    });
  }

  const tabs = [{ id: 'all', label: 'All' }];
  if (out.some((m) => m.popular)) tabs.push({ id: 'popular', label: 'Popular' });
  for (const [id, label] of TABS_BY_SPORT[kind]) {
    // Football/Tennis always show their sport tabs (an empty one shows the
    // "coming soon" message); cricket keeps showing only non-empty tabs.
    if (kind !== 'cricket' || out.some((m) => m.category === id)) tabs.push({ id, label });
  }
  // Player Performance: shown when the feed/admin supplied player markets; cricket always shows it so an
  // empty tab explains "coming soon" instead of fabricating players or odds.
  if (out.some((m) => m.category === 'player') || kind === 'cricket') tabs.push({ id: 'player', label: 'Player Performance' });
  return { markets: out, tabs };
}

// Server-side filter used by GET /matches/:id/markets?tab=…
function filterMarketView(view, tab) {
  if (!tab || tab === 'all') return view.markets;
  if (tab === 'popular') return view.markets.filter((m) => m.popular);
  return view.markets.filter((m) => m.category === tab);
}

module.exports = { buildMarketView, filterMarketView, runnersFor, categoryFor, PLAYER_TYPES };
