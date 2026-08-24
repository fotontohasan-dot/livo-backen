// utils/i18n.js
// ---------------------------------------------------------------------------
// অনুবাদ হেল্পার — app.js-এর req.t() মিডলওয়্যারের বাইরেও ব্যবহারের জন্য।
//
// কেন দরকার:
//   • rate-limiter কনফিগ module-scope-এ তৈরি হয়, তখন req নেই; আর limiter
//     app.js-এর ভাষা-মিডলওয়্যারের *আগে* বসানো, তাই ওই হ্যান্ডলারে req.t()
//     এখনো সংজ্ঞায়িত নয়।
//   • services/* ফাইলগুলো req পায় না, কিন্তু ইউজারকে দেখানো message তৈরি করে।
//     সেখানে রুট থেকে req.lang পাঠিয়ে t(lang, key) ব্যবহার করা হয়।
//
// locale ফাইল দুটোই app.js যেগুলো পড়ে সেগুলোই — আলাদা কোনো translation
// system নয়, একই bn.json / en.json।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

function load() {
  return {
    bn: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'bn.json'), 'utf8')),
    en: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'))
  };
}

let cache = load();

// অ্যাডমিন প্যানেল locale রিলোড করলে এটাও রিফ্রেশ হবে (app.js থেকে কল করা হয়)।
function refresh() {
  cache = load();
  return cache;
}

function normalizeLang(lang) {
  return lang === 'en' ? 'en' : 'bn';
}

// t('en', 'key') — key না থাকলে key-টাই ফেরত, app.js-এর Proxy-র মতোই আচরণ।
function t(lang, key) {
  const L = normalizeLang(lang);
  return (cache[L] && cache[L][key]) || key;
}

// req থেকে ভাষা বের করে অনুবাদ। ভাষা-মিডলওয়্যারের আগে চললেও session থেকে পড়ে।
function tr(req, key) {
  const lang = (req && req.lang) || (req && req.session && req.session.lang) || 'bn';
  return t(lang, key);
}

// req থেকে শুধু ভাষা কোড — service-এ পাঠানোর জন্য।
function langOf(req) {
  return normalizeLang((req && req.lang) || (req && req.session && req.session.lang) || 'bn');
}

module.exports = { t, tr, langOf, refresh, normalizeLang };
