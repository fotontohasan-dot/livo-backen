// views/match-detail.ejs client: bet slip, market tabs, live Socket.io updates.
// CSP: external file, reads its config from the #match-detailConfig JSON block.
(function () {
  var cfg = {};
  var el = document.getElementById('match-detailConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }
  var minBet = Number(cfg.minBet) || 10;

  var slip = document.getElementById('md-slip');
  var stakeInput = document.getElementById('slip-stake');
  var msg = document.getElementById('slip-msg');
  var selected = null; // the back cell currently in the slip

  function $(id) { return document.getElementById(id); }
  function setText(id, v) { var n = $(id); if (n && v !== undefined && v !== null) n.textContent = v; }

  // ---- bet slip ----
  function updateReturn() {
    var stake = parseInt(stakeInput.value, 10) || 0;
    var odd = selected ? parseFloat(selected.dataset.odd) : 0;
    setText('slip-return', stake && odd ? (stake * odd).toFixed(2) : '0');
    if (selected) setText('slip-odd', odd);
  }
  function openSlip(cell) {
    if (!cfg.loggedIn) { alert(cfg.loginToBet); return; }
    if (selected) selected.classList.remove('selected');
    selected = cell;
    cell.classList.add('selected');
    setText('slip-name', cell.dataset.runnerName || cell.dataset.runner);
    msg.textContent = '';
    updateReturn();
    slip.classList.add('open');
  }
  function closeSlip() {
    slip.classList.remove('open');
    if (selected) selected.classList.remove('selected');
    selected = null;
  }

  document.addEventListener('click', function (e) {
    var cell = e.target.closest && e.target.closest('.mk-cell.back.odds');
    if (!cell) return;
    var box = cell.closest('.market-box');
    if (box && box.dataset.status !== 'open') return; // suspended
    openSlip(cell);
  });
  stakeInput.addEventListener('input', updateReturn);
  $('slip-close').addEventListener('click', closeSlip);

  $('slip-place').addEventListener('click', function () {
    if (!selected) return;
    var stake = parseInt(stakeInput.value, 10);
    if (!stake || stake < minBet) { msg.textContent = cfg.minBetMsg; return; }
    var btn = this; btn.disabled = true;
    fetch('/matches/' + encodeURIComponent(cfg.matchId) + '/bet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // the server re-reads the price from the database; this value is informational only
      body: JSON.stringify({
        market_id: selected.dataset.marketId,
        runner: selected.dataset.runner,
        odd: parseFloat(selected.dataset.odd),
        stake: stake
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        msg.textContent = data.message || data.error || '';
        if (data.success) setTimeout(closeSlip, 1200);
      })
      .catch(function () { msg.textContent = cfg.networkError; })
      .then(function () { btn.disabled = false; });
  });

  // ---- market tabs ----
  var tabs = $('md-tabs');
  if (tabs) {
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('.md-tab');
      if (!b) return;
      tabs.querySelectorAll('.md-tab').forEach(function (t) { t.classList.toggle('active', t === b); });
      document.querySelectorAll('.market-box').forEach(function (m) {
        m.hidden = b.dataset.tab !== 'all' && m.dataset.type !== b.dataset.tab;
      });
    });
  }

  // ---- live updates ----
  function paintCell(cell, price, size) {
    if (!cell || !price) return;
    cell.textContent = price;
    if (size) { var s = document.createElement('small'); s.textContent = size; cell.appendChild(s); }
  }
  function applyMarket(m) {
    var box = document.querySelector('.market-box[data-market-id="' + m.id + '"]');
    if (!box) return;
    box.dataset.status = m.status;
    if (m.status !== 'open' && selected && box.contains(selected)) closeSlip();
    var depth = m.depth || {};
    Object.keys(depth).forEach(function (k) {
      var row = box.querySelector('[data-runner-row="' + k + '"]');
      if (!row) return;
      var d = depth[k] || {};
      var back = row.querySelector('[data-role="back"]');
      var lay = row.querySelector('[data-role="lay"]');
      if (back && d.back) {
        back.dataset.odd = d.back;
        paintCell(back, d.back, d.back_size);
        if (selected === back) updateReturn();
      }
      if (lay && d.lay) paintCell(lay, d.lay, d.lay_size);
    });
  }

  if (typeof io === 'function' && cfg.matchId) {
    var socket = io();
    socket.on('connect', function () { socket.emit('joinMatch', cfg.matchId); });
    socket.on('scoreUpdate', function (d) {
      if (!d || String(d.matchId) !== String(cfg.matchId)) return;
      setText('score-a', d.score_a || '');
      setText('score-b', d.score_b || '');
      setText('md-overs', d.overs || '');
      var live = /live|in.?play|running/i.test(String(d.status || 'live'));
      var badge = $('md-badge');
      if (badge && d.status) {
        badge.className = 'md-badge ' + (live ? 'md-badge-live' : 'md-badge-up');
        badge.textContent = live ? 'LIVE' : d.status;
      }
    });
    socket.on('marketUpdate', function (d) {
      if (!d || String(d.matchId) !== String(cfg.matchId)) return;
      (d.markets || []).forEach(applyMarket);
    });
  }
})();
