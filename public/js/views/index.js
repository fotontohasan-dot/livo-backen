// views/index.ejs-এর ক্লায়েন্ট কোড: শুধু Recent Big Wins। গেম গ্রিড/ফিল্টার এখন সম্পূর্ণ সার্ভার-সাইডে।
// docs/CSP.md ধাপ ৩। সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

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
})();
