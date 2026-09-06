// views/admin/contest-payouts.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function openMarkPaid(id, username) {
      document.getElementById('markPaidUsername').textContent = '@' + username;
      document.getElementById('markPaidForm').action = '/admin/leaderboard/contest/payouts/' + id + '/mark-paid';
      document.getElementById('markPaidModal').classList.add('show');
    }
  
    // "Mark paid" বাটন — আগে ইউজারনেম ইনলাইন onclick-এর আর্গুমেন্ট হিসেবে
    // যেত, তাই টেমপ্লেটে হাতে করে কোট-এস্কেপ করতে হত। এখন data-* মান,
    // ব্রাউজারই অ্যাট্রিবিউট পার্স করে (docs/CSP.md ধাপ ২)।
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('[data-markpaid-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openMarkPaid(btn.getAttribute('data-markpaid-id'), btn.getAttribute('data-markpaid-name'));
        });
      });
    });
