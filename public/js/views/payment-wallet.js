// views/payment/wallet.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function refreshWalletBalance() {
  var icon = document.getElementById('whRefreshIcon');
  icon.classList.add('spinning');
  fetch('/profile/api/balance')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.success) {
        var formatted = '৳ ' + Number(data.coins).toLocaleString('bn-BD');
        document.getElementById('whBalanceText').textContent = formatted;
        document.querySelectorAll('.wh-summary-card .wh-mini-value')[0].textContent = formatted;
        document.querySelectorAll('.wh-summary-card .wh-mini-value')[3].textContent = formatted;
        document.getElementById('whUpdatedText').textContent = 'এখনই';
      }
    })
    .catch(function () {})
    .finally(function () {
      setTimeout(function () { icon.classList.remove('spinning'); }, 400);
    });
}

// আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-refresh-wallet]').forEach(function (el) {
    el.addEventListener('click', refreshWalletBalance);
  });
});
