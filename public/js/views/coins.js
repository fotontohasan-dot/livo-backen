// views/coins.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function claimBonus() {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/coins/daily-bonus';
  document.body.appendChild(form);
  form.submit();
}

// আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-claim-bonus]').forEach(function (el) {
    el.addEventListener('click', claimBonus);
  });
});
