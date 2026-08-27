// ==================== শেয়ার্ড ট্রাস্টেড-অরিজিন পলিসি ====================
// আগে HTTP CORS-এ একটা কড়া allow-list ছিল, কিন্তু Socket.IO আলাদাভাবে `origin: "*"`
// দিয়ে ইনিশিয়ালাইজ হতো — অর্থাৎ যেকোনো ওয়েবসাইট ব্রাউজারের সেশন কুকি সমেত এই সার্ভারের
// Socket.IO handshake করতে পারত এবং লগইন করা ইউজারের প্রাইভেট রুমের ইভেন্ট পড়তে পারত।
// দুই লেয়ারে একই পলিসি থাকা দরকার, তাই সেটা এখানে একবারই সংজ্ঞায়িত করা হচ্ছে।

const DEFAULT_ORIGINS = [
  'https://livo-backen.onrender.com',
  'http://localhost:3000',
];

const LOCALHOST_ANY_PORT = /^http:\/\/localhost:\d+$/;

// কাস্টম ডোমেইন কেনা হলে কোড না বদলে ALLOWED_ORIGINS env var-এ কমা-সেপারেটেড করে দেওয়া যাবে।
const ENV_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...ENV_ORIGINS])];

/**
 * @param {string|undefined|null} origin  Origin হেডারের মান
 * @param {{ allowMissing?: boolean }} [opts]
 *   allowMissing — Origin হেডার একদম না থাকা (server-to-server, cURL, নেটিভ HTTP ক্লায়েন্ট)
 *   অনুমোদিত কিনা। ব্রাউজার-চালিত cross-site অ্যাটাক সবসময় Origin পাঠায়, তাই ডিফল্ট true।
 *   Origin: "null" (sandboxed iframe, data:/file: URL) কখনোই অনুমোদিত নয় — সেটা ঠিক সেই
 *   ভেক্টর যা credentialed cross-origin অ্যাটাকে ব্যবহার করা যায়।
 */
function isAllowedOrigin(origin, opts = {}) {
  const allowMissing = opts.allowMissing !== false;
  if (!origin) return allowMissing;
  if (origin === 'null') return false;
  return ALLOWED_ORIGINS.includes(origin) || LOCALHOST_ANY_PORT.test(origin);
}

module.exports = { ALLOWED_ORIGINS, LOCALHOST_ANY_PORT, isAllowedOrigin };
