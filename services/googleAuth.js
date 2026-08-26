// services/googleAuth.js
// Google Sign-In (OAuth 2.0 Authorization Code flow + OpenID Connect ID token).
// এই মডিউল শুধু Google-এর সাথে টোকেন এক্সচেঞ্জ/ভেরিফিকেশন করে — session/login establishment
// routes/auth.js-এর completeLogin()-এই হয় (ইমেইল/ফোন লগইনের সাথে ঠিক একই পথ, আলাদা কোনো
// সেশন-লজিক তৈরি করা হয়নি)।
const { OAuth2Client } = require('google-auth-library');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function getClient(redirectUri) {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri);
}

// google-auth-library-এর getToken()/verifyIdToken() নিজে কোনো timeout option দেয় না —
// Google-এর টোকেন এন্ডপয়েন্ট/সার্টিফিকেট সার্ভার ধীর হলে বা সাড়া না দিলে এই কল অনির্দিষ্টকাল
// ঝুলে থাকতে পারে (services/sslcommerz.js-এ একই কারণে fetch timeout যোগ করা হয়েছে)।
// Promise.race দিয়ে caller-এর অপেক্ষা bounded রাখা হচ্ছে।
const GOOGLE_AUTH_TIMEOUT_MS = Number(process.env.GOOGLE_AUTH_TIMEOUT_MS) || 15000;

function withTimeout(promise, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), GOOGLE_AUTH_TIMEOUT_MS))
  ]);
}

/**
 * Google-এর consent স্ক্রিনের URL তৈরি করে। state ও nonce — দুটোই caller-কে (routes/auth.js)
 * ক্রিপ্টোগ্রাফিকভাবে র‍্যান্ডম তৈরি করে সেশনে সেভ করতে হয়, এই ফাংশন শুধু সেগুলো URL-এ বসায়।
 * state = CSRF/replay সুরক্ষা (callback-এ ফেরত আসা state সেশনে সেভ করা state-এর সাথে মিলতে হবে)।
 * nonce = OpenID Connect replay সুরক্ষা (id_token-এর ভেতরে ফেরত আসে, verifyIdToken-এর পর মেলানো হয়)।
 */
function generateAuthUrl(redirectUri, state, nonce) {
  const client = getClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    nonce,
    prompt: 'select_account'
  });
}

/**
 * Authorization code-কে টোকেনে এক্সচেঞ্জ করে, id_token-কে Google-এর পাবলিক কী দিয়ে সার্ভার-সাইডে
 * cryptographically ভেরিফাই করে (স্বাক্ষর, issuer, audience, expiry — google-auth-library নিজেই
 * পুরোটা করে), এবং nonce মেলায়। সফল হলে যাচাইকৃত প্রোফাইল রিটার্ন করে — ব্যর্থ হলে throw করে
 * (caller-এর দায়িত্ব ক্যাচ করে ইউজার-বান্ধব এরর দেখানো)।
 */
async function exchangeCodeForProfile(redirectUri, code, expectedNonce) {
  const client = getClient(redirectUri);
  const { tokens } = await withTimeout(client.getToken(code), 'Google থেকে সময়মতো সাড়া পাওয়া যায়নি (timeout)');
  if (!tokens || !tokens.id_token) throw new Error('Google থেকে id_token পাওয়া যায়নি');

  const ticket = await withTimeout(
    client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID }),
    'Google id_token ভেরিফিকেশনে সময়মতো সাড়া পাওয়া যায়নি (timeout)'
  );
  const payload = ticket.getPayload();
  if (!payload) throw new Error('id_token পেলোড খালি (ভেরিফিকেশন ব্যর্থ)');
  if (!payload.sub) throw new Error('id_token-এ sub (Google user id) নেই');
  if (!expectedNonce || payload.nonce !== expectedNonce) {
    throw new Error('nonce মিলছে না — সম্ভাব্য replay/CSRF চেষ্টা');
  }

  return {
    googleId: payload.sub,
    email: payload.email || null,
    emailVerified: payload.email_verified === true,
    name: payload.name || null,
    picture: payload.picture || null
  };
}

module.exports = { isConfigured, generateAuthUrl, exchangeCodeForProfile };
