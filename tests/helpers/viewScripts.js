// docs/CSP.md ধাপ ৩-এ টেমপ্লেটের ইনলাইন <script> ব্লকগুলো
// public/js/views/<slug>.js-এ সরানো হয়েছে। ফলে যেসব টেস্ট আগে টেমপ্লেটের
// (বা রেন্ডার করা HTML-এর) ভেতরে JS কোড খুঁজত, তারা আর সেটা পায় না।
//
// এই হেল্পারটা টেমপ্লেট/HTML আর তার লোড করা স্ক্রিপ্ট ফাইলগুলো জোড়া দিয়ে
// একটাই স্ট্রিং দেয় — অর্থাৎ "এই পেজে এই কোডটা চলে" প্রশ্নটার উত্তর আগের
// মতোই পাওয়া যায়, শুধু কোডটা এখন যেখানে আছে সেখান থেকে।
//
// সতর্কতা: এটা "কোড কোথাও আছে" যাচাইয়ের জন্য। কোন ফাইল আগে লোড হয় সেই
// ক্রম যাচাই করতে হলে scriptOrder() ব্যবহার করতে হবে।

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// HTML/টেমপ্লেটে লোড করা সব লোকাল স্ক্রিপ্টের পাথ, যে ক্রমে আছে সেই ক্রমেই
function scriptOrder(src) {
  return [...src.matchAll(/<script src="(\/js\/[^"]+)"><\/script>/g)].map((m) => m[1]);
}

function readScript(url) {
  const file = path.join(ROOT, 'public', url.replace(/^\//, ''));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// টেমপ্লেট/HTML + তার লোড করা স্ক্রিপ্টগুলো একসাথে
function withScripts(src) {
  return [src, ...scriptOrder(src).map(readScript)].join('\n');
}

// একটা টেমপ্লেট ফাইল পড়ে, তার স্ক্রিপ্টসহ
function readViewWithScripts(...viewPath) {
  return withScripts(fs.readFileSync(path.join(ROOT, ...viewPath), 'utf8'));
}

module.exports = { ROOT, scriptOrder, readScript, withScripts, readViewWithScripts };
