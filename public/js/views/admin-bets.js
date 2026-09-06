// views/admin/bets.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: এই পেজের body একটা JS template literal, তাই সার্ভার
// মান ${...} দিয়ে আসত। এখন সেগুলো JSON ডেটা ব্লক থেকে পড়া হয়।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-betsConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  (function() {
    var currentStatus = cfg.status;
    var currentPage = cfg.page;

    function fmtCompact(n) {
      n = Number(n) || 0;
      var sign = n < 0 ? '-' : '';
      var abs = Math.abs(n);
      if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
      if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
      return sign + abs.toLocaleString('en-US');
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function betRow(b) {
      var statusColor = b.status === 'won' ? 'bg-emerald-100 text-emerald-700' : b.status === 'lost' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700';
      var statusLabel = b.status === 'won' ? 'Won' : b.status === 'lost' ? 'Lost' : 'Pending';
      var matchName = b.title || (b.team_a ? (b.team_a + ' vs ' + b.team_b) : 'N/A');
      var actions = b.status === 'pending'
        ? '<div class="flex items-center justify-center gap-x-2">' +
            '<form method="POST" action="/admin/bets/' + b.id + '/settle" data-confirm="এই বেট WIN হিসেবে সেটেল করবেন?" style="display:inline">' +
              '<input type="hidden" name="result" value="won">' +
              '<button type="submit" class="px-4 py-1.5 text-xs font-semibold rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white transition-colors">WIN</button>' +
            '</form>' +
            '<form method="POST" action="/admin/bets/' + b.id + '/settle" data-confirm="এই বেট LOSE হিসেবে সেটেল করবেন?" style="display:inline">' +
              '<input type="hidden" name="result" value="lost">' +
              '<button type="submit" class="px-4 py-1.5 text-xs font-semibold rounded-xl bg-rose-500 hover:bg-rose-600 text-white transition-colors">LOSE</button>' +
            '</form>' +
          '</div>'
        : '<span class="text-slate-500 font-semibold text-sm">Settled</span>';
      return '<tr class="hover:bg-slate-50">' +
        '<td class="px-6 py-4"><div class="font-mono text-xs text-slate-400">#B-' + b.id + '</div><div class="font-semibold text-slate-800">' + escapeHtml(b.username) + '</div></td>' +
        '<td class="px-6 py-4"><div class="font-medium text-slate-800">' + escapeHtml(matchName) + '</div><div class="text-emerald-600 text-xs">' + escapeHtml(b.runner || b.market_type || '') + '</div></td>' +
        '<td class="px-6 py-4"><span class="font-semibold">৳ ' + Number(b.stake).toLocaleString('en-US') + '</span></td>' +
        '<td class="px-6 py-4"><span class="font-mono bg-slate-100 px-2.5 py-1 rounded-lg text-xs">' + Number(b.odd).toFixed(2) + '</span></td>' +
        '<td class="px-6 py-4"><span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ' + statusColor + '">' + statusLabel + '</span></td>' +
        '<td class="px-6 py-4">' + actions + '</td>' +
      '</tr>';
    }

    function refreshBets() {
      var qs = '?page=' + currentPage + (currentStatus ? '&status=' + currentStatus : '');
      fetch('/admin/api/bets-live' + qs)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.success) return;
          var body = document.getElementById('betsTableBody');
          if (body) {
            body.innerHTML = data.bets.length
              ? data.bets.map(betRow).join('')
              : '<tr><td colspan="6" class="px-6 py-10 text-center text-slate-400">কোনো বেট পাওয়া যায়নি</td></tr>';
          }
          var elTotal = document.getElementById('statTotalBets');
          var elPending = document.getElementById('statPending');
          var elStake = document.getElementById('statStake');
          var elGgr = document.getElementById('statGgr');
          if (elTotal) elTotal.textContent = Number(data.total || 0).toLocaleString('en-US');
          if (elPending) elPending.textContent = data.pendingSettlement || 0;
          if (elStake) elStake.textContent = '৳ ' + fmtCompact(data.todayStake);
          if (elGgr) {
            elGgr.textContent = '৳ ' + fmtCompact(data.todayGgr);
            elGgr.className = elGgr.className.replace(/text-(emerald|red)-600/, data.todayGgr >= 0 ? 'text-emerald-600' : 'text-red-600');
          }
          var dot = document.getElementById('liveDot');
          if (dot) { dot.style.opacity = '0.3'; setTimeout(function(){ dot.style.opacity = '1'; }, 300); }
        })
        .catch(function() {});
    }

    setInterval(refreshBets, 4000);
  })();
})();
