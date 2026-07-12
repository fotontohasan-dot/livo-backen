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
const runMigrations = require('./migrations');
const { apiGateway, responseHelpers } = require('./middleware/gateway');
const { scheduleDailyBackup } = require('./services/backup');

const app = express();
app.use(compression());
const server = http.createServer(app);

app.set('trust proxy', 1);

const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️ SESSION_SECRET সেট করা নেই — সাময়িক র‍্যানম সিক্রেট ব্যবহার হচ্ছে। প্রোডকশনে অবশ্যই SESSION_SECRET সেট করুন।');
}


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '0',
  etag: false
}));


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '0',
  etag: false
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  },
}));
const sessionStore = process.env.DATABASE_URL ? new pgSession({
  pool: pool,
  tableName: 'user_sessions',
  createTableIfMissing: true
}) : undefined;

const sessionMiddleware = session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
});
app.use(sessionMiddleware);

// session middleware রেডি হওয়ার পর socket.io ইনিশিয়ালাইজ করা হচ্ছে,
// যাতে socket connection-এও একই লগইন session ব্যবহার করে ইউজার/অ্যাডমিন যাচাই করা যায়
initSocket(server, sessionMiddleware);

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
  bn: require('./locales/bn.json'),
  en: require('./locales/en.json')
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
  const t_func = (key) => translations[lang][key] || key;
  // Proxy allow both t('key') and t.key
  res.locals.t = new Proxy(t_func, {
    get: (target, prop) => translations[lang][prop] || prop
  });
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
app.get('/kyc', (req, res) => res.redirect('/extra/kyc'));
app.get('/rules', (req, res) => res.render('rules'));

// ==================== CSRF সুরক্ষা (Origin যাচাই) ====================
app.use((req, res, next) => {
  if (req.path.startsWith('/payment/sslcommerz/')) return next(); // গেটওয়ে ভিন্ন ডোমেইন থেকে POST করে
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
  const host = req.get('host');
  const origin = req.get('origin');
  // শুধু Origin থাকলে এবং ভুল হলে আটকাবে; না থাকলে ছেড়ে দেবে
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).send('Invalid request origin');
      }
    } catch (e) {}
  }
  return next();
});

// ==================== API GATEWAY ====================
app.use(responseHelpers);
app.use(apiGateway);
// =======================================================

// ==================== ROUTES ====================
app.use('/', require('./routes/auth'));
app.use('/setup', require('./routes/setup'));
app.use('/matches', require('./routes/matches'));
app.use('/sports', require('./routes/sports'));
app.use('/tournaments', require('./routes/tournaments'));
app.get('/promotions', (req, res) => res.render('promotions', { currentPage: 'promotion' }));

// ==================== Bonus (দৈনিক রিওয়ার্ড ভাউচার) ====================
// প্রতিদিন রাত ১২টায় (Asia/Dhaka) অটোমেটিক রিসেট হয় — সার্ভার থেকে পরবর্তী মধ্যরাতের
// সময় পাঠানো হয়, ক্লায়েন্ট সাইডে প্রতি সেকেন্ডে কাউন্টডাউন আপডেট হয় (views/bonus.ejs দেখুন)।
// বোনাস (লাকি হুইল, সোনার ডিম, রেড কার্ড) এখন প্রোফাইল → Reward Center পেজের ভেতরেই
// ইন্টিগ্রেটেড (দেখুন views/profile/rewards.ejs) — পুরনো /bonus লিংক ওখানেই রিডিরেক্ট করে।
app.get('/bonus', (req, res) => res.redirect('/profile/rewards'));

app.use('/coins', require('./routes/coins'));
app.use('/news', require('./routes/news'));
app.use('/profile', require('./routes/profile'));
app.use('/leaderboard', require('./routes/leaderboard'));
app.use('/admin', require('./routes/admin'));
app.use('/notifications', require('./routes/notifications'));
app.use('/help-center', require('./routes/help-center'));
app.use('/payment', require('./routes/payment'));
app.use('/games', require('./routes/games'));
app.use('/accumulator', require('./routes/accumulator'));
app.use('/chat', require('./routes/chat'));
app.use('/extra', require('./routes/extra'));
// ===============================================

app.get('/app/update', (req, res) => res.render('app/update'));

// Telegram Bot Webhook
const { handleMessage } = require('./telegram-bot');
app.post('/telegram-webhook', express.json(), async (req, res) => {
  try {
    const { message } = req.body;
    if (message) await handleMessage(message);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200);
  }
});

// Error Handling
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err.stack);
  pool.query(
    `INSERT INTO error_logs (message, stack, url, method, user_id) VALUES ($1, $2, $3, $4, $5)`,
    [
      err.message || 'Unknown error',
      err.stack || null,
      req.originalUrl || null,
      req.method || null,
      (req.session && req.session.user) ? req.session.user.id : null
    ]
  ).catch(() => {});

  const serverErrorMsg = (res.locals && res.locals.t && res.locals.t.server_error) ? res.locals.t.server_error : 'Server Error / সার্ভার ত্রুটি';
  res.status(500).render('error', {
    message: serverErrorMsg,
    siteName: 'Livo'
  });
});

app.use((req, res) => {
  const notFoundMsg = (res.locals && res.locals.t && res.locals.t.page_not_found) ? res.locals.t.page_not_found : 'Page Not Found / পৃষ্ঠাটি পাওয়া যায়নি';
  res.status(404).render('error', {
    message: notFoundMsg,
    siteName: 'Livo'
  });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await connectDB();
    console.log("✅ PostgreSQL connected successfully");

    await runMigrations();
    console.log("✅ DB migration done");

    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      setTimeout(() => {
        syncMatches().catch(err => console.error('Initial match sync failed:', err));
      }, 3000);
      scheduleDailyBackup();
    });
  } catch (err) {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
  }
}

startServer();
module.exports = app;
