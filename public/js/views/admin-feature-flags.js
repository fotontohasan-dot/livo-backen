// views/admin/feature-flags.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

(function () {
  var search = document.getElementById('ffSearch');
  var noResult = document.getElementById('ffNoResult');
  var filters = Array.prototype.slice.call(document.querySelectorAll('.ff-filter'));
  var cards = Array.prototype.slice.call(document.querySelectorAll('.ff-card'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.ff-group'));
  var state = 'all';

  function apply() {
    var q = (search.value || '').trim().toLowerCase();
    var shown = 0;
    cards.forEach(function (card) {
      var matchText = !q || card.getAttribute('data-search').indexOf(q) !== -1;
      var matchState = state === 'all' || card.getAttribute('data-state') === state;
      var show = matchText && matchState;
      card.style.display = show ? '' : 'none';
      if (show) shown++;
    });
    // যে গ্রুপের সব কার্ড লুকানো, সেই গ্রুপের হেডিংও লুকানো হয় —
    // নাহলে খালি শিরোনামের সারি পড়ে থাকত।
    groups.forEach(function (g) {
      var any = Array.prototype.slice.call(g.querySelectorAll('.ff-card'))
        .some(function (c) { return c.style.display !== 'none'; });
      g.style.display = any ? '' : 'none';
    });
    noResult.style.display = shown === 0 ? '' : 'none';
  }

  search.addEventListener('input', apply);
  filters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filters.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state = btn.getAttribute('data-filter');
      apply();
    });
  });
})();
