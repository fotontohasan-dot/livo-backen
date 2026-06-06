const { pool } = require('../db');

/**
 * syncMatches function.
 * In a production scenario, this would fetch matches from an external API.
 * For now, it populates the database with some realistic upcoming matches if they aren't already there.
 */
async function syncMatches() {
  console.log('📡 Syncing matches...');

  const mockMatches = [
    {
      title: 'ICC Champions Trophy: Bangladesh vs India',
      sport: 'Cricket',
      team_a: 'Bangladesh',
      team_b: 'India',
      match_date: new Date(Date.now() + 86400000 * 2).toISOString(), // 2 days from now
      stream_url: 'https://www.example.com/stream1'
    },
    {
      title: 'Champions League: Real Madrid vs Man City',
      sport: 'Football',
      team_a: 'Real Madrid',
      team_b: 'Man City',
      match_date: new Date(Date.now() + 86400000 * 3).toISOString(), // 3 days from now
      stream_url: 'https://www.example.com/stream2'
    },
    {
      title: 'T20 World Cup: Pakistan vs Australia',
      sport: 'Cricket',
      team_a: 'Pakistan',
      team_b: 'Australia',
      match_date: new Date(Date.now() + 86400000 * 1).toISOString(), // Tomorrow
      stream_url: 'https://www.example.com/stream3'
    }
  ];

  let addedCount = 0;

  for (const match of mockMatches) {
    try {
      // Check if match already exists (simple check by title and date)
      const existing = await pool.query(
        'SELECT id FROM matches WHERE title = $1 AND match_date = $2',
        [match.title, match.match_date]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          'INSERT INTO matches (title, sport, team_a, team_b, match_date, stream_url) VALUES ($1, $2, $3, $4, $5, $6)',
          [match.title, match.sport, match.team_a, match.team_b, match.match_date, match.stream_url]
        );
        addedCount++;
      }
    } catch (err) {
      console.error(`Error adding match ${match.title}:`, err.message);
    }
  }

  console.log(`✅ Sync complete. Added ${addedCount} new matches.`);
  return addedCount;
}

module.exports = { syncMatches };
