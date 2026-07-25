// services/sentry.js
// ---------------------------------------------------------------------------
// কেন্দ্রীয় Sentry মনিটরিং মডিউল — Error + Performance Monitoring।
// SENTRY_DSN এনভায়রনমেন্ট ভ্যারিয়েবল না থাকলে (বা SENTRY_ENABLED=false হলে)
// পুরো মডিউলটা no-op হিসেবে কাজ করে — অ্যাপ স্বাভাবিকভাবেই চলতে থাকে,
// কোথাও ক্র্যাশ করে না। তাই এই ফিচার সম্পূর্ণ ঐচ্ছিক ও Backward Compatible।
// ---------------------------------------------------------------------------

const Sentry = require('@sentry/node');

const DSN = process.env.SENTRY_DSN || '';
const EXPLICITLY_DISABLED = String(process.env.SENTRY_ENABLED || '').toLowerCase() === 'false';
const ENABLED = !!DSN && !EXPLICITLY_DISABLED;

const ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
const RELEASE = process.env.SENTRY_RELEASE
  || process.env.RENDER_GIT_COMMIT // Render প্রতিটা ডিপ্লয়ে এই env var অটো সেট করে দেয়
  || (() => { try { return require('../package.json').version; } catch (e) { return 'unknown'; } })();

const TRACES_SAMPLE_RATE = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1);
const PROFILES_SAMPLE_RATE = Number(process.env.SENTRY_PROFILES_SAMPLE_RATE || 0);

let initialized = false;

function init() {
  if (!ENABLED) {
    console.log('ℹ️ Sentry নিষ্ক্রিয় (SENTRY_DSN সেট করা নেই বা SENTRY_ENABLED=false) — মনিটরিং ছাড়াই স্বাভাবিকভাবে চলবে।');
    return false;
  }
  try {
    Sentry.init({
      dsn: DSN,
      environment: ENVIRONMENT,
      release: `livo-backend@${RELEASE}`,
      tracesSampleRate: TRACES_SAMPLE_RATE,
      integrations: [
        Sentry.httpIntegration(),
        Sentry.expressIntegration(),
        Sentry.postgresIntegration ? Sentry.postgresIntegration() : null
      ].filter(Boolean),
      beforeSend(event) {
        // ইউজারের পাসওয়ার্ড/টোকেন ইত্যাদি ভুলবশত রিকোয়েস্ট বডিতে চলে গেলেও যাতে
        // Sentry-তে না যায় — সংবেদনশীল ফিল্ড রিড্যাক্ট করা
        if (event.request && event.request.data && typeof event.request.data === 'object') {
          const redactKeys = ['password', 'confirmPassword', 'token', 'pin', 'otp', 'secret', 'totp_secret', 'card_number', 'cvv'];
          redactKeys.forEach((k) => {
            if (k in event.request.data) event.request.data[k] = '[Filtered]';
          });
        }
        return event;
      }
    });
    initialized = true;
    console.log(`✅ Sentry মনিটরিং চালু হয়েছে (environment: ${ENVIRONMENT}, release: ${RELEASE})`);
    return true;
  } catch (err) {
    console.error('❌ Sentry init ব্যর্থ হয়েছে:', err.message);
    return false;
  }
}

function isEnabled() {
  return ENABLED && initialized;
}

/** Express app-এ error handler বসানো — নিজের error handler-এর ঠিক আগে কল করতে হবে */
function attachExpressErrorHandler(app) {
  if (!isEnabled()) return;
  Sentry.setupExpressErrorHandler(app);
}

/** ম্যানুয়ালি কোনো এরর রিপোর্ট করার জন্য (queue job, cron job, ইত্যাদি জায়গায় ব্যবহারের জন্য) */
function captureException(err, context = {}) {
  if (!isEnabled()) return;
  try {
    Sentry.captureException(err, { extra: context });
  } catch (e) {
    console.error('Sentry captureException নিজেই ব্যর্থ হয়েছে:', e.message);
  }
}

function captureMessage(message, level = 'info', context = {}) {
  if (!isEnabled()) return;
  try {
    Sentry.captureMessage(message, { level, extra: context });
  } catch (e) {
    console.error('Sentry captureMessage নিজেই ব্যর্থ হয়েছে:', e.message);
  }
}

function addBreadcrumb(breadcrumb) {
  if (!isEnabled()) return;
  try {
    Sentry.addBreadcrumb(breadcrumb);
  } catch (e) { /* silent — breadcrumb ব্যর্থ হলে অ্যাপ থামবে না */ }
}

/** req.session.user থেকে Sentry-তে ইউজার কনটেক্সট বসানোর মিডলওয়্যার */
function userContextMiddleware(req, res, next) {
  if (isEnabled() && req.session && req.session.user) {
    Sentry.setUser({
      id: String(req.session.user.id),
      username: req.session.user.username,
      role: req.session.user.role || 'user'
    });
  }
  next();
}

function getStatus() {
  return {
    enabled: ENABLED,
    initialized,
    environment: ENVIRONMENT,
    release: RELEASE,
    dsnConfigured: !!DSN,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    profilesSampleRate: PROFILES_SAMPLE_RATE,
    dsnMasked: DSN ? DSN.replace(/\/\/([^@]+)@/, '//***@') : null
  };
}

module.exports = {
  Sentry,
  init,
  isEnabled,
  attachExpressErrorHandler,
  captureException,
  captureMessage,
  addBreadcrumb,
  userContextMiddleware,
  getStatus
};
