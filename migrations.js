const { pool } = require('./db');

async function runMigrations() {
  try {
    console.log("🚀 Running database migrations...");

    // Existing code...

    // ==================== API KEY MANAGEMENT ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        key_hash TEXT UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        scopes TEXT[] DEFAULT '{}',
        enabled BOOLEAN DEFAULT true,
        expires_at TIMESTAMP,
        last_used TIMESTAMP,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at);`);

    console.log("✅ API Keys table migration completed");

    // ... rest of existing migrations ...

  } catch (err) {
    console.error("❌ Migration error:", err.message);
  }
}

module.exports = runMigrations;
