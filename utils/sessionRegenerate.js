// utils/sessionRegenerate.js
// লগইন/2FA সম্পন্ন হওয়ার মুহূর্তে সেশন আইডি রোটেট করার জন্য — session fixation প্রতিরোধ।
// req.session.regenerate() পুরো সেশন ডেটা (lang, csrfSecret ইত্যাদি) মুছে নতুন খালি সেশন দেয়,
// তাই কল করার আগের গুরুত্বপূর্ণ ফিল্ড (এখন পর্যন্ত শুধু ভাষা প্রেফারেন্স) সংরক্ষণ করে আবার বসানো হয়।
// csrfSecret ইচ্ছাকৃতভাবে সংরক্ষণ করা হয় না — middleware/csrf.js এটা লেজিলি আবার তৈরি করে নেয়,
// আর নতুন সেশনের জন্য নতুন CSRF সিক্রেট থাকাই বরং সঠিক (পুরনো সেশনের সাথে বাঁধা কোনো টোকেন যেন
// নতুন সেশনে বৈধ না থাকে)।
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== 'function') {
      resolve();
      return;
    }
    const preservedLang = req.session.lang;
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      if (preservedLang) req.session.lang = preservedLang;
      resolve();
    });
  });
}

/**
 * সেশন স্টোরে লেখা শেষ না হওয়া পর্যন্ত অপেক্ষা করে।
 *
 * কেন দরকার: express-session ডিফল্টে রেসপন্স পাঠানোর সাথে সাথে (fire-and-forget)
 * স্টোরে লেখে। লগইনের ঠিক পরেই যখন redirect করা হয়, ব্রাউজার নতুন সেশন কুকি নিয়ে
 * পরের রিকোয়েস্ট পাঠিয়ে দিতে পারে *তার আগেই* — অর্থাৎ PostgreSQL সেশন স্টোরে
 * সারিটা তখনো কমিট হয়নি। তখন express-session ওই sid খুঁজে না পেয়ে একদম নতুন
 * (খালি) সেশন বানায়, req.session.user থাকে না, আর ইউজার/অ্যাডমিন সঙ্গে সঙ্গে
 * আবার লগইন পেজে ফেরত যায়। সেশন রোটেশনের (regenerate) পর ঝুঁকিটা সবচেয়ে বেশি,
 * কারণ পুরনো sid ততক্ষণে মুছে ফেলা হয়েছে।
 *
 * তাই redirect করার আগে এখানে স্পষ্টভাবে save() সম্পন্ন হওয়ার জন্য অপেক্ষা করা হয়।
 */
function saveSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.save !== 'function') {
      resolve();
      return;
    }
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { regenerateSession, saveSession };
