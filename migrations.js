const db = require('./db');

async function runMigrations() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id SERIAL PRIMARY KEY,
        match_id INTEGER REFERENCES matches(id),
        type VARCHAR(50),           -- bookmaker or fancy
        name TEXT,
        odds JSONB,
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        match_id INTEGER REFERENCES matches(id),
        market_type VARCHAR(50),
        runner TEXT,
        odd NUMERIC,
        stake INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ Markets & Bets tables created successfully");
  } catch (err) {
    console.error("Migration error:", err);
  }
}

module.exports = runMigrations;
