// views/errors/csrf.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

// PHASE 9: আগে এই লিংকটি একটি inline script URL scheme ব্যবহার করত। strict
  // CSP (script-src থেকে unsafe-inline বাদ) চালু হলে সেই scheme চলে না, তাই
  // লিংকটি নীরবে অকেজো হয়ে যেত। এখন সাধারণ href fallback + progressive
  // enhancement ব্যবহার করা হয়।
  (function historyBackInit() {
    document.querySelectorAll('[data-history-back]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
      });
    });
  })();
