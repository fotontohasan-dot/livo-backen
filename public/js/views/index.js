// views/index.ejs-এর ক্লায়েন্ট কোড: Recent Big Wins + প্রোমো ব্যানার স্লাইডার।
// গেম ফিল্টার/সার্চ/A-Z এখন সার্ভার-সাইডে (সাধারণ GET লিংক), তাই এখানে আর কোনো গেম-রেন্ডার নেই।
// কোনো লাইব্রেরি নেই; ব্রাউজার-নেটিভ scroll-snap।

(function(){
  // ---- প্রথম ইনলাইন ব্লক (আগের ব্যাচে সরানো) ----
  (function () {
    var box = document.getElementById('winsContainer');
    var state = document.getElementById('winsState');
    if (!box || !state) return;

    function esc(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function money(n) {
      return '৳ ' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    fetch('/games/api/recent-wins', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var wins = (data && data.wins) || [];
        if (!wins.length) {
          // কোনো বানানো ডেটা নয় — সত্যিকারের খালি অবস্থা
          state.textContent = 'এখনো কোনো বড় জয় নেই। প্রথম হোন!';
          return;
        }
        box.innerHTML = wins.map(function (w) {
          return '<div class="win-item">'
            + '<div><span>' + esc(w.user) + '</span><br>'
            + '<span class="game-name">' + esc(w.game) + '</span></div>'
            + '<div class="win-amount">' + money(w.amount) + '</div>'
            + '</div>';
        }).join('');
      })
      .catch(function () {
        state.textContent = 'সাম্প্রতিক জয় লোড করা যায়নি।';
      });
  })();


  // ---- প্রোমো ব্যানার স্লাইডার (স্ক্রল-স্ন্যাপ + prev/next + ধীর অটো-অ্যাডভান্স) ----
  (function () {
    var track = document.getElementById('homeBanners');
    if (!track) return;
    var prev = document.getElementById('hbPrev');
    var next = document.getElementById('hbNext');
    var slides = track.children.length;
    function step(dir) {
      var w = track.clientWidth;
      var atEnd = track.scrollLeft + w >= track.scrollWidth - 2;
      var atStart = track.scrollLeft <= 2;
      if (dir > 0 && atEnd) track.scrollTo({ left: 0 });
      else if (dir < 0 && atStart) track.scrollTo({ left: track.scrollWidth });
      else track.scrollBy({ left: dir * w });
    }
    if (prev) prev.addEventListener('click', function () { step(-1); });
    if (next) next.addEventListener('click', function () { step(1); });
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
    });
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (slides > 1 && !reduce) {
      var paused = false;
      ['mouseenter', 'focusin', 'touchstart'].forEach(function (ev) { track.parentNode.addEventListener(ev, function () { paused = true; }); });
      ['mouseleave', 'focusout'].forEach(function (ev) { track.parentNode.addEventListener(ev, function () { paused = false; }); });
      setInterval(function () { if (!paused && !document.hidden) step(1); }, 5000);
    }
  })();
})();
