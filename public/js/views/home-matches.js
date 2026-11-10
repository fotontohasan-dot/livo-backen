// Home page "Match Hub": In-Play / Today / Tomorrow + Competitions, filtered entirely in the
// browser (viewer's own timezone/clock) from /matches/api/live. No page reloads; re-renders
// when the server pushes `matches_update` (and polls every 30s as a fallback).
(function () {
  'use strict';
  var root = document.getElementById('homeHub');
  if (!root) return;
  var listEl = document.getElementById('hhList');
  var tabsEl = document.getElementById('hhTabs');
  var leagueSel = document.getElementById('hhLeague');
  var MAX_ROWS = 24;
  var ALL = [];
  var filter = null;      // null = pick a default once data arrives
  var league = '';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function matchDay(m) {
    if (!m.date) return null;
    var d = new Date(m.date);
    return isNaN(d.getTime()) ? null : dayKey(d);
  }
  function isLive(m) {
    var st = String(m.status || '').toLowerCase();
    return st === 'live' || st.indexOf('live') !== -1 || st.indexOf('in play') !== -1 || st.indexOf('progress') !== -1;
  }
  function when(m) { var t = m.date ? new Date(m.date).getTime() : NaN; return isNaN(t) ? Infinity : t; }

  function passes(m) {
    if (league && (m.league || '') !== league) return false;
    if (filter === 'live') return isLive(m);
    if (filter === 'today') return isLive(m) || matchDay(m) === dayKey(new Date());
    if (filter === 'tomorrow') { var t = new Date(); t.setDate(t.getDate() + 1); return matchDay(m) === dayKey(t); }
    return true;
  }
  function safeLogo(u) { return (typeof u === 'string' && (/^\/(?!\/)/.test(u) || /^data:image\//.test(u))) ? u : ''; }
  function crest(url) {
    var src = safeLogo(url);
    if (src) { var i = el('img', 'hh-logo'); i.src = src; i.alt = ''; i.loading = 'lazy'; return i; }
    return el('span', 'hh-logo hh-logo-ph', '\uD83D\uDC55');
  }
  function icon(sport) { return sport === 'football' ? '\u26BD' : sport === 'tennis' ? '\uD83C\uDFBE' : '\uD83C\uDFCF'; }

  function row(m) {
    var a = el('a', 'hh-row');
    a.href = '/matches/' + encodeURIComponent(m.id);
    var top = el('div', 'hh-top');
    top.appendChild(el('span', 'hh-league', icon(m.sport) + ' ' + (m.league || m.sport || '')));
    if (isLive(m)) top.appendChild(el('span', 'hh-live', 'LIVE'));
    else if (m.date) top.appendChild(el('span', 'hh-time', new Date(m.date).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })));
    a.appendChild(top);
    var teams = el('div', 'hh-teams');
    [[m.logoA, (m.teams && m.teams[0]) || m.homeTeam, m.homeScore], [m.logoB, (m.teams && m.teams[1]) || m.awayTeam, m.awayScore]].forEach(function (t) {
      var r = el('div', 'hh-team');
      r.appendChild(crest(t[0]));
      r.appendChild(el('span', 'hh-name', t[1] || ''));
      if (isLive(m) && t[2] != null && t[2] !== '') r.appendChild(el('b', 'hh-score', String(t[2])));
      teams.appendChild(r);
    });
    a.appendChild(teams);
    return a;
  }

  function render() {
    var rows = ALL.filter(passes).sort(function (x, y) {
      if (isLive(x) !== isLive(y)) return isLive(x) ? -1 : 1;
      return when(x) - when(y);
    });
    listEl.textContent = '';
    if (!rows.length) { listEl.appendChild(el('div', 'hh-empty', root.getAttribute('data-empty') || 'No matches')); return; }
    rows.slice(0, MAX_ROWS).forEach(function (m) { listEl.appendChild(row(m)); });
    if (rows.length > MAX_ROWS) {
      var more = el('a', 'hh-more', root.getAttribute('data-more') || 'View all');
      more.href = '/matches';
      listEl.appendChild(more);
    }
  }

  function setActive() {
    tabsEl.querySelectorAll('.hh-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-filter') === filter); });
  }
  function fillLeagues() {
    var names = {};
    ALL.forEach(function (m) { if (m.league) names[m.league] = 1; });
    var list = Object.keys(names).sort();
    if (list.indexOf(league) === -1) league = '';
    leagueSel.textContent = '';
    var first = el('option', null, root.getAttribute('data-competitions') || 'Competitions');
    first.value = '';
    leagueSel.appendChild(first);
    list.forEach(function (n) { var o = el('option', null, n); o.value = n; leagueSel.appendChild(o); });
    leagueSel.value = league;
  }

  function load() {
    fetch('/matches/api/live', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.success) return;
        ALL = [].concat(d.cricket || [], d.football || [], d.tennis || [], d.other || []);
        if (filter === null) filter = ALL.some(isLive) ? 'live' : 'today'; // sensible default, then the user's choice sticks
        setActive(); fillLeagues(); render();
      })
      .catch(function () { /* keep whatever is on screen */ });
  }

  tabsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.hh-tab');
    if (!b) return;
    filter = b.getAttribute('data-filter');
    setActive(); render(); // instant, client-side
  });
  leagueSel.addEventListener('change', function () { league = leagueSel.value; render(); });

  load();
  setInterval(load, 30000);
  if (typeof io === 'function') {
    try {
      var s = window.livoSocket(), t = null;
      s.on('connect', function () { s.emit('join_matches'); });
      s.on('matches_update', function () { clearTimeout(t); t = setTimeout(load, 1500); });
    } catch (e) { /* polling still works */ }
  }
})();
