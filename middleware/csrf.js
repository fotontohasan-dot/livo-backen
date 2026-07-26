// middleware/csrf.js
// ==================== CSRF সুরক্ষা (Synchronizer Token Pattern) ====================
// প্রতিটা সেশনের জন্য একটা গোপন টোকেন সার্ভার-সাইড সেশনে (req.session.csrfSecret) জমা থাকে।
// GET রিকোয়েস্টে সেই টোকেন view-এ পাঠানো হয় (res.locals.csrfToken + <meta> ট্যাগ),
// আর POST/PUT/PATCH/DELETE রিকোয়েস্টে ফর্ম-ফিল্ড (_csrf) বা হেডার (X-CSRF-Token) থেকে
// পাঠানো টোকেনের সাথে মিলিয়ে যাচাই করা হয়। মিল না হলে অনুরোধ প্রত্যাখ্যাত হয়।
//
// csurf প্যাকেজ deprecated হওয়ায় এখানে একই প্যাটার্নের নিজস্ব হালকা ইমপ্লিমেন্টেশন —
// এই রিপোজিটরির বাকি নিরাপত্তা মিডলওয়্যারগুলোর (origin-check, maintenance, rate-limit)
// মতোই কোনো এক্সট্রা ডিপেন্ডেন্সি ছাড়া।

const crypto = require('crypto');

// এই পাথগুলোতে সেশন/কুকি-ভিত্তিক অথ ব্যবহার হয় না (API-key বা এক্সটার্নাল ওয়েবহুক) —
// তাই CSRF চেক এখানে প্রযোজ্য না।
const EXEMPT_PREFIXES = [
  '/api/',           // পাবলিক API — API key দিয়ে অথেন্টিকেটেড (routes/api.js + middleware/apiKeyAuth)
  '/payment/sslcommerz/' // পেমেন্ট গেটওয়ের সার্ভার-টু-সার্ভার কলব্যাক/IPN — কোনো ব্রাউজার সেশন নেই
];
const EXEMPT_EXACT = ['/health', '/ready', '/telegram-webhook']; // টেলিগ্রাম-নিজস্ব secret-token যাচাই থাকে, CSRF প্রযোজ্য না

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isExempt(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  if (EXEMPT_EXACT.includes(req.path)) return true;
  return EXEMPT_PREFIXES.some(prefix => req.path.startsWith(prefix));
}

function getOrCreateSecret(req) {
  if (!req.session) return null; // সেশন মিডলওয়্যার আগে না চললে নিরাপদে skip
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfSecret;
}

function extractSubmittedToken(req) {
  return (
    (req.body && req.body._csrf) ||
    (req.query && req.query._csrf) ||
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token') ||
    null
  );
}

function isAjaxOrJson(req) {
  const accept = req.get('accept') || '';
  const contentType = req.get('content-type') || '';
  return (
    req.xhr ||
    req.get('x-requested-with') === 'XMLHttpRequest' ||
    accept.includes('application/json') ||
    contentType.includes('application/json')
  );
}

function sendCsrfError(req, res) {
  const message = 'Invalid or Expired CSRF Token';
  if (isAjaxOrJson(req)) {
    return res.status(403).json({ success: false, error: message, code: 'CSRF_TOKEN_INVALID' });
  }
  res.status(403);
  try {
    return res.render('errors/csrf', { message });
  } catch (e) {
    // View না থাকলে (যেমন খুব শুরুর দিকে বুট এরর) সাদাসিধা ফলব্যাক
    return res.type('html').send(
      '<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><title>403 — Invalid CSRF Token</title></head>' +
      '<body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#0f172a;color:#fff;">' +
      '<h1 style="color:#f87171;">🚫 Invalid or Expired CSRF Token</h1>' +
      '<p style="color:#94a3b8;">আপনার সেশনের মেয়াদ শেষ হয়ে গেছে অথবা ফর্মটি অনেক পুরোনো। পেজটি রিফ্রেশ করে আবার চেষ্টা করুন।</p>' +
      '<a href="javascript:history.back()" style="color:#eab308;">← পেছনে যান</a>' +
      '</body></html>'
    );
  }
}

/**
 * সব রিকোয়েস্টে চলে: GET-এ টোকেন জেনারেট/এক্সপোজ করে (res.locals.csrfToken),
 * state-changing মেথডে টোকেন যাচাই করে।
 */
function csrfProtection(req, res, next) {
  if (isExempt(req)) {
    // এক্সেম্পট পাথেও যদি সেশন থাকে, ভিউ-এর জন্য টোকেন এক্সপোজ করে রাখা ক্ষতিকর না
    if (req.session) res.locals.csrfToken = getOrCreateSecret(req);
    return next();
  }

  const secret = getOrCreateSecret(req);

  if (SAFE_METHODS.has(req.method)) {
    res.locals.csrfToken = secret;
    return next();
  }

  // সেশনই না থাকলে (স্টোর ডাউন ইত্যাদি) ব্লক না করে যেতে দেওয়া হয় — বিদ্যমান origin-check
  // মিডলওয়্যার ইতিমধ্যেই cross-origin POST আটকায়; এটা সেই সুরক্ষার উপর একটা অতিরিক্ত স্তর।
  if (!secret) return next();

  const submitted = extractSubmittedToken(req);
  if (!submitted || submitted !== secret) {
    return sendCsrfError(req, res);
  }

  res.locals.csrfToken = secret;
  next();
}

module.exports = { csrfProtection };
