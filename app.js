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

// ভাষা (বাংলা / ইংরেজি)
const translations = {
  bn: {
    balance: 'ব্যালেন্স', deposit: 'ডিপোজিট', withdraw: 'উইথড্র',
    login: 'লগইন', register: 'রজিস্টার', logout: 'লগআউট',
    home: 'হোম', invite: 'আমন্ত্রণ', promotion: 'প্রমোশন', support: 'সবা', member: 'সদস্য',
    menu_home: 'হোম', menu_aviator: 'Aviator', menu_slots: 'Slots', menu_color: 'Color Prediction',
    menu_sports: 'সর্টস', menu_tournament: 'টুর্নামেন্ট', menu_deposit: 'ডিপোজিট', menu_withdraw: 'উইথড্র',
    menu_leaderboard: 'লিডারবোর্ড', menu_news: 'নিউজ', menu_profile: 'প্রোফাইল', menu_admin: 'এডমিন প্যানেল'
  },
  en: {
    balance: 'Balance', deposit: 'Deposit', withdraw: 'Withdraw',
    login: 'Login', register: 'Register', logout: 'Logout',
    home: 'Home', invite: 'Invite', promotion: 'Promotion', support: 'Support', member: 'Profile',
    menu_home: 'Home', menu_aviator: 'Aviator', menu_slots: 'Slots', menu_color: 'Color Prediction',
    menu_sports: 'Sports', menu_tournament: 'Tournament', menu_deposit: 'Deposit', menu_withdraw: 'Withdraw',
    menu_leaderboard: 'Leaderboard', menu_news: 'News', menu_profile: 'Profile', menu_admin: 'Admin Panel'
  }
};

app.get('/lang/:code', (req, res) => {
  req.session.lang = req.params.code === 'en' ? 'en' : 'bn';
  res.redirect(req.get('Referer') || '/');
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.lang = req.session.lang || 'bn';
  res.locals.t = translations[res.locals.lang];
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
    message: 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।'
  });
});

app.use((req, res) => {
  res.status(404).render('error', { message: 'পেজটি পাওয়া যাযনি।' });
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
        coins INT DEFAULT 0,
        total_points INT DEFAULT 0,
        avatar TEXT,
        referral_code VARCHAR(20) UNIQUE,
        is_banned BOOLEAN DEFAULT false,
        last_bonus_date DATE,
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
        result VARCHAR(20),
        score_a INTEGER,
        score_b INTEGER,
        stream_url VARCHAR(500),
        winner VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        match_id INT REFERENCES matches(id) ON DELETE CASCADE,
        predicted_winner VARCHAR(100),
        coins_bet INT,
        status VARCHAR(20) DEFAULT 'pending',
        points_earned INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, match_id)
      );
      CREATE TABLE IF NOT EXISTS coin_transactions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        amount INT,
        type VARCHAR(50),
        description TEXT,
        status VARCHAR(20) DEFAULT 'completed',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255),
        message TEXT,
        is_read BOOLEAN DEFAULT false,
        type VARCHAR(50) DEFAULT 'info',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        sport VARCHAR(50),
        description TEXT,
        entry_fee INT DEFAULT 0,
        prize_pool INT DEFAULT 0,
        max_participants INT DEFAULT 100,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        status VARCHAR(20) DEFAULT 'upcoming',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tournament_participants (
        id SERIAL PRIMARY KEY,
        tournament_id INT REFERENCES tournaments(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        points INT DEFAULT 0,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tournament_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS news (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT,
        sport VARCHAR(50),
        views INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payment_requests (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        method VARCHAR(50),
        amount INT NOT NULL,
        transaction_id VARCHAR(100),
        account_number VARCHAR(50),
        status VARCHAR(20) DEFAULT 'pending',
        updated_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        sender_id INT REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INT REFERENCES users(id) ON DELETE CASCADE,
        message TEXT,
        is_admin BOOLEAN DEFAULT false,
        file_url TEXT,
        file_type VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bonus_date DATE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20) UNIQUE;
      ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS result VARCHAR(20);
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_a INTEGER;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_b INTEGER;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS stream_url VARCHAR(500);
      ALTER TABLE predictions ADD COLUMN IF NOT EXISTS points_earned INT DEFAULT 0;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'info';
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS name VARCHAR(255);
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS sport VARCHAR(50);
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS end_date TIMESTAMP;
      ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS max_participants INT DEFAULT 100;
      ALTER TABLE tournament_participants ADD COLUMN IF NOT EXISTS points INT DEFAULT 0;
      ALTER TABLE tournament_participants ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE coin_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed';
    `);

    console.log('✅ DB migration done');
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
