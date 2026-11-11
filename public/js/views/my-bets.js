// My Bets page. Data: GET /matches/api/my-bets (session-scoped, cursor-paginated, ?status= filter).
// All text is set with textContent (never innerHTML), so no server value can inject markup.
(function () {
  'use strict';
  var cfgEl = document.getElementById('myBetsConfig');
  var listEl = document.getElementById('mbpList');
  if (!cfgEl || !listEl) return;
  var cfg = {};
  try { cfg = JSON.parse(cfgEl.textContent || '{}'); } catch (e) { cfg = {}; }
  var stateEl = document.getElementById('mbpState');
  var moreBtn = document.getElementById('mbpMore');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.mbp-tab'));
  var PAGE_SIZE = 20;

  var tab = 'all';
  var nextBefore = null;
  var loading = false;
  var reqSeq = 0; // a late response from a previous tab/refresh must never overwrite the current one

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function money(n) {
    return (Math.round(Number(n) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function fmtDate(v) {
    if (!v) return null;
    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function cell(label, value, wide) {
    var c = el('div', 'mbp-cell' + (wide ? ' wide' : ''));
    c.appendChild(el('span', 'mbp-label', label));
    var v = el('span', 'mbp-value');
    if (value instanceof Node) v.appendChild(value); else v.textContent = value;
    c.appendChild(v);
    return c;
  }

  function renderCard(b) {
    var L = cfg.labels || {};
    var group = b.statusGroup || 'open';
    var card = el('article', 'mbp-card ' + group);

    var head = el('div', 'mbp-head');
    var left = el('div');
    var teams = (b.teamA && b.teamB) ? (b.teamA + ' vs ' + b.teamB) : '';
    left.appendChild(el('div', 'mbp-match', b.matchName || teams || ('#' + b.matchId)));
    var meta = [];
    if (teams && b.matchName && b.matchName !== teams) meta.push(teams);
    if (b.league) meta.push(b.league);
    if (meta.length) left.appendChild(el('div', 'mbp-meta', meta.join(' · ')));
    head.appendChild(left);
    head.appendChild(el('span', 'mbp-badge ' + group, (cfg.status || {})[group] || b.status));
    card.appendChild(head);

    var sel = el('span');
    sel.appendChild(el('span', 'mbp-tag ' + (b.betType === 'lay' ? 'lay' : ''), b.betType === 'lay' ? L.lay : L.back));
    if (b.demo) sel.appendChild(el('span', 'mbp-tag demo', L.demo));
    sel.appendChild(document.createTextNode(b.selection || '—'));

    var result;
    var amt = b.payout != null ? money(b.payout) : '';
    if (group === 'open') result = (cfg.result || {}).pending;
    else result = String(((cfg.result || {})[group]) || '').replace('{amount}', amt);

    var grid = el('div', 'mbp-grid');
    grid.appendChild(cell(L.betId, '#' + b.id));
    grid.appendChild(cell(L.matchTime, fmtDate(b.startTime) || L.timeTbd));
    grid.appendChild(cell(L.market, b.market || '—'));
    grid.appendChild(cell(L.selection, sel));
    grid.appendChild(cell(L.odds, Number(b.odd).toFixed(2)));
    grid.appendChild(cell(L.stake, money(b.stake)));
    if (b.betType === 'lay') grid.appendChild(cell(L.liability, money(b.liability)));
    grid.appendChild(cell(L.potential, money(b.potentialReturn)));
    grid.appendChild(cell(L.result, result, true));
    grid.appendChild(cell(L.placed, fmtDate(b.createdAt) || '—', true));
    card.appendChild(grid);
    return card;
  }

  function clearState() { stateEl.textContent = ''; }
  function showLoading() {
    clearState();
    var s = el('div', 'mbp-state');
    s.appendChild(el('div', 'mbp-spin'));
    s.appendChild(el('div', null, cfg.loading));
    stateEl.appendChild(s);
  }
  function showEmpty() {
    clearState();
    var s = el('div', 'mbp-state', (cfg.empty || {})[tab] || '');
    if (tab === 'all') {
      var a = el('a', 'mbp-btn', cfg.browse);
      a.setAttribute('href', '/matches');
      s.appendChild(el('br'));
      s.appendChild(a);
    }
    stateEl.appendChild(s);
  }
  function showError(msg) {
    clearState();
    var s = el('div', 'mbp-state', msg || cfg.error);
    var btn = el('button', 'mbp-btn', cfg.retry);
    btn.type = 'button';
    btn.addEventListener('click', function () { load(true); });
    s.appendChild(el('br'));
    s.appendChild(btn);
    stateEl.appendChild(s);
  }
  function setCounts(c) {
    if (!c) return;
    Array.prototype.forEach.call(document.querySelectorAll('[data-count]'), function (n) {
      var v = c[n.getAttribute('data-count')];
      n.textContent = v == null ? '' : String(v);
    });
  }

  // reset=true: start from the first page (tab switch, refresh, retry). Otherwise append the next page.
  function load(reset) {
    if (loading && !reset) return;
    var seq = ++reqSeq;
    loading = true;
    moreBtn.hidden = true;
    if (reset) { listEl.textContent = ''; nextBefore = null; showLoading(); }
    var qs = 'limit=' + PAGE_SIZE + (tab !== 'all' ? '&status=' + encodeURIComponent(tab) : '') +
             (!reset && nextBefore ? '&before=' + encodeURIComponent(nextBefore) : '');
    fetch('/matches/api/my-bets?' + qs, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (r.status === 401 || r.redirected || (r.headers.get('content-type') || '').indexOf('application/json') === -1) {
          var e = new Error('auth'); e.auth = true; throw e;
        }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (seq !== reqSeq) return; // stale response
        if (!d || !d.success) throw new Error('bad payload');
        loading = false;
        clearState();
        setCounts(d.counts);
        (d.bets || []).forEach(function (b) { listEl.appendChild(renderCard(b)); });
        nextBefore = d.hasMore ? d.nextBefore : null;
        moreBtn.hidden = !nextBefore;
        if (!listEl.children.length) showEmpty();
      })
      .catch(function (err) {
        if (seq !== reqSeq) return;
        loading = false;
        if (reset || !listEl.children.length) showError(err && err.auth ? cfg.sessionExpired : cfg.error);
        else { clearState(); moreBtn.hidden = false; }
      });
  }

  function selectTab(name) {
    tab = name;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    load(true);
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { selectTab(t.getAttribute('data-tab')); }); });
  moreBtn.addEventListener('click', function () { load(false); });

  // Live refresh when a bet is placed or settled elsewhere (same event the match-page panel uses).
  var refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { load(true); }, 400);
  }
  try {
    if (window.io) {
      var sock = window.io();
      sock.on('myBetsChanged', scheduleRefresh);
    }
  } catch (e) { /* realtime is optional */ }
  // Back/forward cache or returning to the tab: show current statuses.
  window.addEventListener('pageshow', function (e) { if (e.persisted) load(true); });

  load(true);
})();
