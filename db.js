const { Pool } = require('pg');

const pool = new Pool({
 connectionString: 'postgresql://livo_db_opct_user:OFAhdQSwR626wwICIiBMkCIYbTG2Gyvw@dpg-d8ghl7rbc2fs73ej8k70-a.oregon-postgres.render.com/livo_db_opct',
 ssl: { rejectUnauthorized: false }
});

const initDB = async () => {
 let client;
 try {
   client = await pool.connect();
   await client.query(`
     CREATE TABLE IF NOT EXISTS users (
       id SERIAL PRIMARY KEY,
       username VARCHAR(50) UNIQUE NOT NULL,
       email VARCHAR(100) UNIQUE NOT NULL,
       password VARCHAR(255) NOT NULL,
       coins INTEGER DEFAULT 500,
       total_points INTEGER DEFAULT 0,
       avatar VARCHAR(255) DEFAULT '/img/default-avatar.png',
       role VARCHAR(20) DEFAULT 'user',
       referral_code VARCHAR(20) UNIQUE,
       is_banned BOOLEAN DEFAULT false,
       last_bonus_date DATE,
       created_at TIMESTAMP DEFAULT NOW()
     );
     CREATE TABLE IF NOT EXISTS matches (
       id SERIAL PRIMARY KEY,
       title VARCHAR(200) NOT NULL,
       sport VARCHAR(50) NOT NULL,
       team_a VARCHAR(100) NOT NULL,
       team_b VARCHAR(100) NOT NULL,
       match_date TIMESTAMP NOT NULL,
       status VARCHAR(20) DEFAULT 'upcoming',
       result VARCHAR(20),
       score_a INTEGER,
       score_b INTEGER,
       stream_url VARCHAR(500),
       created_at TIMESTAMP DEFAULT NOW()
     );
     CREATE TABLE IF NOT EXISTS predictions (
       id SERIAL PRIMARY KEY,
       user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
       match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
       predicted_winner VARCHAR(100) NOT NULL,
       coins_bet INTEGER NOT NULL,
       status VARCHAR(20) DEFAULT 'pending',
       points_earned INTEGER DEFAULT 0,
       created_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(user_id, match_id)
     );
     CREATE TABLE IF NOT EXISTS tournaments (
       id SERIAL PRIMARY KEY,
       name VARCHAR(200) NOT NULL,
       sport VARCHAR(50) NOT NULL,
       description TEXT,
       entry_fee INTEGER DEFAULT 0,
       prize_pool INTEGER DEFAULT 0,
       max_participants INTEGER DEFAULT 100,
       start_date TIMESTAMP NOT NULL,
       end_date TIMESTAMP NOT NULL,
       status VARCHAR(20) DEFAULT 'upcoming',
       created_at TIMESTAMP DEFAULT NOW()
     );
     CREATE TABLE IF NOT EXISTS tournament_participants (
       id SERIAL PRIMARY KEY,
       tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
       user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
       points INTEGER DEFAULT 0,
       joined_at TIMESTAMP DEFAULT NOW(),
       UNIQUE(tournament_id, user_id)
     );
     CREATE TABLE IF NOT EXISTS coin_transactions (
       id SERIAL PRIMARY KEY,
       user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
       amount INTEGER NOT NULL,
       type VARCHAR(50) NOT NULL,
       description VARCHAR(255),
       status VARCHAR(20) DEFAULT 'completed',
       txid VARCHAR(100),
       method VARCHAR(50),
       created_at TIMESTAMP DEFAULT NOW()
     );
     CREATE TABLE IF NOT EXISTS notifications (
       id SERIAL PRIMARY KEY,
       user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
       title VARCHAR(200) NOT NULL,
       message TEXT NOT NULL,
       is_read BOOLEAN DEFAULT false,
       type VARCHAR(50) DEFAULT 'info',
       created_at TIMESTAMP DEFAULT NOW()
     );
     CREATE TABLE IF NOT EXISTS news (
       id SERIAL PRIMARY KEY,
       title VARCHAR(300) NOT NULL,
       content TEXT NOT NULL,
       image VARCHAR(255),
       sport VARCHAR(50),
       author_id INTEGER REFERENCES users(id),
       views INTEGER DEFAULT 0,
       created_at TIMESTAMP DEFAULT NOW()
     );
     CREATE TABLE IF NOT EXISTS payment_requests (
       id SERIAL PRIMARY KEY,
       user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
       type VARCHAR(20) NOT NULL,
       method VARCHAR(50) NOT NULL,
       amount INTEGER NOT NULL,
       transaction_id VARCHAR(100),
       account_number VARCHAR(50) NOT NULL,
       status VARCHAR(20) DEFAULT 'pending',
       updated_at TIMESTAMP,
       created_at TIMESTAMP DEFAULT NOW()
     );
   `);

   // নতুন কলাম যোগ (আগের database এর জন্য)
   await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE`);

   console.log('✅ Database ready');
 } catch (err) {
   console.error('❌ Database connection failed:', err.message);
 } finally {
   if (client) client.release();
 }
};

module.exports = { pool, initDB };
