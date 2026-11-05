// services/marketTemplates.js
// ---------------------------------------------------------------------------
// প্রতিটি ম্যাচের জন্য ডিফল্ট মার্কেটের তালিকা (ক্রিকেট ও ফুটবল)।
//
// আগে শুধু একটা "Match Winner" মার্কেট তৈরি হতো, তাই ম্যাচ পেজ প্রায় ফাঁকা দেখাত।
// এখন একটা ম্যাচে Over/Under, Odd/Even, Yes/No, 1X2 ইত্যাদি একাধিক মার্কেট তৈরি হয়।
//
// অডস মার্কেটের `odds` JSONB-তেই জমা থাকে (runner কী → অডস)। ফলে পেজে যে সংখ্যা
// দেখা যায় সার্ভার বাজি ধরার সময় ঠিক সেটাই ব্যবহার করে (services/oddsResolver.js
// জমা অডসকেই অগ্রাধিকার দেয়)। অ্যাডমিন চাইলে /admin/markets থেকে বদলাতে পারেন।
//
// runner কী-গুলো সেটেলমেন্টে অ্যাডমিন `winning_runner` হিসেবে দেন, তাই এগুলো ছোট ও
// স্থির: over/under, odd/even, yes/no, 0/1/draw (দল A / দল B / ড্র), 1x/12/x2।
// ---------------------------------------------------------------------------

// ফরম্যাট শনাক্ত: লিগ/শিরোনামে test/odi লেখা থাকলে সেই অনুযায়ী লাইন বসে
function detectCricketFormat(match) {
  const text = `${match.league || ''} ${match.title || ''}`.toLowerCase();
  if (/\btest\b/.test(text)) return 'test';
  if (/\bodi\b|one.?day/.test(text)) return 'odi';
  if (/\bt10\b/.test(text)) return 't10';
  return 't20';
}

const CRICKET_LINES = {
  t10:  { team: 98.5,  match: 197.5, firstOver: true,  fifty: 'Any batsman to score 30+' },
  t20:  { team: 165.5, match: 331.5, firstOver: true,  fifty: 'Any batsman to score 50+' },
  odi:  { team: 270.5, match: 541.5, firstOver: true,  fifty: 'Any batsman to score a Century' },
  test: { team: 320.5, match: 900.5, firstOver: false, fifty: 'Any batsman to score a Century' }
};

const OU = (over, under) => ({ over, under });
const OE = (odd, even) => ({ odd, even });
const YN = (yes, no) => ({ yes, no });

// type  → ম্যাচ পেজের গ্রুপ/ট্যাব ঠিক করে (services/marketLayout.js)
// name  → এই নামেই "আছে কিনা" দেখে idempotent ইনসার্ট হয়, তাই নাম স্থির রাখতে হবে
function cricketTemplates(match) {
  const a = match.team_a || 'Team A';
  const b = match.team_b || 'Team B';
  const fmt = detectCricketFormat(match);
  const cfg = CRICKET_LINES[fmt];
  const line = cfg.team;
  const list = [];

  if (fmt === 'test') {
    list.push({ type: 'match_odds', name: 'Match Result (With Draw)', odds: { '0': 2.4, draw: 3.2, '1': 2.9 } });
  }

  list.push(
    { type: 'over_under', name: `${a} Total Runs Over/Under ${line}`, odds: OU(1.87, 1.87) },
    { type: 'over_under', name: `${b} Total Runs Over/Under ${line}`, odds: OU(1.87, 1.87) },
    { type: 'over_under', name: `Match Total Runs Over/Under ${cfg.match}`, odds: OU(1.9, 1.84) },
    { type: 'odd_even',   name: `${a} Total Runs (Odd/Even)`, odds: OE(1.87, 1.87) },
    { type: 'odd_even',   name: `${b} Total Runs (Odd/Even)`, odds: OE(1.87, 1.87) }
  );

  if (cfg.firstOver) {
    list.push(
      { type: 'odd_even',   name: `${a} First Over Total Runs (Odd/Even)`, odds: OE(1.87, 1.87) },
      { type: 'odd_even',   name: `${b} First Over Total Runs (Odd/Even)`, odds: OE(1.87, 1.87) },
      { type: 'over_under', name: `${a} First Over Total Runs Over/Under 5.5`, odds: OU(1.9, 1.84) },
      { type: 'over_under', name: `${b} First Over Total Runs Over/Under 5.5`, odds: OU(1.9, 1.84) }
    );
  }

  list.push({ type: 'yes_no', name: cfg.fifty + ' — Yes/No', odds: YN(1.45, 2.6) });
  return list;
}

function footballTemplates() {
  return [
    { type: 'match_odds', name: 'Match Result (1X2)', odds: { '0': 2.1, draw: 3.3, '1': 3.2 } },
    { type: 'double_chance', name: 'Double Chance', odds: { '1x': 1.3, '12': 1.28, x2: 1.6 } },
    { type: 'over_under', name: 'Total Goals Over/Under 1.5', odds: OU(1.38, 2.9) },
    { type: 'over_under', name: 'Total Goals Over/Under 2.5', odds: OU(1.9, 1.9) },
    { type: 'over_under', name: 'Total Goals Over/Under 3.5', odds: OU(2.85, 1.38) },
    { type: 'yes_no',     name: 'Both Teams To Score — Yes/No', odds: YN(1.8, 1.95) },
    { type: 'odd_even',   name: 'Total Goals (Odd/Even)', odds: OE(1.95, 1.9) }
  ];
}

// match: matches টেবিলের রো (sport, team_a, team_b, league, title)
function templatesFor(match) {
  if (!match) return [];
  const sport = String(match.sport || '').toLowerCase();
  if (sport === 'football' || sport === 'soccer') return footballTemplates();
  return cricketTemplates(match);
}

module.exports = { templatesFor, detectCricketFormat };
