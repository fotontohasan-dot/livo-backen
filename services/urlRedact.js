// services/urlRedact.js
// ---------------------------------------------------------------------------
// URL/Endpoint যেকোনো জায়গায় লগ করার আগে (api_usage_logs, error_logs, audit_logs)
// সংবেদনশীল টোকেন (পাসওয়ার্ড-রিসেট, ইমেইল-ভেরিফিকেশন লিংকের /:token পার্ট, বা কোনো
// ?token=/?secret=/?key= কোয়েরি-প্যারামিটার) মাস্ক করে দেয়, যাতে DB-তে বা কনসোলে
// প্লেইন-টেক্সট সিক্রেট জমা না হয়। রুট/ফিচার আচরণ অপরিবর্তিত থাকে — শুধু logging layer।
// ---------------------------------------------------------------------------

const TOKEN_PATH_PATTERNS = [
  /\/(reset-password)\/[^/?#]+/i,
  /\/(verify-email)\/[^/?#]+/i,
];

const SENSITIVE_QUERY_KEYS = ['token', 'secret', 'key', 'password', 'pin', 'otp', 'code', 'auth'];

function redactUrl(url) {
  if (!url || typeof url !== 'string') return url;
  let out = url;

  // পাথ-ভিত্তিক টোকেন (/reset-password/xxxxx, /verify-email/xxxxx)
  for (const pattern of TOKEN_PATH_PATTERNS) {
    out = out.replace(pattern, (match, routeName) => `/${routeName}/***REDACTED***`);
  }

  // কোয়েরি-স্ট্রিং-এ সংবেদনশীল কী থাকলে মাস্ক (?token=abc123 -> ?token=***REDACTED***)
  try {
    const [pathPart, queryPart] = out.split('?');
    if (queryPart) {
      const params = new URLSearchParams(queryPart);
      let changed = false;
      for (const key of params.keys()) {
        if (SENSITIVE_QUERY_KEYS.some(s => key.toLowerCase().includes(s))) {
          params.set(key, '***REDACTED***');
          changed = true;
        }
      }
      out = changed ? `${pathPart}?${params.toString()}` : out;
    }
  } catch (e) {
    // URLSearchParams পার্স ব্যর্থ হলে যেটুকু path-based redact হয়েছে সেটাই যথেষ্ট, ব্যর্থতায় মূল কাজ থামবে না
  }

  return out;
}

module.exports = { redactUrl };
