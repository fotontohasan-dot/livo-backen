// views/sports/index.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('sports-indexConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  (function () {
    var LIVE = document.getElementById('spLive');
    var UP = document.getElementById('spUpcoming');
    var TABS = document.getElementById('spTabs');
    var filter = cfg.currentPage;
    var data = { cricket: [], football: [] };
    var T = {
      empty: cfg.noMatches,
      view: cfg.viewAll
    };

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function timeLabel(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      try {
        return d.toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'bn-BD',
          { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
    }

    function oddsRow(m) {
      var o = m.odds;
      if (!o || o.home == null || o.away == null) {
        return '<span class="sp-cta">' + esc(T.view) + '</span>';
      }
      var cells = [['1', o.home], ['X', o.draw], ['2', o.away]]
        .filter(function (c) { return c[1] != null; })
        .map(function (c) { return '<div class="sp-odd"><span>' + c[0] + '</span><span>' + esc(c[1]) + '</span></div>'; });
      return '<div class="sp-odds">' + cells.join('') + '</div>';
    }

    function card(m) {
      var isLive = m.status === 'live';
      var score = (isLive || m.homeScore != null)
        ? '<div class="sp-score">' + esc(m.homeScore == null ? '-' : m.homeScore) + ' - ' + esc(m.awayScore == null ? '-' : m.awayScore) + '</div>'
        : '<div class="sp-score is-time">' + esc(timeLabel(m.date)) + '</div>';
      return '<a class="sp-match" href="/matches/' + esc(m.id) + '">' +
        '<div class="sp-match__head">' +
          '<span class="sp-match__league">' + esc(m.league || m.name || '') + '</span>' +
          '<span class="sp-match__state' + (isLive ? '' : ' is-upcoming') + '">' +
            (isLive ? 'LIVE' + (m.overs ? ' ' + esc(m.overs) : '') : esc(timeLabel(m.date))) +
          '</span>' +
        '</div>' +
        '<div class="sp-match__teams">' +
          '<span class="sp-team"><span class="team-crest" data-team="' + esc(m.homeTeam) + '" data-size="22"></span>' +
            '<span class="sp-team__name">' + esc(m.homeTeam) + '</span></span>' +
          score +
          '<span class="sp-team away"><span class="sp-team__name">' + esc(m.awayTeam) + '</span>' +
            '<span class="team-crest" data-team="' + esc(m.awayTeam) + '" data-size="22"></span></span>' +
        '</div>' +
        oddsRow(m) +
      '</a>';
    }

    function pick() {
      var all;
      if (filter === 'football') all = data.football;
      else if (filter === 'cricket') all = data.cricket;
      else all = data.football.concat(data.cricket);
      if (filter === 'live') all = all.filter(function (m) { return m.status === 'live'; });
      return all;
    }

    function paint() {
      var all = pick();
      var live = all.filter(function (m) { return m.status === 'live'; });
      var up = all.filter(function (m) { return m.status !== 'live'; }).slice(0, 12);
      LIVE.innerHTML = live.length ? live.map(card).join('') : '<div class="sp-empty">' + esc(T.empty) + '</div>';
      UP.innerHTML = up.length ? up.map(card).join('') : '<div class="sp-empty">' + esc(T.empty) + '</div>';
      if (window.LivoCrest) window.LivoCrest.render();
    }

    TABS.addEventListener('click', function (e) {
      var btn = e.target.closest('.sp-tab');
      if (!btn) return;
      TABS.querySelectorAll('.sp-tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      filter = btn.getAttribute('data-filter');
      paint();
    });

    document.getElementById('spFilterBtn').addEventListener('click', function () {
      TABS.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    function load() {
      fetch('/matches/api/live', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          data.cricket = (d && d.cricket) || [];
          data.football = (d && d.football) || [];
          paint();
        })
        .catch(function () { paint(); });
    }

    var pre = TABS.querySelector('.sp-tab[data-filter="' + filter + '"]');
    if (pre) {
      TABS.querySelectorAll('.sp-tab').forEach(function (b) { b.classList.remove('active'); });
      pre.classList.add('active');
    }

    load();
    setInterval(load, 30000);
  })();
})();
