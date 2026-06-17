require('dotenv').config();
const process = require('node:process');
const express = require('express');
const http = require('http');
const { initSocket } = require('./services/socket');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const { connectDB, pool } = require('./db');
const { syncMatches } = require('./services/matchUpdater');

const app = express();
const server = http.createServer(app);
initSocket(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'livo-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.currentPage = req.path === '/' ? 'home' : req.path.split('/')[1] || '';
  next();
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.use('/', require('./routes/auth'));
app.use('/matches', require('./routes/matches'));
app.use('/tournaments', require('./routes/tournaments'));
app.use('/coins', require('./routes/coins'));
app.use('/news', require('./routes/news'));
app.use('/profile', require('./routes/profile'));
app.use('/leaderboard', require('./routes/leaderboard'));
app.use('/admin', require('./routes/admin'));
app.use('/notifications', require('./routes/notifications'));
app.use('/payment', require('./routes/payment'));
app.use('/games', require('./routes/games'));
app.use('/chat', require('./routes/chat'));

app.get('/app/update', (req, res) => res.render('app/update'));

app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err.stack);
  res.status(500).render('error', {
    user: req.session?.user || null,
    message: 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।'
  });
});

const PORT = process.env.PORT || 3000;

async function migrateDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'user',
          coins INT DEFAULT 500,
          total_points INT DEFAULT 0,
          avatar TEXT,
          referral_code VARCHAR(20) UNIQUE,
          is_banned BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS matches (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255),
          sport VARCHAR(50),
          team_a VARCHAR(100),
          team_b VARCHAR(100),
          match_date TIMESTAMP,
          status VARCHAR(20) DEFAULT 'upcoming',
          winner VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS predictions (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users(id),
          match_id INT REFERENCES matches(id),
          predicted_winner VARCHAR(100),
          coins_bet INT,
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, match_id)
      );
      CREATE TABLE IF NOT EXISTS coin_transactions (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users(id),
          amount INT,
          type VARCHAR(50),
          description TEXT,
          created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
          id SERIAL PRIMARY KEY,
          sender_id INT REFERENCES users(id),
          receiver_id INT REFERENCES users(id),
          message TEXT,
          is_admin BOOLEAN DEFAULT false,
          file_url TEXT,
          file_type VARCHAR(20),
          created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users(id),
          title VARCHAR(255),
          message TEXT,
          is_read BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tournaments (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255),
          description TEXT,
          entry_fee INT,
          prize_pool INT,
          start_date TIMESTAMP,
          status VARCHAR(20) DEFAULT 'upcoming',
          created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tournament_participants (
          id SERIAL PRIMARY KEY,
          tournament_id INT REFERENCES tournaments(id),
          user_id INT REFERENCES users(id),
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(tournament_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS news (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          image_url TEXT,
          created_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS file_url TEXT;
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS file_type VARCHAR(20);
    `);
    console.log('✅ DB migration and schema initialization done');
  } catch (err) {
    console.error('Migration error:', err.message);
  }
}

connectDB().then(async () => {
  await migrateDB();
  server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    setTimeout(() => {
      syncMatches().catch(err => console.error('Initial match sync failed:', err));
    }, 3000);
    setInterval(async () => {
      try { await syncMatches(); } catch (err) { console.error(err); }
    }, 24 * 60 * 60 * 1000);
  });
}).catch((err) => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});

module.exports = app;
