require('dotenv').config();
const process = require('node:process');

// ==================== Environment Variable ভ্যালিডেশন ====================
// services/envValidator.js লেখা হয়েছিল বুটের শুরুতে চলার জন্য (প্রোডাকশনে ক্রিটিক্যাল
// ভ্যারিয়েবল না থাকলে fail-fast), কিন্তু এতদিন এটা কোথাও require-ই করা হয়নি — অর্থাৎ
// সুরক্ষাটা কাগজে ছিল, বাস্তবে চলত না। dotenv-এর ঠিক পরে (কোনো ./services বা ./db
// require করার আগে) কল করা হচ্ছে, যাতে ভুল কনফিগ নিয়ে সার্ভার আদৌ উঠতে না পারে।
require('./services/envValidator').runStartupValidation();

// ==================== Sentry মনিটরিং — সবার আগে init করা হয় যাতে পরবর্তী
// সব require/middleware/route-এর এরর স্বয়ংক্রিয়ভাবে ধরা পড়ে ====================
const sentryService = require('./services/sentry');
sentryService.init();

// ==================== প্রসেস-লেভেল ক্র্যাশ গার্ড ====================
// কোনো একটা জায়গায় unhandled promise rejection হলে Node.js (v15+) ডিফল্টভাবে
// পুরো প্রসেস বন্ধ করে দেয় — তখন Render/হোস্টিং প্ল্যাটফর্মের জেনেরিক
// "Internal Server Error" পেজ দেখা যায় যতক্ষণ না প্রসেস আবার রিস্টার্ট হয়।
// এখানে সেটা আটকে শুধু লগ করে সার্ভার চালু রাখা হচ্ছে — এখন Sentry-তেও রিপোর্ট হয়।
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
  sentryService.captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err && err.stack ? err.stack : err);
  sentryService.captureException(err, { source: 'uncaughtException' });
});
process.on('SIGTERM', async () => {
  try { require('./services/queue').stopWorker(); } catch (e) {}
  try { await require('./queues').shutdownQueueSystem(); } catch (e) {}
  try { require('./services/scheduler').stop(); } catch (e) {}
  process.exit(0);
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
const { scheduleAutoBackup } = require('./services/backupManager');
const { touchDeviceActivity } = require('./services/deviceTracking');
const cookieParser = require('cookie-parser');
require('./services/cache'); // অ্যাপ বুট হওয়ার সাথে সাথেই Redis কানেকশন অ্যাটেম্পট শুরু হয় (কানেক্ট না হলেও অ্যাপ চলতে থাকে)
const queueService = require('./services/queue');
const appMetrics = require('./services/metrics');
const { requireMetricsAccess } = require('./middleware/metricsAuth');

const { backUrl } = require('./utils/redirectBack');
const app = express();
app.use(compression());
const server = http.createServer(app);

app.set('trust proxy', 1);

// services/envValidator.js (এই ফাইলের একদম শুরুতে, কোনো require-এর আগেই কল করা হয়) প্রোডাকশনে
// SESSION_SECRET অনুপস্থিত/দুর্বল থাকলে ইতিমধ্যেই process.exit(1) করে বুট আটকে দেয় — অর্থাৎ
// প্রোডাকশনে এই কোড আদৌ চলার কথা না। কিন্তু আগে এখানে "না থাকলে র‍্যান্ডম সিক্রেট বানাও" এই
// fallback-টা রাখা ছিল, যেটা নিজেই একটা সুপ্ত ঝুঁকি: যদি কখনো ভুলবশত ভ্যালিডেটর কল করা বাদ পড়ে,
// রিফ্যাক্টরে ক্রম বদলে যায়, বা কেউ import ভেঙে ফেলে — তাহলে প্রোডাকশন সাইলেন্টলি একটা এলোমেলো
// (এবং প্রতি রিস্টার্টে ভিন্ন, একাধিক ইনস্ট্যান্স চললে প্রতি ইনস্ট্যান্সেও ভিন্ন) secret নিয়ে চলতে
// শুরু করত — কোনো এরর ছাড়াই। তাই এখানে defense-in-depth হিসেবে সরাসরি hard-fail করা হচ্ছে;
// শুধু ডেভেলপমেন্টেই সুবিধার জন্য এলোমেলো (in-memory-only, প্রতি রিস্টার্টে বদলানো) secret চলে।
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ SESSION_SECRET প্রোডাকশনে সেট করা আবশ্যক — সার্ভার বুট বন্ধ করা হচ্ছে।');
    process.exit(1);
  }
  SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
  console.warn('⚠️ SESSION_SECRET সেট করা নেই — শুধুমাত্র ডেভেলপমেন্টের জন্য সাময়িক র‍্যান্ডম সিক্রেট ব্যবহার হচ্ছে (প্রতি রিস্টার্টে বদলাবে, সব সেশন invalid হয়ে যাবে)। প্রোডাকশনে এটা চলবে না।');
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
  hsts: isProdEnv ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  frameguard: { action: 'sameorigin' },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
// লিগ্যাসি ব্রাউজারের জন্য X-XSS-Protection (আধুনিক ব্রাউজার CSP-ই যথেষ্ট মানে, হেডারটা ignore করে,
// কিন্তু পুরনো ব্রাউজার সাপোর্টের জন্য স্ট্যান্ডার্ড হিসেবে রাখা হলো)
app.use((req, res, next) => {
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), payment=(self), fullscreen=(self)'
  );
  next();
});
app.use(require('./middleware/requestId'));
app.use(appMetrics.httpMiddleware);

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
    // Origin হেডার একদম না থাকা (সরাসরি সার্ভার-টু-সার্ভার কল, cURL, নেটিভ HTTP ক্লায়েন্ট —
    // ব্রাউজার নয়) অনুমোদিত, কারণ ব্রাউজার-চালিত cross-site অ্যাটাক সবসময় কোনো না কোনো
    // Origin হেডার পাঠায়।
    //
    // কিন্তু Origin: "null" ব্রাউজার নিজেই পাঠায় sandboxed <iframe>, data:/file: URL, বা
    // redirect chain থেকে — আর এগুলো ঠিক সেই ভেক্টর যেটা credentialed cross-origin অ্যাটাকে
    // ব্যবহার করা যায় (আক্রমণকারী নিজের ডোমেইনে একটা sandboxed iframe বসিয়ে ব্রাউজারের
    // সেশন কুকি সমেত এই সার্ভারে ক্রেডেনশিয়াল রিকোয়েস্ট পাঠাতে পারত)। এই রিপোতে এমন কোনো
    // বৈধ ফ্লো (নেটিভ WebView শেল, sandboxed callback ইত্যাদি) পাওয়া যায়নি যা "null" origin-এ
    // নির্ভর করে — তাই আর সেটা আলাদা করে অনুমোদন করা হচ্ছে না, ডিফল্ট allow-list আচরণেই পড়বে
    // (অর্থাৎ প্রত্যাখ্যাত হবে)।
    if (!origin) return callback(null, true);
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
app.use(cookieParser());

// session middleware রেডি হওয়ার পর socket.io ইনিশিয়ালাইজ করা হচ্ছে,
// যাতে socket connection-এও একই লগইন session ব্যবহার করে ইউজার/অ্যাডমিন যাচাই করা যায়
initSocket(server, sessionMiddleware);

app.use(flash());
app.use(sentryService.userContextMiddleware); // লগইন করা থাকলে Sentry ইভেন্টে ইউজার কনটেক্সট যোগ হবে

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
const fs = require('fs');
const LOCALES_DIR = path.join(__dirname, 'locales');
function loadTranslations() {
  return {
    bn: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'bn.json'), 'utf8')),
    en: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'))
  };
}
let translations = loadTranslations();
function refreshTranslationsCache() { translations = loadTranslations(); }
app.set('refreshTranslationsCache', refreshTranslationsCache);
app.set('getTranslations', () => translations);

app.get('/lang/:code', (req, res) => {
  req.session.lang = req.params.code === 'en' ? 'en' : 'bn';
  // Referer সম্পূর্ণভাবে ক্লায়েন্ট-নিয়ন্ত্রিত। আগে এটা সরাসরি res.redirect()-এ বসানো হতো,
  // ফলে `/lang/en` একটা open redirect ছিল — Referer হিসেবে https://evil.example.com,
  // //evil.example.com বা javascript: স্কিম পাঠালে ব্রাউজার সেখানেই চলে যেত (যাচাই করা হয়েছে)।
  // utils/redirectBack.js-এর backUrl() আগে থেকেই এই সমস্যার নিরাপদ সমাধান রাখে
  // (same-host যাচাই, protocol-relative ও non-http স্কিম প্রত্যাখ্যান), তাই নতুন কিছু
  // না বানিয়ে সেটাই পুনর্ব্যবহার করা হলো। বৈধ সাইট-অভ্যন্তরীণ Referer আগের মতোই কাজ করে।
  res.redirect(backUrl(req, '/'));
});

app.post('/announcements/:id/dismiss', async (req, res) => {
  try {
    const { dismiss } = require('./services/announcements');
    await dismiss(req.params.id, req.session.user ? req.session.user.id : null);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

app.use((req, res, next) => {
  res.locals.baseUrl = req.protocol + '://' + req.get('host');
  res.locals.user = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  // views/partials/head.ejs ফ্ল্যাশ মেসেজ ইনলাইন <script>-এ নিরাপদে বসানোর জন্য এটা ব্যবহার করে
  res.locals.jsonScriptSafe = (value) => JSON.stringify(String(value == null ? '' : value));

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
  // canonical/og:url-এর জন্য query-string ছাড়া পাথ। হোমপেজে '/' নয়, খালি স্ট্রিং —
  // তাতে baseUrl-এর সাথে জোড়া লাগলে "https://host/" হয়, ডাবল স্ল্যাশ হয় না।
  res.locals.canonicalPath = req.path === '/' ? '/' : req.path.replace(/\/+$/, '');

  const pathParts = req.path.split('/').filter(Boolean);
  let page = 'home';
  if (pathParts.length > 0) {
    if (pathParts[0] === 'extra') page = pathParts[1] || 'home';
    else page = pathParts[0];
  }
  res.locals.currentPage = page;

  if (!req.path.startsWith('/admin')) {
    const { getAllActiveForUser } = require('./services/announcements');
    getAllActiveForUser(req.session.user || null)
      .then(list => { res.locals.activeAnnouncements = list; next(); })
      .catch(() => { res.locals.activeAnnouncements = []; next(); });
    return;
  }
  res.locals.activeAnnouncements = [];
  next();
});

app.get('/health', async (req, res) => {
  try {
    const { liveness } = require('./services/healthCheck');
    const data = await liveness();
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({ status: 'ok' }); // liveness সবসময় 200
  }
});

// ==================== সাময়িক: এক-বারের admin রিসেট (Render Free Plan-এ Shell নেই বলে) ====================
// Render-এর Free Plan-এ Shell/SSH অ্যাক্সেস থাকে না, তাই reset-admin.js ফাইলটা সরাসরি চালানো যায় না।
// এই রুটটা ঠিক একই কাজ করে কিন্তু ব্রাউজার দিয়ে ভিজিট করা যায় — শুধুমাত্র ADMIN_RESET_TOKEN
// environment variable সেট করা থাকলেই এই রুট সক্রিয় থাকে (না থাকলে 404, ডিফল্টভাবে নিষ্ক্রিয়)।
// ব্যবহারের পর ADMIN_RESET_TOKEN/NEW_ADMIN_EMAIL/NEW_ADMIN_PASSWORD — এই তিনটা environment
// variable Render থেকে মুছে ফেলো (অথবা এই পুরো ব্লকটা কোড থেকেই সরিয়ে দাও) — এটা স্থায়ীভাবে
// রেখে দেওয়া নিরাপদ না, যেকেউ token অনুমান করতে পারলে admin অ্যাকাউন্ট বদলে ফেলতে পারবে।
if (process.env.ADMIN_RESET_TOKEN) {
  // /internal/reset-admin ও তার status — দুটোতেই একই টোকেন গেট। টোকেন না মিললে 404,
  // যাতে রুটটার অস্তিত্বই ফাঁস না হয়। timingSafeEqual ব্যবহার করা হয় যাতে বাইট-বাই-বাইট
  // তুলনার সময় থেকে টোকেন অনুমান করা না যায় (দুই রুটে হুবহু একই যাচাই)।
  function resetAdminTokenOk(req) {
    const crypto = require('crypto');
    // Render-এর ওয়েব UI-তে পেস্ট করার সময় প্রায়ই অজান্তে শেষে একটা স্পেস/নিউলাইন চলে আসে —
    // trim() দিয়ে সেই সাধারণ ভুলটা এড়ানো হচ্ছে, নাহলে সঠিক টোকেন দিলেও মিলত না।
    const provided = Buffer.from(String(req.query.token || '').trim());
    const expected = Buffer.from(String(process.env.ADMIN_RESET_TOKEN).trim());
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }

  // ডায়াগনস্টিক: env var আদৌ Render-এ সেট হয়েছে কিনা, ভ্যালু ফাঁস না করেই যাচাই করার উপায়।
  //
  // এই রুটে আগে কোনো টোকেন যাচাই ছিল না — ADMIN_RESET_TOKEN সেট থাকলেই যে কেউ, লগইন ছাড়াই,
  // NEW_ADMIN_EMAIL-এর পুরো মান, পাসওয়ার্ডের দৈর্ঘ্য, DB-তে অ্যাকাউন্টের role এবং
  // "পাসওয়ার্ডটা DB-র হ্যাশের সাথে মেলে কিনা" — এই শেষেরটা কার্যত একটা যাচাই-অরাকল —
  // সব দেখে ফেলতে পারত। এখন নিচের mutation রুটের মতোই একই টোকেন গেট।
  app.get('/internal/reset-admin/status', async (req, res) => {
    if (!resetAdminTokenOk(req)) return res.status(404).send('Not found');
    const lines = [
      `ADMIN_RESET_TOKEN: ${process.env.ADMIN_RESET_TOKEN ? 'সেট করা আছে (' + process.env.ADMIN_RESET_TOKEN.length + ' ক্যারেকটার)' : 'সেট করা নেই'}`,
      `NEW_ADMIN_EMAIL: ${process.env.NEW_ADMIN_EMAIL || 'সেট করা নেই'}`,
      `NEW_ADMIN_PASSWORD: ${process.env.NEW_ADMIN_PASSWORD ? 'সেট করা আছে (' + process.env.NEW_ADMIN_PASSWORD.length + ' ক্যারেকটার)' : 'সেট করা নেই'}`
    ];
    // চূড়ান্ত নিশ্চয়তা: এই মুহূর্তে DB-তে যে হ্যাশ সেভ আছে (আগের একটা /internal/reset-admin কল
    // থেকে), সেটা এখনকার (trim করা) NEW_ADMIN_EMAIL/NEW_ADMIN_PASSWORD দিয়ে সত্যিই মেলে কিনা —
    // ব্রাউজার/টাইপিং/অটোফিল — এসব ভ্যারিয়েবল সম্পূর্ণ বাদ দিয়ে সরাসরি সার্ভার-সাইডে যাচাই।
    const email = (process.env.NEW_ADMIN_EMAIL || '').trim();
    const password = (process.env.NEW_ADMIN_PASSWORD || '').trim();
    if (email && password) {
      try {
        const bcrypt = require('bcryptjs');
        const u = await pool.query('SELECT role, password FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (u.rows.length === 0) {
          lines.push(`\nDB-তে এই ইমেইলে ({email}) কোনো ইউজার নেই — এখনো /internal/reset-admin চালানো হয়নি মনে হচ্ছে।`.replace('{email}', email));
        } else {
          const match = await bcrypt.compare(password, u.rows[0].password);
          lines.push(`\nDB role: ${u.rows[0].role}`);
          lines.push(`বর্তমান NEW_ADMIN_PASSWORD এখন DB-তে সেভ করা হ্যাশের সাথে মিলছে: ${match ? '✅ হ্যাঁ, মিলছে' : '❌ না, মিলছে না'}`);
          if (!match) {
            lines.push('(মানে: DB-তে যে পাসওয়ার্ড সেভ আছে সেটা এখনকার NEW_ADMIN_PASSWORD-এর থেকে আলাদা — /internal/reset-admin আবার চালাও।)');
          } else {
            lines.push('(মানে: পাসওয়ার্ড ঠিকই আছে সার্ভার-সাইডে — লগইন ব্যর্থ হলে সেটা নিশ্চিতভাবে ব্রাউজারে টাইপ করা মান সংক্রান্ত কিছু, যেমন অজান্তে স্পেস/ভুল ক্যারেকটার।)');
          }
        }
      } catch (e) {
        lines.push('\nযাচাই ব্যর্থ: ' + e.message);
      }
    }
    res.type('text/plain').send(lines.join('\n'));
  });

  app.get('/internal/reset-admin', async (req, res) => {
    if (!resetAdminTokenOk(req)) return res.status(404).send('Not found');

    // token-এর মতো NEW_ADMIN_EMAIL/NEW_ADMIN_PASSWORD-এও Render-এ পেস্ট করার সময় অজান্তে
    // শেষে স্পেস/নিউলাইন ঢুকে যাওয়ার একই ঝুঁকি আছে — trim() দিয়ে সেটা এড়ানো হচ্ছে।
    const email = (process.env.NEW_ADMIN_EMAIL || '').trim();
    const password = (process.env.NEW_ADMIN_PASSWORD || '').trim();
    if (!email || !password) {
      return res.status(400).send('NEW_ADMIN_EMAIL / NEW_ADMIN_PASSWORD environment variable সেট করা নেই।');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const demoted = await client.query(
        `UPDATE users SET role = 'user', role_key = NULL WHERE role = 'admin' RETURNING id, username, email`
      );
      const bcrypt = require('bcryptjs');
      const hashed = await bcrypt.hash(password, 10);
      const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      let resultLine;
      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE users SET password = $1, role = 'admin', role_key = NULL, email_verified = true, is_banned = false WHERE id = $2`,
          [hashed, existing.rows[0].id]
        );
        resultLine = `বিদ্যমান ইউজার #${existing.rows[0].id}-কে admin বানানো হলো: ${email}`;
      } else {
        const username = 'admin_' + Math.random().toString(36).slice(2, 8);
        const created = await client.query(
          `INSERT INTO users (username, email, password, role, coins, referral_code, email_verified)
           VALUES ($1, $2, $3, 'admin', 0, $4, true) RETURNING id`,
          [username, email, hashed, username.toUpperCase().slice(0, 8)]
        );
        resultLine = `নতুন admin অ্যাকাউন্ট তৈরি হলো — #${created.rows[0].id}, username: ${username}, email: ${email}`;
      }
      await client.query('COMMIT');
      res.type('text/plain').send(
        `সম্পন্ন।\n${demoted.rows.length}টা পুরনো admin অ্যাকাউন্ট থেকে অ্যাডমিন-অ্যাক্সেস সরানো হলো।\n${resultLine}\n\nএখন /admin/login-এ গিয়ে লগইন করো। তারপর Render থেকে ADMIN_RESET_TOKEN, NEW_ADMIN_EMAIL, NEW_ADMIN_PASSWORD এই তিনটা environment variable মুছে ফেলো।`
      );
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('reset-admin route error:', err.message);
      res.status(500).type('text/plain').send('ব্যর্থ হয়েছে, কোনো পরিবর্তন হয়নি: ' + err.message);
    } finally {
      client.release();
    }
  });
}

app.get('/ready', async (req, res) => {
  try {
    const { readiness } = require('./services/healthCheck');
    const data = await readiness();
    res.status(200).json(data);
  } catch (err) {
    // /ready অথেন্টিকেশন ছাড়াই পাবলিক (লোড ব্যালান্সার/অর্কেস্ট্রেটর প্রোব)। err.message-এ
    // readiness() থেকে আসা pg কানেকশন এরর থাকে — হোস্ট, পোর্ট, ডেটাবেসের নাম, কখনো
    // ইউজারনেম পর্যন্ত। প্রোবের জন্য স্ট্যাটাস কোডটাই যথেষ্ট, কারণ সার্ভার লগে থাকে।
    console.error('readiness check failed:', err && err.stack ? err.stack : err);
    res.status(503).json({ status: 'not_ready' });
  }
});

app.get('/metrics', requireMetricsAccess, async (req, res) => {
  try {
    if (!appMetrics.enabled) {
      return res.status(503).type('text/plain').send('# metrics disabled: prom-client not installed\n');
    }
    await appMetrics.refreshAsyncMetrics();
    res.set('Content-Type', appMetrics.register.contentType);
    res.end(await appMetrics.register.metrics());
  } catch (err) {
    console.error('[metrics] /metrics endpoint error:', err.message);
    res.status(500).type('text/plain').send('# error collecting metrics\n');
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
  // শুধু Origin থাকলে এবং ভুল হলে আটকাবে; একদম না থাকলে ছেড়ে দেবে (নন-ব্রাউজার ক্লায়েন্ট)।
  // কিন্তু Origin থাকা সত্ত্বেও পার্স করা না গেলে (যেমন "null" — sandboxed iframe/data:/file:
  // URL থেকে আসা, যেটা new URL() থ্রো করে) আগে সেটা নিঃশব্দে next()-এ চলে যেত (খালি catch)।
  // অর্থাৎ malformed/"null" Origin দিয়ে এই origin-check কার্যত বাইপাস হয়ে যেত। এখন পার্স করা
  // না গেলে (Origin হেডার পাঠানো হয়েছে কিন্তু বৈধ URL না) আটকে দেওয়া হয় — fail-closed।
  if (origin) {
    let parsedHost;
    try {
      parsedHost = new URL(origin).host;
    } catch (e) {
      return res.status(403).send('Invalid request origin');
    }
    if (parsedHost !== host) {
      return res.status(403).send('Invalid request origin');
    }
  }
  return next();
});

// ==================== CSRF টোকেন সুরক্ষা (Synchronizer Token Pattern) ====================
const { csrfProtection } = require('./middleware/csrf');
app.use(csrfProtection);

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
// Server Health — admin.js-এর আগে মাউন্ট (পুরনো broken handler এড়ানো)
app.use('/admin', require('./routes/adminHealthFix'));
app.use('/admin', require('./routes/admin'));
app.use('/admin/games', require('./middleware/auth').isAdmin, require('./routes/adminGames'));
app.use('/admin/telegram', require('./middleware/auth').isAdmin, require('./routes/adminTelegram'));
app.use('/admin/leaderboard', require('./middleware/auth').isAdmin, require('./routes/adminLeaderboard'));
app.use('/notifications', require('./routes/notifications'));
app.use('/help-center', require('./routes/help-center'));
app.use('/payment', require('./routes/payment'));
app.use('/games', require('./routes/games'));
app.use('/api', require('./routes/api'));
// ==================== OpenAPI / Swagger UI ====================
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec } = require('./services/swagger');
app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));
app.use('/api/docs', (req, res, next) => { res.removeHeader('Content-Security-Policy'); next(); }, swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: 'Livo API Docs' }));
app.use('/accumulator', require('./routes/accumulator'));
app.use('/chat', require('./routes/chat'));
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
sentryService.attachExpressErrorHandler(app); // HTTP এরর অটোমেটিক Sentry-তে রিপোর্ট হবে (নিজের error handler-এর আগে বসাতে হয়)
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

    try {
      const { ensureCriticalTables } = require('./services/ensureCriticalTables');
      await ensureCriticalTables();
    } catch (e) {
      console.error('ensureCriticalTables:', e.message);
    }

    // টেস্ট মোডে (NODE_ENV=test) সার্ভার listen করে না এবং কোনো ব্যাকগ্রাউন্ড
    // ওয়ার্কার/টাইমার (match sync, queue worker, backup ও scheduler) চালু করে না।
    // supertest নিজেই ephemeral সার্ভার তৈরি করে, তাই listen অপ্রয়োজনীয়; আর ওই
    // ব্যাকগ্রাউন্ড কাজগুলো টেস্ট চলাকালীন শেয়ার্ড DB পরিবর্তন করত ও টেস্ট শেষ হওয়ার
    // পরেও লগ/কোয়েরি চালিয়ে যেত — অর্থাৎ এক টেস্ট ফাইলের প্রভাব আরেকটায় লিক করত।
    // প্রোডাকশন/ডেভেলপমেন্টে আচরণ হুবহু আগের মতোই থাকে।
    if (process.env.NODE_ENV === 'test') {
      console.log('🧪 test mode — server listen ও ব্যাকগ্রাউন্ড ওয়ার্কার বাদ দেওয়া হলো');
      return;
    }

    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      setTimeout(() => {
        syncMatches().catch(err => console.error('Initial match sync failed:', err));
        try { require('./services/queueHandlers'); queueService.startWorker(); } catch (e) { console.error('queue worker start error:', e.message); }
        // queues/index.js (BullMQ, activity-log/fraud-scan/admin queue dashboard) — এটার নিজস্ব
        // comment-এই বলা ছিল app.js থেকে initQueueSystem() কল করা দরকার, কিন্তু কোথাও কল হতো না।
        // ফলে REDIS_URL সেট থাকলেও Redis connection/worker কখনো চালু হতো না — producers.js এর
        // ইনলাইন fallback-এর কারণে জব হারাতো না, কিন্তু queue.enqueue* কখনো আসলে queue হতো না
        // এবং /admin/queues ড্যাশবোর্ড সবসময় "বন্ধ" দেখাতো। REDIS_URL না থাকলে এটা নিরাপদে
        // false রিটার্ন করে স্কিপ করে (connection.js দেখুন) — কোনো নতুন hard dependency যোগ হয়নি।
        require('./queues').initQueueSystem().catch(err => console.error('queues initQueueSystem error:', err.message));
      }, 3000);
      scheduleDailyBackup();
      scheduleAutoBackup();
      require('./services/scheduler').start()
        .catch(err => console.error('⚠️ Scheduler চালু করতে সমস্যা হয়েছে (সার্ভার চলতে থাকবে):', err.message));
    });
  } catch (err) {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
  }
}

startServer();
module.exports = app;
