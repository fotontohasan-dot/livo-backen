require('dotenv').config();
const process = require('node:process');
const express = require('express');
const http = require('http');
const { initSocket } = require('./services/socket');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const flash = require('connect-flash');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const { connectDB, pool } = require('./db');
const { syncMatches } = require('./services/matchUpdater');

const app = express();
const server = http.createServer(app);
initSocket(server);

app.use(compression());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  },
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '0',
  etag: false
}));

app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'livo-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(flash());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'অনেকবার চেষ্টা করেছেন। ১৫ মিনিট পর আবার চেষ্টা করুন।',
  standardHeaders: true,
  legacyHeaders: false
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);
app.use('/login', loginLimiter);
app.use('/register', loginLimiter);

// ভাষা সেটিং
const translations = {
  bn: {
    balance: 'ব্যালেন্স', deposit: 'ডিপোজিট', withdraw: 'উইথড্র',
    login: 'লগইন', register: 'রজিস্টার', logout: 'লগআউট',
    home: 'হোম', invite: 'আমন্ত্রণ', promotion: 'প্রমোশন', support: 'সেবা', member: 'সদস্য',
    menu_home: 'হোম', menu_aviator: 'Aviator', menu_slots: 'Slots', menu_color: 'Color Prediction',
    menu_sports: 'স্পোর্টস', menu_tournament: 'টুর্নামেন্ট', menu_deposit: 'ডিপোজিট', menu_withdraw: 'উইথড্র',
    menu_leaderboard: 'লিডারবোর্ড', menu_news: 'নিউজ', menu_profile: 'প্রোফাইল', menu_admin: 'এডমিন পনেল'
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
  res.locals.baseUrl = req.protocol + '://' + req.get('host');
  res.locals.user = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');

  const lang = req.session.lang === 'en' ? 'en' : 'bn';
  res.locals.t = translations[lang];
  res.locals.lang = lang;
  res.locals.siteName = 'Livo';

  const pathParts = req.path.split('/').filter(Boolean);
  let page = 'home';
  if (pathParts.length > 0) {
    if (pathParts[0] === 'extra') page = pathParts[1] || 'home';
    else page = pathParts[0];
  }
  res.locals.currentPage = page;

  next();
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms', (req, res) => res.render('terms'));
app.get('/kyc', (req, res) => res.render('kyc'));
app.get('/rules', (req, res) => res.render('rules'));

// ==================== ROUTES ====================
app.use('/', require('./routes/auth'));
app.use('/matches', require('./routes/matches'));
app.use('/sports', require('./routes/sports'));           // ← Sports Route যোগ করা হয়েছে
app.use('/tournaments', require('./routes/tournaments'));
app.get('/promotions', (req, res) => res.render('promotions', { currentPage: 'promotion' }));
app.use('/coins', require('./routes/coins'));
app.use('/news', require('./routes/news'));
app.use('/profile', require('./routes/profile'));
app.use('/leaderboard', require('./routes/leaderboard'));
app.use('/admin', require('./routes/admin'));
app.use('/notifications', require('./routes/notifications'));
app.use('/payment', require('./routes/payment'));
app.use('/games', require('./routes/games'));
app.use('/chat', require('./routes/chat'));
app.use('/extra', require('./routes/extra'));
// ===============================================

app.get('/app/update', (req, res) => res.render('app/update'));

app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err.stack);
  res.status(500).render('error', {
    message: 'সার্ভার সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।',
    siteName: 'Livo'
  });
});

app.use((req, res) => {
  res.status(404).render('error', {
    message: 'পেজটি পাওয়া যায়নি।',
    siteName: 'Livo'
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
          referred_by_id INT REFERENCES users(id),
          is_banned BOOLEAN DEFAULT false,
          last_bonus_date TIMESTAMP,
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
          result VARCHAR(50),
          score_a TEXT,
          score_b TEXT,
          overs TEXT,
          created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // পুরোনো টেবিলে কলাম না থাকলে যোগ করা (এই অংশটা নতুন)
    await pool.query(`
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS overs TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_a TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_b TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS result VARCHAR(50);
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS winner VARCHAR(100);
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_date TIMESTAMP;
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
  });
}).catch((err) => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});

module.exports = app;
