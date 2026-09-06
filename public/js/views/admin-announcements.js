// views/admin/announcements.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function toggleTargetFields() {
      const v = document.getElementById('targetType').value;
      document.getElementById('roleField').style.display = v === 'role' ? 'grid' : 'none';
      document.getElementById('userField').style.display = v === 'user' ? 'grid' : 'none';
    }
  
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-toggle-target-fields]').forEach(function (el) {
    el.addEventListener('change', toggleTargetFields);
  });
});
