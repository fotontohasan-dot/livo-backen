const { pool } = require('../db');

/**
 * Stub for syncMatches function.
 * In a real scenario, this would fetch matches from an external API and update the database.
 */
async function syncMatches() {
  console.log('syncMatches stub called');
  // Return 0 added matches for now
  return 0;
}

module.exports = { syncMatches };
