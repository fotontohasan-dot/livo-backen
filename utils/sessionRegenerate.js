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

module.exports = { regenerateSession };
