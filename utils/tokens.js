// utils/tokens.js
// এককালীন টোকেন (পাসওয়ার্ড রিসেট, ইমেইল ভেরিফিকেশন) তৈরি ও হ্যাশ করা।
//
// আগে টোকেন হুবহু `users.reset_token` / `users.verification_token`-এ রাখা
// হতো। ডাটাবেস একবার পড়তে পারলেই — SQL ইনজেকশন, ফাঁস হওয়া ব্যাকআপ, রিড
// অ্যাক্সেস আছে এমন কোনো অভ্যন্তরীণ অ্যাকাউন্ট — প্রতিটা সক্রিয় রিসেট টোকেন
// হাতে চলে আসত, আর সেগুলো দিয়ে যেকোনো অ্যাকাউন্টের পাসওয়ার্ড বদলানো যেত।
//
// এখন ডাটাবেসে যায় শুধু SHA-256 হ্যাশ; আসল টোকেন যায় শুধু ইমেইলে। যাচাইয়ের
// সময় ইউজারের দেওয়া টোকেন হ্যাশ করে মেলানো হয়। হ্যাশ থেকে টোকেন ফিরে পাওয়া
// যায় না, তাই DB পড়তে পারলেও কোনো কাজে লাগে না।
//
// bcrypt নয়, SHA-256 — কারণ টোকেন ৩২ বাইটের র‍্যান্ডম, পাসওয়ার্ডের মতো
// অনুমানযোগ্য নয়। এখানে ব্রুট-ফোর্স প্রতিরোধের জন্য ধীর হ্যাশের দরকার নেই,
// আর প্রতি যাচাইয়ে bcrypt চালানো শুধু খরচ বাড়াত।

const crypto = require('crypto');

const TOKEN_BYTES = 32;

/** নতুন এককালীন টোকেন — ইমেইলে পাঠানোর জন্য। */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** টোকেনের হ্যাশ — এটাই ডাটাবেসে/ক্যাশে রাখা হয়। */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** টোকেন ও তার হ্যাশ একসাথে — জেনারেট করার সময় দুটোই লাগে। */
function issueToken() {
  const token = generateToken();
  return { token, tokenHash: hashToken(token) };
}

module.exports = { generateToken, hashToken, issueToken };
