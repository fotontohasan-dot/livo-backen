// views/admin/partials/sidebar.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function toggleAdminSidebar(force) {
  var sb = document.getElementById('adminSidebar');
  var ov = document.getElementById('adminOverlay');
  var show = force !== undefined ? force : !sb.classList.contains('open');
  sb.classList.toggle('open', show);
  ov.classList.toggle('show', show);
}

function updateAdminNavBadges() {
  fetch('/admin/pending-counts').then(function(r){ return r.json(); }).then(function(data){
    var payBadge = document.getElementById('navBadgePayments');
    var kycBadge = document.getElementById('navBadgeKyc');
    var payTotal = (data.deposits || 0) + (data.withdrawals || 0);
    if (payBadge) {
      if (payTotal > 0) { payBadge.textContent = payTotal; payBadge.style.display = 'inline-block'; }
      else { payBadge.style.display = 'none'; }
    }
    if (kycBadge) {
      if (data.kyc > 0) { kycBadge.textContent = data.kyc; kycBadge.style.display = 'inline-block'; }
      else { kycBadge.style.display = 'none'; }
    }
  }).catch(function(){});
}
updateAdminNavBadges();
setInterval(updateAdminNavBadges, 20000);

// সাইডবার টগল — আগে তিনটে partial-এ ইনলাইন onclick ছিল (header.ejs,
// admin/partials/header.ejs, এই ফাইল)। ফাংশনটা এখানেই সংজ্ঞায়িত, তাই
// বাঁধাও এখানে; ডেলিগেশন ব্যবহার করা হয়েছে কারণ header partial গুলো এই
// স্ক্রিপ্টের আগে বা পরে — যেকোনো ক্রমে — রেন্ডার হতে পারে।
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var el = e.target.closest('[data-admin-sidebar]');
  if (!el) return;
  if (el.getAttribute('data-admin-sidebar') === 'close') toggleAdminSidebar(false);
  else toggleAdminSidebar();
});
