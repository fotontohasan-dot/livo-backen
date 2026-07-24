require('dotenv').config();
const process = require('node:process');

// ==================== প্রসেস-লেভেল ক্র্যাশ গার্ড ====================
// কোনো একটা জায়গায় unhandled promise rejection হলে Node.js (v15+) ডিফল্টভাবে
// পুরো প্রসেস বন্ধ করে দেয় — তখন Render/হোস্টিং প্ল্যাটফর্মের জেনেরিক
// "Internal Server Error" পেজ দেখা যায় যতক্ষণ না প্রসেস আবার রিস্টার্ট হয়।
// এখানে সেটা আটকে শুধু লগ করে সার্ভার চালু রাখা হচ্ছে।
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err && err.stack ? err.stack : err);
});

const express = require('express');
const http = require('http');
const { initSocket } = require('./services/socket');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const flash = require('connect-flash');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const { connectDB, pool } = require('./db');
const { syncMatches } = require('./services/matchUpdater');
const runMigrations = require('./migrations');
const { apiGateway, responseHelpers } = require('./middleware/gateway');
const { scheduleDailyBackup } = require('./services/backup');
const { touchDeviceActivity } = require('./services/deviceTracking');
require('./services/cache'); // অ্যাপ বুট হওয়ার সাথে সাথেই Redis কানেকশন অ্যাটেম্পট শুরু হয় (কানেক্ট না হলেও অ্যাপ চলতে থাকে)

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

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
  imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com", "https://i.pravatar.cc", "https://img.icons8.com", "https://i.postimg.cc"],
  mediaSrc: ["'self'", "https://res.cloudinary.com"],
  connectSrc: ["'self'", "wss:", "ws:"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};
if (process.env.NODE_ENV === 'production') {
  cspDirectives.upgradeInsecureRequests = [];
}

const isProdEnv = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  // Cloudinary/Google Fonts/CDN-এর মতো ক্রস-অরিজিন রিসোর্স লোড করতে হয় বলে
  // COEP বন্ধ রাখা হয়েছে — এটা চালু থাকলে ওই রিসোর্সগুলো ব্লক হয়ে যেত।
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // শুধু production-এ HTTPS-এ চালু (লোকাল HTTP ডেভেলপমেন্ট যেন ভেঙে না যায়)
  hsts: isProdEnv ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  frameguard: { action: 'sameorigin' }, // X-Frame-Options — নিজের সাইট ছাড়া কোথাও iframe-এ embed হবে না (clickjacking প্রতিরোধ)
  noSniff: true, // X-Content-Type-Options: nosniff
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, // পেমেন্ট/অ্যাডমিন পেজের সংবেদনশীল URL বাইরে leak হবে না, কিন্তু নিজের সাইটে ও same-origin নেভিগেশনে referrer ঠিকঠাক যাবে
}));
// Permissions-Policy — helmet v6+ এ বিল্ট-ইন নেই, তাই ম্যানুয়ালি সেট করা হচ্ছে।
// এই সাইট ক্যামেরা/মাইক্রোফোন/জিওলোকেশন কিছুই ব্যবহার করে না, তাই সব বন্ধ; পেমেন্ট ফ্লো নিজের অরিজিনে চলে বলে payment=(self) রাখা হলো।
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), payment=(self), fullscreen=(self)'
  );
  next();
});
// লিগ্যাসি ব্রাউজারের জন্য X-XSS-Protection (আধুনিক ব্রাউজার CSP-ই যথেষ্ট মানে, হেডারটা ignore করে,
// কিন্তু পুরনো ব্রাউজার সাপোর্টের জন্য স্ট্যান্ডার্ড হিসেবে রাখা হলো)
app.use((req, res, next) => {
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ==================== CORS ====================
// কাস্টম ডোমেইন এখনো কেনা হয়নি, তাই আপাতত Render subdomain + লোকাল ডেভেলপমেন্ট origin-ই অনুমোদিত।
// কাস্টম ডোমেইন কেনা হলে ALLOWED_ORIGINS-এ যোগ করে দিতে হবে।
const ALLOWED_ORIGINS = [
  'https://livo-backen.onrender.com',
  'http://localhost:3000',
];
const LOCALHOST_ANY_PORT = /^http:\/\/localhost:\d+$/;

app.use(cors({
  origin(origin, callback) {
    // origin হেডার ছাড়া বা "null" (sandboxed webview/in-app browser) রিকোয়েস্ট অনুমোদিত
    if (!origin || origin === 'null') return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || LOCALHOST_ANY_PORT.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true, // session cookie পাঠাতে/পেতে দরকার
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
}));
app.disable('x-powered-by');
const sessionStore = process.env.DATABASE_URL ? new pgSession({
  pool: pool,
  tableName: 'user_sessions',
  createTableIfMissing: true
}) : undefined;

const isProd = process.env.NODE_ENV === 'production';
const sessionMiddleware = session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax'
  }
});
app.use(sessionMiddleware);

// session middleware রেডি হওয়ার পর socket.io ইনিশিয়ালাইজ করা হচ্ছে,
// যাতে socket connection-এও একই লগইন session ব্যবহার করে ইউজার/অ্যাডমিন যাচাই করা যায়
initSocket(server, sessionMiddleware);

app.use(flash());

const RedisRateLimitStore = require('./services/redisRateLimitStore');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'অনেকবার চেষ্টা করেছেন। ১৫ মিনিট পর আবার চেষ্টা করুন।',
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:login:')
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:general:')
});

// ডিপোজিট/উইথড্র/কার্ড/পাসওয়ার্ড — টাকা-সংক্রান্ত ও অ্যাকাউন্ট-সংবেদনশীল রুটে কড়া রেট-লিমিট
const financialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'অনেকবার চেষ্টা করেছেন। কিছুক্ষণ পর আবার চেষ্টা করুন।',
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:financial:')
});

app.use(generalLimiter);
app.use('/login', loginLimiter);
app.use('/register', loginLimiter);
app.use('/admin/login', loginLimiter);
app.use('/payment/deposit', financialLimiter);
app.use('/payment/withdraw', financialLimiter);
app.use('/profile/add-bank-card', financialLimiter);
app.use('/profile/change-password', financialLimiter);
app.use('/profile/update', financialLimiter);
app.use('/profile/update-personal', financialLimiter);

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

  // ডিভাইস "last activity" আপডেট — থ্রটলড, নন-ব্লকিং, লগইন করা ইউজারের জন্যই শুধু
  if (req.session && req.session.user) {
    touchDeviceActivity(req).catch(() => {});
  }

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

// ==================== /ready — গভীর readiness চেক (DB/Redis/Queue/Email/Disk/Memory/Uptime) ====================
// /health থেকে আলাদা রাখা হয়েছে ইচ্ছাকৃতভাবে: /health শুধু "প্রসেস চালু আছে কিনা" দেখে (দ্রুত, নির্ভরতাহীন),
// আর /ready দেখে "সত্যিকারের ট্রাফিক সার্ভ করার মতো প্রস্তুত কিনা"। Docker/K8s-এ দুটোর ভূমিকা আলাদা —
// dependency (DB) সাময়িক ধীর হলে /health ঠিক থাকলে কন্টেইনার restart-loop এ পড়ে না, শুধু ট্রাফিক থেকে বাদ পড়ে।
app.get('/ready', async (req, res) => {
  try {
    const result = await require('./services/healthCheck').runDiagnostics();
    const httpStatus = result.status === 'error' ? 503 : 200;
    res.status(httpStatus).json(result);
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message, timestamp: new Date().toISOString() });
  }
});
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

// ==================== MAINTENANCE MODE ====================
// অ্যাডমিন প্যানেল, পেমেন্ট গেটওয়ে callback, টেলিগ্রাম webhook, আর স্ট্যাটিক ফাইল
// সবসময় চালু থাকবে — বিস্তারিত middleware/maintenance.js এ।
const { maintenanceMiddleware } = require('./middleware/maintenance');
app.use(maintenanceMiddleware);

// ==================== ROUTES ====================
app.use('/', require('./routes/auth'));
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
app.use('/api', require('./routes/api'));
app.use('/extra', require('./routes/extra'));
// ===============================================

app.get('/app/update', (req, res) => res.render('app/update'));

// Telegram Bot Webhook
const { handleMessage, verifyWebhookSecret } = require('./telegram-bot');
app.post('/telegram-webhook', express.json(), async (req, res) => {
  try {
    // নিরাপত্তা: Telegram থেকে সত্যিই এসেছে কিনা যাচাই করা হচ্ছে।
    // এই header Telegram নিজে পাঠায় যদি setWebhook-এ secret_token দেওয়া থাকে।
    // এটা না মিললে request বাতিল — এই বট GitHub-এ সরাসরি write করতে পারে,
    // তাই এই চেক ছাড়া যে কেউ URL-এ POST করে কোড এডিট করাতে পারত।
    const incomingSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (!verifyWebhookSecret(incomingSecret)) {
      console.warn('⚠️ /telegram-webhook: অবৈধ বা অনুপস্থিত secret token — request বাতিল।');
      return res.sendStatus(401);
    }

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

  // fetch/AJAX/API কলে HTML পেজ ফেরত পাঠালে client-side JSON.parse ভেঙে যায়,
  // তাই সেসব ক্ষেত্রে JSON error দেওয়া হচ্ছে — raw error message/stack কখনোই client-এ যাচ্ছে না
  const wantsJson = req.xhr
    || (req.headers.accept && req.headers.accept.includes('application/json'))
    || req.path.startsWith('/api')
    || (req.headers['content-type'] || '').includes('json');
  if (wantsJson) {
    return res.status(500).json({ success: false, message: serverErrorMsg });
  }

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

    // ব্যাকগ্রাউন্ড জব কিউ ওয়ার্কার — try/catch দিয়ে মোড়ানো যাতে ব্যর্থ হলেও সার্ভার বুট আটকে না যায়
    try {
      require('./services/queueHandlers'); // হ্যান্ডলার রেজিস্টার করে
      require('./services/queue').startWorker();
    } catch (qErr) {
      console.error('⚠️ Queue worker start failed (site continues normally, jobs will just queue up):', qErr.message);
    }

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
