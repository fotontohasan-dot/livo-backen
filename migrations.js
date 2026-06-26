const { pool } = require('./db');

async function runMigrations() {
  try {
    console.log("🚀 Running database migrations...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id SERIAL PRIMARY KEY,
        match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        name TEXT NOT NULL,
        odds JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        match_id INTEGER REFERENCES matches(id),
        market_id INTEGER REFERENCES markets(id),
        market_type VARCHAR(50),
        runner TEXT,
        odd NUMERIC(10,2),
        stake INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER,
        receiver_id INTEGER,
        message TEXT,
        is_admin BOOLEAN DEFAULT false,
        file_url TEXT,
        file_type VARCHAR(20),
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_sender ON chat_messages(sender_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_receiver ON chat_messages(receiver_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS news (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        image_url TEXT,
        sport VARCHAR(50),
        author_id INTEGER,
        views INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kyc_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        full_name TEXT NOT NULL,
        document_type VARCHAR(50),
        document_number TEXT,
        document_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id SERIAL PRIMARY KEY,
        message TEXT,
        stack TEXT,
        url TEXT,
        method VARCHAR(10),
        user_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_user ON login_logs(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_login_ip ON login_logs(ip);`);

    // ==================== বোনাস / টার্নওভার টেবিল ====================
    // এক টেবিলেই সব বোনাস: ডিপোজিট বোনাস ও দৈনিক রিওয়ার্ড।
    // bonus_type = 'deposit'  → sports = bonus×5,  casino = bonus×35
    // bonus_type = 'daily'    → sports = bonus×3,  casino = 0 (শুধু স্পোর্টস)
    // উইথড্রর সময় কোনো 'active' বোনাস থাকলে উইথড্র আটকাবে।
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bonuses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        bonus_type VARCHAR(20) NOT NULL,          -- 'deposit' বা 'daily'
        bonus_amount INTEGER NOT NULL,            -- বোনাসের পরিমাণ
        sports_required NUMERIC(12,2) DEFAULT 0,  -- স্পোর্টস টার্নওভার দরকার
        sports_done NUMERIC(12,2) DEFAULT 0,      -- স্পোর্টসে এ পর্যন্ত হয়েছে
        casino_required NUMERIC(12,2) DEFAULT 0,  -- ক্যাসিনো টার্নওভার দরকার
        casino_done NUMERIC(12,2) DEFAULT 0,      -- ক্যাসিনোতে এ পর্যন্ত হয়েছে
        status VARCHAR(20) DEFAULT 'active',       -- active / completed / cancelled
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bonus_user ON bonuses(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bonus_status ON bonuses(status);`);

    // users টেবিলে নতুন কলাম
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS last_login TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_ip TEXT,
      ADD COLUMN IF NOT EXISTS last_device TEXT,
      ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS admin_note TEXT,
      ADD COLUMN IF NOT EXISTS last_reward_date DATE;
    `);

    await pool.query(`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS start_time TIMESTAMP,
      ADD COLUMN IF NOT EXISTS league TEXT;
    `);

    console.log("✅ All tables migration completed successfully");
  } catch (err) {
    console.error("❌ Migration error:", err.message);
  }
}

module.exports = runMigrations;
