// views/tournament-detail.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: আগে ইনলাইন ব্লক ছিল আর সার্ভার-সাইড মান সরাসরি
// JS স্ট্রিং-এর ভেতরে ইনজেক্ট হত। EJS-এর আউটপুট ট্যাগ HTML-এস্কেপ করে, যা
// JS কনটেক্সটের জন্য সঠিক নয়। এখন মানগুলো JSON ডেটা ব্লক থেকে আসে —
// JSON.parse বাদে আর কোনো ব্যাখ্যা লাগে না।

(function(){
  var cfg = {};
  var el = document.getElementById('tournament-detailConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function joinTournament() {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/tournaments/' + encodeURIComponent(cfg.tournamentId) + '/join';
    document.body.appendChild(form);
    form.submit();
  }

  // আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-join-tournament]').forEach(function (el) {
      el.addEventListener('click', joinTournament);
    });
  });
})();
