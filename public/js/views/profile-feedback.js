// views/profile/feedback.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

// ==== রিয়েল-টাইম কনটেন্ট ওয়ার্নিং — টাইপ করার সময় লাল বর্ডার + সাবমিট বাটন ডিসেবল ====
  attachContentFilter('#feedback-message', { submitButton: document.getElementById('feedback-submit') });

  // ==== সাবমিটের সময় শেষবার চেক (ব্যাকএন্ডও যাচাই করবে, এটা শুধু দ্রুত UX ফিডব্যাক) ====
  document.getElementById('feedback-form').addEventListener('submit', function (e) {
    const text = document.getElementById('feedback-message').value;
    if (window.contentFilterIsBad(text)) {
      e.preventDefault();
      alert('⚠️ আপনার লেখায় অনুপযুক্ত/অশ্লীল কনটেন্ট আছে। অনুগ্রহ করে ঠিক করে আবার চেষ্টা করুন।');
    }
  });
