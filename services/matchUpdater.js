const { pool } = require('../db');

/**
 * syncMatches function.
 * Fetches/Generates realistic upcoming matches for Cricket and Football.
 * Ensures no duplicates are added.
 */
async function syncMatches() {
  const footballTeams = [
    'Brazil', 'Argentina', 'France', 'Germany', 'England', 'Spain', 'Portugal', 'Italy',
    'Netherlands', 'Belgium', 'Croatia', 'Uruguay', 'Man City', 'Liverpool', 'Real Madrid',
    'Barcelona', 'Bayern Munich', 'PSG', 'Arsenal', 'Man United', 'Chelsea', 'Juventus',
    'AC Milan', 'Inter Milan', 'Atletico Madrid', 'Dortmund', 'Bayer Leverkusen', 'Napoli',
    'Roma', 'Lazio', 'Tottenham', 'Aston Villa', 'Newcastle', 'Brighton', 'West Ham',
    'Benfica', 'Porto', 'Sporting CP', 'Ajax', 'PSV', 'Feyenoord', 'Galatasaray', 'Fenerbahce',
    'Besiktas', 'Al Nassr', 'Al Hilal', 'Al Ittihad', 'Inter Miami', 'LA Galaxy', 'Flamengo',
    'Palmeiras', 'River Plate', 'Boca Juniors', 'Japan', 'South Korea', 'Morocco', 'Senegal'
  ];
  const cricketTeams = [
    'Bangladesh', 'India', 'Pakistan', 'Australia', 'England', 'South Africa', 'New Zealand',
    'Sri Lanka', 'Afghanistan', 'West Indies', 'Ireland', 'Zimbabwe', 'RCB', 'KKR', 'MI', 'CSK',
    'Delhi Capitals', 'LSG', 'Gujarat Titans', 'Sunrisers Hyderabad', 'Rajasthan Royals', 'Punjab Kings',
    'Comilla Victorians', 'Sylhet Strikers', 'Rangpur Riders', 'Fortune Barishal', 'Dhaka Dominators',
    'Chattogram Challengers', 'Perth Scorchers', 'Sydney Sixers', 'Brisbane Heat', 'Adelaide Strikers',
    'Hobart Hurricanes', 'Melbourne Renegades', 'Melbourne Stars', 'Sydney Thunder', 'Guyana Amazon Warriors',
    'Trinbago Knight Riders', 'Barbados Royals', 'St Kitts & Nevis Patriots', 'Saint Lucia Kings'
  ];

  const footballLeagues = [
    'International Friendly', 'Premier League', 'La Liga', 'Champions League', 'World Cup Qualifiers',
    'Bundesliga', 'Serie A', 'Ligue 1', 'Saudi Pro League', 'MLS', 'Copa Libertadores'
  ];
  const cricketLeagues = [
    'World Cup Series', 'IPL 2024', 'BPL 2024', 'T20 International', 'Test Series', 'ODI World Cup',
    'Big Bash League', 'Caribbean Premier League', 'Asia Cup', 'Champions Trophy'
  ];

  const matchesToAdd = [];
  const now = new Date();

  // Generate 15 Football matches for the next week
  for (let i = 1; i <= 15; i++) {
    const teamA = footballTeams[Math.floor(Math.random() * footballTeams.length)];
    let teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];
    while (teamA === teamB) teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];

    const league = footballLeagues[Math.floor(Math.random() * footballLeagues.length)];
    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + Math.floor(Math.random() * 7) + 1);
    matchDate.setHours(12 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 4) * 15, 0, 0);

    matchesToAdd.push({
      title: `${teamA} vs ${teamB} - ${league}`,
      sport: 'football',
      team_a: teamA,
      team_b: teamB,
      match_date: matchDate
    });
  }

  // Generate 15 Cricket matches for the next week
  for (let i = 1; i <= 15; i++) {
    const teamA = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
    let teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
    while (teamA === teamB) teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];

    const league = cricketLeagues[Math.floor(Math.random() * cricketLeagues.length)];
    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + Math.floor(Math.random() * 7) + 1);
    matchDate.setHours(8 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 4) * 15, 0, 0);

    matchesToAdd.push({
      title: `${teamA} vs ${teamB} - ${league}`,
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
