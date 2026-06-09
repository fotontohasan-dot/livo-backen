const { pool } = require('../db');

/**
 * syncMatches function.
 * Fetches/Generates realistic upcoming matches for Cricket and Football.
 * Ensures no duplicates are added.
 */
async function syncMatches() {
  const footballLeagues = [
    { name: 'Premier League', teams: ['Arsenal', 'Man City', 'Liverpool', 'Aston Villa', 'Tottenham', 'Man Utd', 'Newcastle', 'Chelsea'] },
    { name: 'La Liga', teams: ['Real Madrid', 'Barcelona', 'Girona', 'Atletico Madrid', 'Athletic Bilbao', 'Real Sociedad', 'Real Betis', 'Valencia'] },
    { name: 'Bundesliga', teams: ['Bayer Leverkusen', 'Bayern Munich', 'Stuttgart', 'RB Leipzig', 'Borussia Dortmund', 'Eintracht Frankfurt', 'Hoffenheim', 'Freiburg'] },
    { name: 'Serie A', teams: ['Inter Milan', 'AC Milan', 'Juventus', 'Bologna', 'Roma', 'Atalanta', 'Lazio', 'Napoli'] },
    { name: 'Ligue 1', teams: ['PSG', 'Monaco', 'Brest', 'Lille', 'Nice', 'Lens', 'Lyon', 'Marseille'] },
    { name: 'International Friendly', teams: ['Brazil', 'Argentina', 'France', 'Germany', 'England', 'Spain', 'Portugal', 'Italy', 'Bangladesh', 'India', 'Japan', 'South Korea'] }
  ];

  const cricketLeagues = [
    { name: 'IPL 2024', teams: ['CSK', 'MI', 'RCB', 'KKR', 'GT', 'LSG', 'SRH', 'PBKS', 'DC', 'RR'] },
    { name: 'BPL 2024', teams: ['Comilla Victorians', 'Fortune Barishal', 'Rangpur Riders', 'Sylhet Strikers', 'Chattogram Challengers', 'Khulna Tigers', 'Durdanto Dhaka'] },
    { name: 'T20 World Cup', teams: ['Bangladesh', 'India', 'Pakistan', 'Australia', 'England', 'South Africa', 'New Zealand', 'Sri Lanka', 'West Indies', 'Afghanistan'] },
    { name: 'PSL 2024', teams: ['Lahore Qalandars', 'Multan Sultans', 'Peshawar Zalmi', 'Islamabad United', 'Quetta Gladiators', 'Karachi Kings'] }
  ];

  const matchesToAdd = [];
  const now = new Date();

  // Generate 10 Football matches for the next week
  for (let i = 1; i <= 10; i++) {
    const league = footballLeagues[Math.floor(Math.random() * footballLeagues.length)];
    const teamA = league.teams[Math.floor(Math.random() * league.teams.length)];
    let teamB = league.teams[Math.floor(Math.random() * league.teams.length)];
    while (teamA === teamB) teamB = league.teams[Math.floor(Math.random() * league.teams.length)];

    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + Math.floor(i / 2) + 1);
    matchDate.setHours(16 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 4) * 15, 0, 0);

    matchesToAdd.push({
      title: `${teamA} vs ${teamB} - ${league.name}`,
      sport: 'football',
      team_a: teamA,
      team_b: teamB,
      match_date: matchDate
    });
  }

  // Generate 10 Cricket matches for the next week
  for (let i = 1; i <= 10; i++) {
    const league = cricketLeagues[Math.floor(Math.random() * cricketLeagues.length)];
    const teamA = league.teams[Math.floor(Math.random() * league.teams.length)];
    let teamB = league.teams[Math.floor(Math.random() * league.teams.length)];
    while (teamA === teamB) teamB = league.teams[Math.floor(Math.random() * league.teams.length)];

    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + Math.floor(i / 2) + 1);
    matchDate.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 4) * 15, 0, 0);

    matchesToAdd.push({
      title: `${teamA} vs ${teamB} - ${league.name}`,
      sport: 'cricket',
      team_a: teamA,
      team_b: teamB,
      match_date: matchDate
    });
  }

  let addedCount = 0;
  for (const match of matchesToAdd) {
    // Check if match already exists (same teams on same day)
    const existing = await pool.query(
      `SELECT id FROM matches WHERE team_a = $1 AND team_b = $2 AND match_date::date = $3::date`,
      [match.team_a, match.team_b, match.match_date]
    );

    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO matches (title, sport, team_a, team_b, match_date) VALUES ($1, $2, $3, $4, $5)`,
        [match.title, match.sport, match.team_a, match.team_b, match.match_date]
      );
      addedCount++;
    }
  }

  console.log(`Successfully synced matches. Added ${addedCount} new matches.`);
  return addedCount;
}

module.exports = { syncMatches };
