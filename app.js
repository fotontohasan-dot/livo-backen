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

const express = require('express');
const http = require('http');
const { initSocket } = require('./services/socket');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const flash = require('connect-flash');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createLimiter } = require('./middleware/rateLimitFactory');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const { pool } = require('./db');
const { apiGateway, responseHelpers } = require('./middleware/gateway');
const { tr } = require('./utils/i18n');
const { touchDeviceActivity } = require('./services/deviceTracking');
const cookieParser = require('cookie-parser');
require('./services/cache'); // অ্যাপ বুট হওয়ার সাথে সাথেই Redis কানেকশন অ্যাটেম্পট শুরু হয় (কানেক্ট না হলেও অ্যাপ চলতে থাকে)
const appMetrics = require('./services/metrics');
const { requireMetricsAccess } = require('./middleware/metricsAuth');

const { backUrl } = require('./utils/redirectBack');
const app = express();
app.use(compression());
const server = http.createServer(app);
global.__livoServer = server; // গ্রেসফুল শাটডাউনে চলমান রিকোয়েস্ট শেষ করার জন্য

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

const cspDirectives = {
  defaultSrc: ["'self'"],
  // ইনলাইন স্ক্রিপ্ট সম্পূর্ণ নিষিদ্ধ — docs/CSP.md ধাপ ৩ শেষ।
  //
  // টেমপ্লেটে থাকা ২৭৩টা ইনলাইন <script> ব্লক public/js/-এ সরানো হয়েছে;
  // সার্ভার-সাইড মান যায় <script type="application/json"> ব্লকে, যা
  // executable নয়। বর্তমান সংখ্যা ০, আর
  // tests/security/cspInlineRatchet.test.js সেটাকে ০-তেই আটকে রাখে।
  //
  // ধাপ ২-এ scriptSrcAttr আগেই 'none' হয়েছিল। দুটো মিলে এখন reflected বা
  // stored XSS দিয়ে স্ক্রিপ্ট চালানোর পথ ব্রাউজারই বন্ধ করে — আমাদের
  // এস্কেপিং প্রতিটা পথে নিখুঁত ছিল কি না তার উপর আর নির্ভর করতে হয় না।
  scriptSrc: ["'self'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
  // ইনলাইন ইভেন্ট হ্যান্ডলার সম্পূর্ণ নিষিদ্ধ — এখন প্রয়োগ করা নীতিতেই।
  //
  // docs/CSP.md ধাপ ২ শেষ: টেমপ্লেটে থাকা ২৫০টা onclick/onchange/onsubmit
  // এবং রানটাইমে innerHTML দিয়ে তৈরি হওয়া হ্যান্ডলারগুলো — সবই data-*
  // অ্যাট্রিবিউট আর addEventListener-এ সরানো হয়েছে। বর্তমান সংখ্যা ০, আর
  // tests/security/cspInlineRatchet.test.js সেটাকে ০-তেই আটকে রাখে।
  //
  // এর ফলে reflected/stored XSS দিয়ে `onerror=`/`onclick=` ইনজেক্ট করে
  // কোড চালানোর পথটা ব্রাউজার নিজেই বন্ধ করে — আমাদের এস্কেপিং ঠিক ছিল
  // কি না তার উপর আর নির্ভর করতে হয় না।
  //
  // scriptSrc-এ এখনো 'unsafe-inline' আছে, কারণ ২৫৪টা ইনলাইন <script> ব্লক
  // বাকি (ধাপ ৩)। দুটো ডিরেক্টিভ আলাদা, তাই একটা আগে শক্ত করা যায়।
  scriptSrcAttr: ["'none'"],
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

// ==================== CSP কড়াকড়ির পথ ====================
// প্রয়োগ করা নীতিতে এখনো `'unsafe-inline'` আছে, কারণ কোডবেসে ৭০টি ফাইলে
// ইনলাইন `onclick=` হ্যান্ডলার ও একাধিক ইনলাইন `<script>` ব্লক আছে। ওগুলো
// একসাথে সরালে সাইট ভেঙে পড়ত, আর ভাঙা সাইট XSS-এর চেয়ে দ্রুত ক্ষতি করে।
//
// তাই দুই ধাপ: প্রথমে **Report-Only** হিসেবে কড়া নীতি পাঠানো হয়। ব্রাউজার
// কিছু ব্লক করে না, শুধু লঙ্ঘনগুলো রিপোর্ট করে — অর্থাৎ ইনলাইন কোড কোথায়
// কোথায় আছে তার বাস্তব তালিকা তৈরি হয়। সেগুলো সরানোর পর এই নীতিটাই
// প্রয়োগে তোলা যাবে।
//
// অগ্রগতি ও ধাপগুলো: docs/CSP.md
// ==================== ধাপ ৩: nonce অবকাঠামো ====================
// docs/CSP.md-এর ধাপ ৩ — প্রতি রিকোয়েস্টে একটা nonce তৈরি করে
// `res.locals.cspNonce`-এ রাখা হয়, যাতে টেমপ্লেটগুলো ধাপে ধাপে
// `<script nonce="<%= cspNonce %>">` ব্যবহার শুরু করতে পারে।
//
// গুরুত্বপূর্ণ: nonce টা **শুধু Report-Only নীতিতে** যোগ করা হয়, প্রয়োগ করা
// নীতিতে নয়। কারণ স্পেক অনুযায়ী script-src-এ nonce থাকলে আধুনিক ব্রাউজার
// `'unsafe-inline'` উপেক্ষা করে। প্রয়োগ করা নীতিতে এখনই nonce বসালে
// ২৭৩টা ইনলাইন `<script>` ব্লক আর ২৫০টা ইনলাইন হ্যান্ডলার একসাথে বন্ধ
// হয়ে যেত — অর্থাৎ পুরো অ্যাডমিন প্যানেল ও গেম UI মুহূর্তে ভেঙে পড়ত।
//
// তাই ক্রমটা: nonce পাওয়া যায় → টেমপ্লেট একে একে migrate হয় →
// Report-Only রিপোর্ট শূন্যে নামে → তখন nonce প্রয়োগ নীতিতে ওঠে এবং
// `'unsafe-inline'` সরে।
const crypto = require('crypto');
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

const reportOnlyDirectives = {
  ...cspDirectives,
  // nonce টা ফাংশন হিসেবে দেওয়া হয় — helmet প্রতি রিকোয়েস্টে এটা ডাকে,
  // ফলে প্রতিটা response নিজের nonce পায় (একটা স্থির nonce মানে nonce না)।
  scriptSrc: [
    ...cspDirectives.scriptSrc.filter((v) => v !== "'unsafe-inline'"),
    (req, res) => `'nonce-${res.locals.cspNonce}'`
  ],
  scriptSrcAttr: ["'none'"],
  styleSrc: cspDirectives.styleSrc.filter((v) => v !== "'unsafe-inline'"),
  reportUri: ['/csp-report']
};

const isProdEnv = process.env.NODE_ENV === 'production';

// Report-Only নীতি — ব্লক করে না, শুধু লঙ্ঘন জানায়।
app.use(helmet.contentSecurityPolicy({
  directives: reportOnlyDirectives,
  reportOnly: true
}));

// লঙ্ঘন রিপোর্ট গ্রহণ। ব্রাউজার এখানে POST করে; শুধু গোনা ও লগ করা হয়,
// কোনো ব্যবহারকারী-ডেটা সংরক্ষণ করা হয় না।
const cspViolationCounts = new Map();
// PHASE 13 fix: এই endpoint টি unauthenticated এবং global rate limiter-এর
// আগে mount করা, আর প্রতিটি unique key একটি unbounded Map-এ জমা হত। যেকোনো
// ব্যক্তি ভিন্ন ভিন্ন directive/source পাঠিয়ে Map টি অসীম বড় করে process-এর
// memory শেষ করে দিতে পারত। তাই (১) নিজস্ব rate limiter, (২) ছোট body limit,
// (৩) Map-এর সর্বোচ্চ আকার নির্ধারণ।
const CSP_REPORT_MAX_KEYS = 500;
const cspReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: false,
  legacyHeaders: false,
  // report endpoint নীরব থাকে — সীমা ছাড়ালেও 204 ফেরত যায়
  handler: (req, res) => res.status(204).end()
});
app.post('/csp-report', cspReportLimiter, express.json({ type: ['application/csp-report', 'application/json'], limit: '16kb' }), (req, res) => {
  try {
    const report = (req.body && (req.body['csp-report'] || req.body)) || {};
    const directive = String(report['violated-directive'] || report.violatedDirective || 'unknown').slice(0, 80);
    const source = String(report['source-file'] || report.sourceFile || '').slice(0, 200);
    const key = `${directive} | ${source}`;
    // নতুন key তখনই যোগ হয় যখন Map সীমার নিচে; বিদ্যমান key সবসময় গোনা হয়
    if (!cspViolationCounts.has(key) && cspViolationCounts.size >= CSP_REPORT_MAX_KEYS) {
      return res.status(204).end();
    }
    const count = (cspViolationCounts.get(key) || 0) + 1;
    cspViolationCounts.set(key, count);
    // প্রতিটা রিপোর্ট লগ করলে লগ ভেসে যাবে — প্রথমবার আর তারপর প্রতি ১০০তমবার।
    if (count === 1 || count % 100 === 0) {
      console.warn(`[csp] ${key} (${count} বার)`);
    }
  } catch (e) {
    // রিপোর্ট পার্স না হলেও ২০৪ — ব্রাউজারকে রিট্রাই করানোর কিছু নেই
  }
  res.status(204).end();
});

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
// অনুমোদিত origin-এর তালিকা ও যাচাই এখন utils/allowedOrigins.js-এ — একই পলিসি
// Socket.IO লেয়ারেও ব্যবহার করা হয় (আগে সেখানে `origin: "*"` ছিল)।
const { isAllowedOrigin } = require('./utils/allowedOrigins');

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
    return callback(null, isAllowedOrigin(origin, { allowMissing: true }));
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
  // এই limiter ভাষা-মিডলওয়্যারের আগে বসানো, তাই req.t() এখনো নেই — utils/i18n
  // session থেকে ভাষা পড়ে একই bn.json/en.json থেকেই অনুবাদ দেয়।
  message: (req) => tr(req, 'common_rate_limited_15m'),
  // লিমিটারটা /login, /register ও /admin/login — তিন জায়গাতেই একই কী (IP) দিয়ে গোনে।
  // আগে GET রিকোয়েস্টও গোনা হতো, অর্থাৎ শুধু পেজ লোড করলেই কোটা ফুরাত: একই IP থেকে
  // ১৫ মিনিটে ১০ বার লগইন/রেজিস্টার পেজ *দেখলেই* ফর্মের বদলে "rate limited" বার্তা
  // আসত (শেয়ার্ড অফিস IP বা মোবাইল CGNAT-এ খুবই বাস্তব সমস্যা, আর E2E-তে অ্যাডমিন
  // লগইন পেজ এভাবেই ফাঁকা আসত)। ব্রুট-ফোর্স সুরক্ষা আসে আসল চেষ্টাগুলো (POST) গুনে,
  // তাই GET/HEAD আর গোনা হয় না।
  skip: (req) => req.method === 'GET' || req.method === 'HEAD',
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
  message: (req) => tr(req, 'common_rate_limited'),
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
  const chosen = req.params.code === 'en' ? 'en' : 'bn';
  req.session.lang = chosen;
  // লগইন করা থাকলে পছন্দটা users.preferred_language-এ লেখা হয়, যাতে সেশন শেষ
  // হলে বা অন্য ডিভাইস থেকে লগইন করলেও ভাষা মনে থাকে (আগে শুধু সেশনে থাকত,
  // তাই প্রতিবার লগইনে ডিফল্টে ফিরে যেত)। লেখাটা fire-and-forget —
  // ডেটাবেস সাময়িকভাবে না পেলেও ভাষা বদলানো ব্যর্থ হবে না, শুধু persist হবে না।
  // `chosen` উপরের লাইনেই দুটো আক্ষরিক মানে সীমাবদ্ধ, তাই ক্লায়েন্টের কাঁচা
  // ইনপুট কখনো কলামে পৌঁছায় না (কলামে CHECK constraint-ও আছে)।
  if (req.session.user && req.session.user.id) {
    pool.query('UPDATE users SET preferred_language = $1 WHERE id = $2', [chosen, req.session.user.id])
      .catch((e) => console.error('preferred_language save failed:', e.message));
  }
  // Referer সম্পূর্ণভাবে ক্লায়েন্ট-নিয়ন্ত্রিত। আগে এটা সরাসরি res.redirect()-এ বসানো হতো,
  // ফলে `/lang/en` একটা open redirect ছিল — Referer হিসেবে https://evil.example.com,
  // //evil.example.com বা javascript: স্কিম পাঠালে ব্রাউজার সেখানেই চলে যেত (যাচাই করা হয়েছে)।
  // utils/redirectBack.js-এর backUrl() আগে থেকেই এই সমস্যার নিরাপদ সমাধান রাখে
  // (same-host যাচাই, protocol-relative ও non-http স্কিম প্রত্যাখ্যান), তাই নতুন কিছু
  // না বানিয়ে সেটাই পুনর্ব্যবহার করা হলো। বৈধ সাইট-অভ্যন্তরীণ Referer আগের মতোই কাজ করে।
  res.redirect(backUrl(req, '/'));
});

// লগইনের পরে সেভ করা ভাষা পছন্দ ফিরিয়ে আনা।
//
// প্রতিটি লগইন পথে (সাধারণ লগইন, রেজিস্ট্রেশন, Google OAuth, অ্যাডমিন লগইন,
// অ্যাডমিন 2FA) আলাদা করে কোড বসানোর বদলে এখানে একটাই মিডলওয়্যার — কারণ
// regenerateSession() লগইনের সময় সেশন খালি করে দেয়, ফলে নিচের ফ্ল্যাগটাও মুছে
// যায় এবং পছন্দটা ঠিক একবার আবার পড়া হয়।
//
// সেশনে প্রতি লগইনে একবারই query চলে (langRestored ফ্ল্যাগ), তাই এটা প্রতি
// রিকোয়েস্টে ডেটাবেস চাপ বাড়ায় না। ব্যর্থ হলে চুপচাপ এগিয়ে যায় — ভাষা পছন্দ
// পড়তে না পারা কখনো পেজ লোড আটকাবে না।
//
// অগ্রাধিকার: সেশনে ইতিমধ্যে ভাষা থাকলে (এই সেশনেই ব্যবহারকারী সুইচ করেছেন)
// সেটাই জেতে; নাহলে ডেটাবেসের পছন্দ; কোনোটাই না থাকলে সাইটের ডিফল্ট।
app.use(async (req, res, next) => {
  if (!req.session || !req.session.user || !req.session.user.id) return next();
  if (req.session.langRestored) return next();
  req.session.langRestored = true;
  if (req.session.lang) return next();
  try {
    const r = await pool.query('SELECT preferred_language FROM users WHERE id = $1', [req.session.user.id]);
    const pref = r.rows[0] && r.rows[0].preferred_language;
    if (pref === 'bn' || pref === 'en') req.session.lang = pref;
  } catch (e) {
    console.error('preferred_language load failed:', e.message);
  }
  next();
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
  // views/partials/head.ejs ফ্ল্যাশ মেসেজ ইনলাইন <script>-এ নিরাপদে বসানোর জন্য এটা ব্যবহার করে।
  // আগে JSON.stringify(String(value)) করত — array/object পাঠালে String() সেটাকে "[object Object],..."
  // এ ভেঙে ফেলত (analytics.ejs, kyc.ejs, payment/admin.ejs, profile/wheel.ejs ভাঙত)। এখন value-টা
  // সরাসরি JSON.stringify হয় (array/object/string/number সব ঠিকভাবে সিরিয়ালাইজ হয়), আর
  // </script>, <!--, লাইন-সেপারেটর ক্যারেক্টার escape করা হয় যাতে JSON স্ট্রিং-এর ভেতরের কোনো
  // ইউজার/অ্যাডমিন কনটেন্ট দিয়ে <script> ব্লক ভাঙা বা HTML ইনজেক্ট করা না যায়।
  res.locals.jsonScriptSafe = (value) => JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  // views/news-detail.ejs আগে একটা কখনো সংজ্ঞায়িত না-হওয়া escapeHtml() কল করত (ReferenceError,
  // প্রতিটা /news/:id ভিজিটে 500 ক্র্যাশ করত)। এটা একটা প্রকৃত HTML-escape ফাংশন — <%- %>-এর
  // ভেতরে raw HTML বসানোর আগে ব্যবহারকারী/admin-লেখা কনটেন্ট নিরাপদ করতে।
  res.locals.escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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
  // রুট হ্যান্ডলারের জন্য একই অনুবাদক। res.locals.t শুধু টেমপ্লেটে পাওয়া যায়, কিন্তু
  // req.flash()/res.json()-এর মেসেজগুলো রুটেই তৈরি হয় — সেগুলো যেন ইউজারের নির্বাচিত
  // ভাষায় যায়, তাই req.t() যোগ করা হলো। ব্যবহার: req.flash('success', req.t('key'))
  req.t = t_func;
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.siteName = 'Livo';
  // views/partials/head.ejs এটা দেখে সিদ্ধান্ত নেয় পেজটা noindex হবে কি না।
  // req.path ব্যবহার করা হয় (query string ছাড়া), কারণ সিদ্ধান্তটা রুট
  // নিয়ে, প্যারামিটার নিয়ে নয়।
  res.locals.currentPath = req.path || '';
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

// ফিচার ফ্ল্যাগ → res.locals.features, যাতে নেভিগেশন/বাটন বন্ধ ফিচারের জন্য
// লুকানো যায়। এটা শুধু UI স্তর; আসল প্রয়োগ requireFeature() মিডলওয়্যারে
// (middleware/featureGate.js) — শুধু বাটন লুকিয়ে কিছু বন্ধ করা হয় না।
// অ্যাডমিন প্যানেল বাদ: অ্যাডমিনকে বন্ধ ফিচারও ম্যানেজ করতে দিতে হবে।
app.use((req, res, next) => {
  if (req.path.startsWith('/admin')) return next();
  return require('./middleware/featureGate').attachFeatureLocals(req, res, next);
});

// /payment/admin/* ও /chat/admin ও admin-layout.ejs রেন্ডার করে, তাই সেগুলোরও
// সাইডবার ডেটা দরকার (নাহলে ওই পেজে নেভিগেশন খালি আসত)।
app.use(['/payment/admin', '/chat/admin'], require('./middleware/adminNavLocals').adminNavLocals);

app.get('/health', async (req, res) => {
  try {
    const { liveness } = require('./services/healthCheck');
    const data = await liveness();
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({ status: 'ok' }); // liveness সবসময় 200
  }
});

// ==================== ব্রেক-গ্লাস: এক-বারের admin রিকভারি ====================
// Render-এর Free Plan-এ Shell/SSH নেই, তাই reset-admin.js সরাসরি চালানো যায় না — এই রুটটা
// সেই ঘাটতি পূরণ করে। কিন্তু এটা একটা চরম প্রিভিলেজ বাউন্ডারি, তাই কড়া শর্ত:
//
//   * ডিফল্টভাবে সম্পূর্ণ নিষ্ক্রিয় — ADMIN_RESET_TOKEN সেট না থাকলে রুট রেজিস্টারই হয় না।
//   * টোকেন যথেষ্ট দীর্ঘ না হলে (>= 32 ক্যারেক্টার) প্রোডাকশনে fail-closed — রুট নিষ্ক্রিয়।
//   * state পরিবর্তন শুধু POST-এ; GET শুধু একটা নিশ্চিতকরণ ফর্ম দেখায়, কিছু বদলায় না।
//     (আগে GET-ই সরাসরি admin বদলে দিত — লিংক প্রি-ফেচ/ক্রল/ইতিহাস থেকেই ট্রিগার সম্ভব ছিল।)
//   * ব্যর্থ চেষ্টা রেট-লিমিটেড; সফল/ব্যর্থ দুটোই IP-সহ audit log-এ যায়।
//   * পুরনো অ্যাডমিনদের আর ডিমোট করা হয় না (নিচে বিস্তারিত) — লকআউট ঝুঁকি সরানো হলো।
//   * আগের /internal/reset-admin/status রুটটা সম্পূর্ণ মুছে ফেলা হয়েছে: সেটা টোকেনধারীকে
//     NEW_ADMIN_EMAIL-এর পুরো মান, পাসওয়ার্ডের দৈর্ঘ্য, DB role এবং "এই পাসওয়ার্ডটা DB-র
//     হ্যাশের সাথে মেলে কিনা" — অর্থাৎ একটা কার্যকর পাসওয়ার্ড অরাকল — দিয়ে দিত। রিকভারির
//     জন্য এর কোনো প্রয়োজন নেই।
if (process.env.ADMIN_RESET_TOKEN) {
  const crypto = require('crypto');
  const RESET_TOKEN = String(process.env.ADMIN_RESET_TOKEN).trim();
  const MIN_TOKEN_LEN = 32;

  if (RESET_TOKEN.length < MIN_TOKEN_LEN && process.env.NODE_ENV === 'production') {
    // fail-closed: দুর্বল টোকেন মানে কার্যত কোনো সুরক্ষা নেই। নীরবে দুর্বল ডিফল্ট মেনে নেওয়ার
    // বদলে রুটটাই রেজিস্টার করা হচ্ছে না, এবং কারণটা লগে স্পষ্ট করে বলা হচ্ছে (টোকেন ছাড়া)।
    console.error(
      `[security] ADMIN_RESET_TOKEN কমপক্ষে ${MIN_TOKEN_LEN} ক্যারেক্টার হতে হবে — ` +
      'বর্তমান মান খুব ছোট, তাই /internal/reset-admin নিষ্ক্রিয় রাখা হলো।'
    );
  } else {
    const { logEvent } = require('./services/auditLog');

    // ব্রুট-ফোর্স বাধা — টোকেন অনুমান করার চেষ্টা সীমিত করা। ব্যর্থ ও সফল দুই ধরনের
    // রিকোয়েস্টই গোনা হয়, কারণ এই এন্ডপয়েন্ট কখনোই বারবার কল হওয়ার কথা নয়।
    const resetAdminLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => res.status(404).send('Not found')
    });

    // টোকেন যাচাই — timingSafeEqual, যাতে বাইট-বাই-বাইট তুলনার সময় থেকে টোকেন অনুমান করা
    // না যায়। মান হেডার বা বডি থেকে নেওয়া হয়; query string থেকে নয়, কারণ URL প্রক্সি লগ,
    // Referer হেডার ও ব্রাউজার হিস্ট্রিতে জমা হয়ে যায়।
    function resetAdminTokenOk(req) {
      const raw = req.get('x-admin-reset-token') || (req.body && req.body.token) || '';
      const provided = Buffer.from(String(raw).trim());
      const expected = Buffer.from(RESET_TOKEN);
      return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    }

    // GET — কোনো state পরিবর্তন নয়, শুধু নিশ্চিতকরণ ফর্ম। এখানে ইচ্ছাকৃতভাবে কোনো টোকেন
    // যাচাই বা কোনো অ্যাকাউন্ট-স্ট্যাটাস দেখানো হয় না (কোনো তথ্য ফাঁস নেই)।
    app.get('/internal/reset-admin', resetAdminLimiter, (req, res) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>Admin recovery</title>
<form method="POST" action="/internal/reset-admin" style="font-family:sans-serif;max-width:32rem;margin:3rem auto">
  <h1 style="font-size:1.1rem">Admin recovery</h1>
  <p>এই অপারেশনটা NEW_ADMIN_EMAIL অ্যাকাউন্টকে admin বানাবে। চালানোর পর
     ADMIN_RESET_TOKEN / NEW_ADMIN_EMAIL / NEW_ADMIN_PASSWORD env var তিনটা মুছে ফেলো।</p>
  <p><label>Reset token<br><input name="token" type="password" autocomplete="off" style="width:100%"></label></p>
  <p><label><input name="confirm" type="checkbox" value="yes"> আমি নিশ্চিত</label></p>
  <button type="submit">Run recovery</button>
</form>`);
    });

    app.post('/internal/reset-admin', resetAdminLimiter, async (req, res) => {
      const auditBase = { req, actorType: 'system', actorUsername: 'ADMIN_RECOVERY', category: 'auth', riskLevel: 'critical' };

      if (!resetAdminTokenOk(req)) {
        // ব্যর্থ চেষ্টাও নিরাপত্তা-প্রমাণ — IP/UA/request-id সহ লগ হয়। রেসপন্স 404,
        // যাতে রুটটার অস্তিত্বই ফাঁস না হয়।
        await logEvent({ ...auditBase, action: 'ADMIN_RECOVERY_DENIED', status: 'failure', details: { reason: 'invalid_token' } });
        return res.status(404).send('Not found');
      }
      if (!req.body || req.body.confirm !== 'yes') {
        await logEvent({ ...auditBase, action: 'ADMIN_RECOVERY_DENIED', status: 'failure', details: { reason: 'not_confirmed' } });
        return res.status(400).type('text/plain').send('নিশ্চিতকরণ চেকবক্সটা টিক করতে হবে।');
      }

      const email = (process.env.NEW_ADMIN_EMAIL || '').trim();
      const password = (process.env.NEW_ADMIN_PASSWORD || '').trim();
      if (!email || !password) {
        return res.status(400).type('text/plain').send('NEW_ADMIN_EMAIL / NEW_ADMIN_PASSWORD environment variable সেট করা নেই।');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const bcrypt = require('bcryptjs');
        const hashed = await bcrypt.hash(password, 10);

        // গুরুত্বপূর্ণ পরিবর্তন: আগে এই রুট প্রথমেই `UPDATE users SET role='user' WHERE role='admin'`
        // দিয়ে বিদ্যমান সব অ্যাডমিনকে ডিমোট করত, তারপর নতুন অ্যাডমিন বসাতে চেষ্টা করত। ওই ক্রমে
        // দ্বিতীয় ধাপ ব্যর্থ হলে সিস্টেমে একজনও অ্যাডমিন থাকত না, আর টোকেন ফাঁস হলে বৈধ
        // অ্যাডমিনকে নীরবে সরিয়ে দেওয়া যেত। এখন কাউকে ডিমোট করা হয় না — লক্ষ্য অ্যাকাউন্টকে
        // শুধু admin করা/তৈরি করা হয়, আর সেটা যাচাই করার পরেই কমিট হয়।
        const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        let targetId, resultLine;
        if (existing.rows.length > 0) {
          targetId = existing.rows[0].id;
          await client.query(
            `UPDATE users SET password = $1, role = 'admin', email_verified = true, is_banned = false WHERE id = $2`,
            [hashed, targetId]
          );
          resultLine = `বিদ্যমান ইউজার #${targetId}-কে admin বানানো হলো।`;
        } else {
          const username = 'admin_' + crypto.randomBytes(4).toString('hex');
          const created = await client.query(
            `INSERT INTO users (username, email, password, role, coins, referral_code, email_verified)
             VALUES ($1, $2, $3, 'admin', 0, $4, true) RETURNING id`,
            [username, email, hashed, username.toUpperCase().slice(0, 8)]
          );
          targetId = created.rows[0].id;
          resultLine = `নতুন admin অ্যাকাউন্ট তৈরি হলো — #${targetId}, username: ${username}`;
        }

        // কমিটের আগে যাচাই: অ্যাকাউন্টটা সত্যিই admin এবং লগইনযোগ্য অবস্থায় আছে তো?
        const verify = await client.query(
          `SELECT role, is_banned FROM users WHERE id = $1`, [targetId]
        );
        if (!verify.rows[0] || verify.rows[0].role !== 'admin' || verify.rows[0].is_banned) {
          throw new Error('replacement admin verification failed');
        }

        await client.query('COMMIT');
        // অডিট ইভেন্ট ট্রানজ্যাকশনের বাইরে, কমিটের পরে — যাতে rollback হলে ভুল করে
        // "সফল" রেকর্ড না থাকে। শুধু আইডি/ইমেইল যায়, কোনো পাসওয়ার্ড/টোকেন নয়।
        await logEvent({
          ...auditBase, action: 'ADMIN_RECOVERY_EXECUTED', status: 'success',
          details: { targetUserId: targetId, targetEmail: email, demotedExistingAdmins: false }
        });
        res.type('text/plain').send(
          `সম্পন্ন।\n${resultLine}\n\nবিদ্যমান কোনো অ্যাডমিনকে ডিমোট করা হয়নি।\n` +
          `এখন /admin/login-এ লগইন করো, তারপর ADMIN_RESET_TOKEN, NEW_ADMIN_EMAIL, NEW_ADMIN_PASSWORD মুছে ফেলো।`
        );
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('reset-admin route error:', err.message);
        await logEvent({ ...auditBase, action: 'ADMIN_RECOVERY_FAILED', status: 'failure', details: { reason: err.message } });
        // অভ্যন্তরীণ ত্রুটির বার্তা ক্লায়েন্টকে ফেরত দেওয়া হয় না (স্কিমা/অবকাঠামো ফাঁস)।
        res.status(500).type('text/plain').send('ব্যর্থ হয়েছে, কোনো পরিবর্তন হয়নি।');
      } finally {
        client.release();
      }
    });
  }
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
// PHASE 1 fix: আগে `/api/docs` ও `/api/docs.json` দুটোই সম্পূর্ণ unauthenticated
// ছিল — যেকোনো anonymous ব্যক্তি পুরো API surface (প্রতিটি route, parameter,
// auth scheme) পড়ে নিতে পারত, যা attacker-এর reconnaissance কাজ সহজ করে দেয়।
//
// তার চেয়েও গুরুতর: `/api/docs`-এ enforced CSP হেডারটি response থেকে মুছে
// ফেলা হত। উদ্দেশ্য ছিল Swagger UI-এর inline script/style চালানো, কিন্তু ফল
// দাঁড়াত — ওই path-এ enforced CSP সম্পূর্ণ অনুপস্থিত। spec-এর কোনো field বা
// Swagger bundle দিয়ে XSS হলে সেটা শূন্য CSP-র নিচে চলত।
//
// এখন দুই স্তর:
//   ১. Availability — production-এ default বন্ধ। ব্যবসায়িক প্রয়োজন থাকলে
//      ENABLE_API_DOCS=true দিয়ে ইচ্ছাকৃতভাবে খুলতে হয়। বন্ধ থাকলে 404 —
//      403 নয়, কারণ 403 বলে দেয় জিনিসটার অস্তিত্ব আছে।
//   ২. Authorization — খোলা থাকলেও isAdmin। middleware/auth.js-এর isAdmin
//      প্রতি রিকোয়েস্টে DB থেকে role + ban + deleted যাচাই করে, তাই ডিমোট বা
//      ব্যান করা admin-এর পুরনো session কাজ করে না।
//
// CSP আর মুছে ফেলা হয় না। বদলে এই path-এর জন্য একটা scoped policy বসানো হয়:
// Swagger UI-এর যতটুকু inline দরকার ততটুকুই, আর object-src/frame-ancestors
// শক্ত করে বাঁধা। global policy-র চেয়ে এটা সংকীর্ণ, অনুপস্থিত নয়।
const apiDocsEnabled = () => process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';

const apiDocsGate = (req, res, next) => {
  if (!apiDocsEnabled()) return res.status(404).json({ success: false, error: 'Not found' });
  return next();
};

const SWAGGER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const swaggerCspHeader = (req, res, next) => {
  res.setHeader('Content-Security-Policy', SWAGGER_CSP);
  // Report-Only নীতিটাও এই path-এ প্রযোজ্য নয় (সেটা কড়া variant, Swagger-এর
  // inline নিয়ে অনর্থক রিপোর্টের বন্যা বইয়ে দিত) — তাই সরানো হয়, enforced
  // নীতিটা উপরে বসানোর *পরে*।
  res.removeHeader('Content-Security-Policy-Report-Only');
  return next();
};

app.get('/api/docs.json', apiDocsGate, require('./middleware/auth').isAdmin, (req, res) => res.json(swaggerSpec));
app.use('/api/docs', apiDocsGate, require('./middleware/auth').isAdmin, swaggerCspHeader, swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: 'Livo API Docs' }));
app.use('/accumulator', require('./routes/accumulator'));
app.use('/chat', require('./routes/chat'));
app.use('/extra', require('./routes/extra'));
// ===============================================

app.get('/app/update', (req, res) => res.render('app/update'));

// Telegram Bot Webhook
const { handleMessage, verifyWebhookSecret, isDuplicateUpdate } = require('./telegram-bot');

// নিরাপত্তা: এই এন্ডপয়েন্ট পাবলিক এবং GitHub-এ লেখার ক্ষমতাসম্পন্ন কোড ট্রিগার করে।
// secret যাচাইয়ের আগেই যাতে কেউ অসীম রিকোয়েস্ট পাঠিয়ে CPU/লগ ভাসিয়ে দিতে না পারে,
// তাই আলাদা রেট-লিমিট। Telegram-এর স্বাভাবিক ট্রাফিকের চেয়ে সীমা অনেক উদার।
const telegramWebhookLimiter = createLimiter('telegram-webhook', {
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests'
});

app.post('/telegram-webhook', telegramWebhookLimiter, express.json({ limit: '256kb' }), async (req, res) => {
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

    // নিরাপত্তা: রিপ্লে সুরক্ষা। Telegram ডেলিভারি নিশ্চিত করতে একই update বারবার
    // পাঠাতে পারে; ডিডুপ ছাড়া একই কনফার্মেশন দুবার চললে ডুপ্লিকেট কমিট/ব্রাঞ্চ হতে পারত।
    // 200 ফেরত যায় যাতে Telegram রিট্রাই বন্ধ করে, কিন্তু কিছুই প্রসেস হয় না।
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (isDuplicateUpdate(body.update_id)) {
      console.warn('⚠️ /telegram-webhook: পুনরাবৃত্ত update_id — উপেক্ষা করা হলো।');
      return res.sendStatus(200);
    }

    const { message } = body;
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
  // ক্লায়েন্টের পাঠানো ত্রুটিপূর্ণ রিকোয়েস্ট (ভাঙা JSON, অতিরিক্ত বড় বডি, ভুল
  // content-type) body-parser থেকে err.status/err.statusCode সহ আসে — যেমন
  // SyntaxError হলে 400, entity.too.large হলে 413। আগে এই হ্যান্ডলার সেগুলো উপেক্ষা
  // করে সবকিছুকেই 500 বানাত। ফলে (ক) ক্লায়েন্ট বুঝত না দোষটা তার রিকোয়েস্টের,
  // (খ) প্রতিটা ভাঙা রিকোয়েস্ট error_logs ও Sentry-তে "সার্ভার ত্রুটি" হিসেবে জমা হয়ে
  // আসল সার্ভার বাগ ঢেকে দিত, আর (গ) কেউ ইচ্ছা করে ভাঙা বডি পাঠিয়ে error_logs
  // ফোলাতে পারত। 4xx হলে এখন সেটাই ফেরত যায় এবং error_logs-এ লেখা হয় না।
  const rawStatus = Number(err.status || err.statusCode);
  const isClientError = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 500;
  const statusCode = isClientError ? rawStatus : 500;

  if (isClientError) {
    console.warn(`⚠️ Client error ${statusCode} on ${req.method} ${req.originalUrl}: ${err.message}`);
  } else {
    console.error('❌ Unhandled Error:', err.stack);
  }

  // ক্লায়েন্টের ভুলে সার্ভারের error_logs ভরানো হয় না — শুধু আসল 5xx লগ হয়
  if (!isClientError) {
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
  }

  const serverErrorMsg = (res.locals && res.locals.t && res.locals.t.server_error) ? res.locals.t.server_error : 'Server Error / সার্ভার ত্রুটি';

  // fetch/AJAX/API কলে HTML পেজ ফেরত পাঠালে client-side JSON.parse ভেঙে যায়,
  // তাই সেসব ক্ষেত্রে JSON error দেওয়া হচ্ছে — raw error message/stack কখনোই client-এ যাচ্ছে না
  const wantsJson = req.xhr
    || (req.headers.accept && req.headers.accept.includes('application/json'))
    || req.path.startsWith('/api')
    || (req.headers['content-type'] || '').includes('json');
  // ক্লায়েন্ট-ত্রুটির জন্য সাধারণ বার্তা; err.message বা stack কখনো ক্লায়েন্টে যায় না
  const clientErrorMsg = statusCode === 413
    ? 'রিকোয়েস্টের আকার অনুমোদিত সীমার চেয়ে বড়।'
    : 'রিকোয়েস্টটি সঠিক ফরম্যাটে নেই।';
  const message = isClientError ? clientErrorMsg : serverErrorMsg;

  if (wantsJson) {
    return res.status(statusCode).json({ success: false, message });
  }

  res.status(statusCode).render('error', {
    message,
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

// ==================== এক্সপোর্ট ====================
// এই ফাইল শুধু Express অ্যাপ্লিকেশন *অবজেক্ট* তৈরি করে — কোনো I/O শুরু করে না।
// DB কানেকশন, মাইগ্রেশন, ব্যাকগ্রাউন্ড ওয়ার্কার/শিডিউলার ও `listen()` সব
// server.js-এ সরানো হয়েছে।
//
// কেন: আগে app.js-এর একদম নিচে `startServer()` কল করা ছিল, তাই শুধু
// `require('../../app.js')` করলেই (যেমন প্রতিটা Jest টেস্ট হেল্পার করে)
// DB কানেকশন + মাইগ্রেশন + startup টাস্ক চালু হয়ে যেত। এর ফলে Jest teardown-এর
// পরেও async কাজ চলত ("Cannot log after tests are done" / "Jest environment has
// been torn down"), মাইগ্রেশন রেস হতো এবং সমান্তরাল টেস্টে কানেকশন contention
// থেকে ECONNRESET পর্যন্ত হতে পারত।
//
// এখন: `require('./app')` = শুধু একটা middleware/route যুক্ত Express অ্যাপ।
// প্রোডাকশন বুট = `node server.js`।
const httpServer = server;
app.set('httpServer', httpServer);
module.exports = app;
module.exports.httpServer = httpServer;
