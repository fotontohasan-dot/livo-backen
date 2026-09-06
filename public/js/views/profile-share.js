// views/profile/share.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function copyLink() {
  const el = document.getElementById('shareLink');
  el.select();
  el.setSelectionRange(0, 99999);
  try {
    document.execCommand('copy');
    alert('লিংক কপি হয়েছে!');
  } catch (e) {
    alert('কপি করা যায়নি, ম্যানুয়ালি কপি করুন।');
  }
}

// আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-copy-link]').forEach(function (el) {
    el.addEventListener('click', copyLink);
  });
});
