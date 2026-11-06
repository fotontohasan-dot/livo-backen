// views/match-detail.ejs-এর ক্লায়েন্ট কোড: মার্কেট ট্যাব, ভাঁজ করা কার্ড আর বেট স্লিপ।
// docs/CSP.md ধাপ ৩: অনুবাদ, লগইন অবস্থা আর ম্যাচ id JSON ডেটা ব্লক থেকে আসে।
//
// আগে বাজি ধরতে ব্রাউজারের alert, prompt ও confirm ডায়ালগ ব্যবহৃত হতো — মোবাইলে বিশ্রী দেখাত
// আর কিছু অ্যাপ-ব্রাউজারে (WebView) আদৌ আসত না। এখন সবই পেজের ভেতরের বেট স্লিপে।
// অডস শুধু দেখানোর জন্য; সার্ভার নিজের অডস দিয়েই বাজি ধরে (routes/matches.js)।

(function () {
  var cfg = {};
  var el = document.getElementById('match-detailConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }
  var MIN_BET = Number(cfg.minBet) > 0 ? Number(cfg.minBet) : 10;
  var MAX_BET = Number(cfg.maxBet) > 0 ? Number(cfg.maxBet) : 100000;

  function $(id) { return document.getElementById(id); }

  // ===== টোস্ট =====
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('mdToast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'md-toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'md-toast ' + (kind || ''); }, 3200);
  }

  // ===== ট্যাব ফিল্টার =====
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.market-box'));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.md-tab'));

  function applyTab(id) {
    var visible = 0;
    boxes.forEach(function (box) {
      var show = id === 'all'
        || (id === 'popular' ? box.getAttribute('data-pop') === '1' : box.getAttribute('data-cat') === id);
      box.classList.toggle('hidden-by-tab', !show);
      if (show) visible++;
    });
    tabs.forEach(function (tb) { tb.classList.toggle('active', tb.getAttribute('data-tab') === id); });
    var empty = $('mdTabEmpty');
    if (empty) empty.style.display = visible ? 'none' : 'block';
  }
  tabs.forEach(function (tb) {
    tb.addEventListener('click', function () { applyTab(tb.getAttribute('data-tab')); });
  });

  // ===== কার্ড ভাঁজ/খোলা =====
  document.querySelectorAll('[data-toggle]').forEach(function (h) {
    h.addEventListener('click', function () {
      var box = h.closest('.market-box');
      if (box) box.classList.toggle('collapsed');
    });
  });

  // ===== বেট স্লিপ =====
  var overlay = $('bsOverlay');
  var stakeEl = $('bsStake');
  var errEl = $('bsError');
  var placeBtn = $('bsPlace');
  var current = null; // { marketId, runner, odd, cell, betType, ref }
  var inflight = false;
  // One key per slip submission: a retry of the SAME slip is deduplicated by the server, but any
  // change to the stake starts a new key so an edited slip is never mistaken for the old one.
  function newRef() {
    try {
      var a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) { return String(Date.now()) + Math.random().toString(16).slice(2, 12); }
  }
  function touchRef() { if (current) current.ref = newRef(); }

  function money(n) {
    return (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function stakeValue() {
    var v = parseInt(stakeEl.value, 10);
    return Number.isFinite(v) ? v : 0;
  }
  // Lay liability: stake * (odd - 1), rounded up to whole coins (mirrors services/layBet.js)
  function liabilityFor(stake, odd) {
    return Math.ceil(Math.round(stake * (odd - 1) * 100) / 100);
  }
  function refreshReturn() {
    if (!current) return;
    var isLay = current.betType === 'lay';
    var liabRow = $('bsLiabRow');
    if (liabRow) liabRow.hidden = !isLay;
    var lbl = $('bsReturnLabel');
    if (isLay) {
      // Lay wins the backer's stake; liability is what is reserved from the wallet
      if (lbl) lbl.textContent = cfg.profitLabel || 'Profit if wins';
      $('bsReturn').textContent = money(stakeValue());
      if ($('bsLiabLabel')) $('bsLiabLabel').textContent = cfg.liabilityLabel || 'Liability';
      if ($('bsLiab')) $('bsLiab').textContent = money(liabilityFor(stakeValue(), current.odd));
    } else {
      if (lbl && cfg.returnLabel) lbl.textContent = cfg.returnLabel;
      $('bsReturn').textContent = money(stakeValue() * current.odd);
    }
  }
  function setError(msg) { if (errEl) errEl.textContent = msg || ''; }

  function openSlip(btn) {
    var odd = parseFloat(btn.getAttribute('data-odd'));
    if (!Number.isFinite(odd)) return;
    current = {
      marketId: btn.getAttribute('data-market-id'),
      runner: btn.getAttribute('data-runner'),
      odd: odd,
      betType: btn.getAttribute('data-bet-type') === 'lay' ? 'lay' : 'back',
      cell: btn.closest('.market-cell'),
      ref: newRef()
    };
    applySide();
    $('bsMarket').textContent = btn.getAttribute('data-market-name') || '';
    $('bsPick').textContent = (btn.getAttribute('data-label') || '') + (current.betType === 'lay' ? ' (Lay)' : '');
    if ($('bsSideTag')) $('bsSideTag').textContent = current.betType === 'lay' ? 'LAY' : 'BACK';
    $('bsOdd').textContent = String(odd);
    if (!stakeEl.value || stakeValue() < MIN_BET) stakeEl.value = String(Math.max(MIN_BET, 50));
    setError('');
    refreshReturn();
    document.querySelectorAll('.market-cell.selected').forEach(function (c) { c.classList.remove('selected'); });
    if (current.cell) current.cell.classList.add('selected');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (cfg.loggedIn) setTimeout(function () { try { stakeEl.focus(); stakeEl.select(); } catch (e) {} }, 60);
  }

  function closeSlip() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('.market-cell.selected').forEach(function (c) { c.classList.remove('selected'); });
    current = null;
    setError('');
  }

  function isLocked(el) {
    return !!(el.closest('.runner-suspended') || el.closest('.market-suspended') || el.classList.contains('price-unavailable'));
  }
  // Delegated: works for server-rendered cells and survives live DOM updates.
  document.addEventListener('click', function (e) {
    var cell = e.target.closest ? e.target.closest('.market-cell') : null;
    if (!cell) return;
    var btn = e.target.closest('.odds') || cell.querySelector('.odds.back');
    if (!btn) return;
    if (isLocked(btn)) { toast(cfg.suspendedMsg || 'Suspended', 'err'); return; }
    openSlip(btn);
  });

  if (overlay) {
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSlip(); });
    if ($('bsClose')) $('bsClose').addEventListener('click', closeSlip);
    if ($('bsCancel')) $('bsCancel').addEventListener('click', closeSlip);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSlip(); });
    if (stakeEl) stakeEl.addEventListener('input', function () { touchRef(); setError(''); refreshReturn(); });
    document.querySelectorAll('.bs-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var add = parseInt(chip.getAttribute('data-add'), 10) || 0;
        stakeEl.value = String(Math.min(MAX_BET, stakeValue() + add));
        touchRef();
        setError('');
        refreshReturn();
      });
    });
  }

  // On-screen numeric keypad (0-9, clear, backspace) — writes into the same stake input.
  document.querySelectorAll('.bs-key').forEach(function (k) {
    k.addEventListener('click', function () {
      var key = k.getAttribute('data-key');
      var v = String(stakeEl.value || '');
      if (key === 'clear') v = '';
      else if (key === 'back') v = v.slice(0, -1);
      else if (/^[0-9]$/.test(key)) v = (v === '0' ? '' : v) + key;
      if (v.length > 9) return;
      stakeEl.value = (Number(v) > MAX_BET) ? String(MAX_BET) : v;
      touchRef(); setError(''); refreshReturn();
    });
  });

  function placeBet() {
    if (!current || inflight) return;
    var stake = stakeValue();
    if (!stake || stake < MIN_BET) { setError(cfg.minBetMsg || ('Min ' + MIN_BET)); return; }
    if (stake > MAX_BET) { setError('Max ' + MAX_BET); return; }
    if (current.betType === 'lay' && liabilityFor(stake, current.odd) > MAX_BET) { setError('Max ' + MAX_BET); return; }

    placeBtn.disabled = true;
    inflight = true;
    setError('');

    fetch('/matches/' + encodeURIComponent(cfg.matchId) + '/bet', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Idempotency-Key': current.ref },
      body: JSON.stringify({
        market_id: current.marketId,
        runner: current.runner,
        odd: current.odd, // সার্ভার উপেক্ষা করে; শুধু সামঞ্জস্যের জন্য
        bet_type: current.betType,
        stake: stake
      })
    })
      .then(function (r) {
        // সেশন শেষ হলে সার্ভার HTML লগইন পেজে রিডাইরেক্ট করে — JSON নয়। সেটা আলাদা করে ধরা হয়,
        // নইলে ব্যবহারকারী শুধু "নেটওয়ার্ক সমস্যা" দেখত।
        var ct = r.headers.get('content-type') || '';
        if (r.redirected || ct.indexOf('application/json') === -1) {
          var err = new Error('session');
          err.sessionExpired = true;
          throw err;
        }
        return r.json().then(function (data) { return { status: r.status, data: data }; });
      })
      .then(function (res) {
        var data = res.data || {};
        inflight = false;
        if (data.success) {
          closeSlip();
          loadMyBets(true);
          toast(data.message || 'OK', 'ok');
          setTimeout(function () { location.reload(); }, 1400);
          return;
        }
        if (data.code === 'CSRF_TOKEN_INVALID' || res.status === 401) {
          setError(cfg.sessionExpired || 'Session expired, please log in again.');
        } else {
          setError(data.message || data.error || cfg.networkError);
        }
        placeBtn.disabled = false;
      })
      .catch(function (e) {
        inflight = false;
        setError(e && e.sessionExpired ? (cfg.sessionExpired || 'Session expired') : cfg.networkError);
        placeBtn.disabled = false;
      });
  }
  if (placeBtn) placeBtn.addEventListener('click', placeBet);


  // ===== My Bets drawer: GET /matches/api/my-bets (own bets only, rendered with textContent) =====
  var mbPanel = $('mbPanel'), mbList = $('mbList');
  var mbNext = null, mbLoading = false;
  function mbText(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls; n.textContent = text; return n;
  }
  var STATUS_LABEL = { pending: 'Pending', won: 'Won', lost: 'Lost', void: 'Void' };
  function mbRow(b) {
    var row = document.createElement('div');
    row.className = 'mb-item mb-' + (STATUS_LABEL[b.status] ? b.status : 'pending');
    var top = document.createElement('div'); top.className = 'mb-top';
    top.appendChild(mbText('span', 'mb-side mb-side-' + b.betType, b.betType === 'lay' ? 'LAY' : 'BACK'));
    top.appendChild(mbText('b', 'mb-match', b.matchName || ''));
    top.appendChild(mbText('span', 'mb-status', STATUS_LABEL[b.status] || b.status));
    row.appendChild(top);
    row.appendChild(mbText('div', 'mb-sel', (b.market ? b.market + ' · ' : '') + b.selection));
    var f = document.createElement('div'); f.className = 'mb-figs';
    [['Odds', String(b.odd)], ['Stake', money(b.stake)]]
      .concat(b.betType === 'lay' ? [['Liability', money(b.liability)]] : [])
      .concat([['Return', money(b.potentialReturn)]]).forEach(function (p) {
        var c = document.createElement('span'); c.appendChild(mbText('small', '', p[0])); c.appendChild(mbText('b', '', p[1])); f.appendChild(c);
      });
    row.appendChild(f);
    return row;
  }
  function loadMyBets(reset) {
    if (!mbList || !cfg.loggedIn || mbLoading) return;
    mbLoading = true;
    var url = '/matches/api/my-bets?limit=20' + (!reset && mbNext ? '&before=' + encodeURIComponent(mbNext) : '');
    if (reset) { mbNext = null; if (!mbList.firstChild) mbList.appendChild(mbText('div', 'mb-note', cfg.loadingMsg || 'Loading…')); }
    fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (r.redirected || (r.headers.get('content-type') || '').indexOf('application/json') === -1) throw new Error('session');
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.success) throw new Error('api');
        if (reset) mbList.textContent = '';
        else { var more = mbList.querySelector('.mb-more'); if (more) more.remove(); }
        if (!d.bets.length && reset) mbList.appendChild(mbText('div', 'mb-note', cfg.noBetsMsg || 'No bets yet.'));
        d.bets.forEach(function (b) { mbList.appendChild(mbRow(b)); });
        mbNext = d.nextBefore;
        if (d.hasMore) {
          var btn = mbText('button', 'mb-more', cfg.loadMoreMsg || 'Load more'); btn.type = 'button';
          btn.addEventListener('click', function () { loadMyBets(false); });
          mbList.appendChild(btn);
        }
      })
      .catch(function () { mbList.textContent = ''; mbList.appendChild(mbText('div', 'mb-note mb-err', cfg.networkError || 'Could not load bets.')); })
      .then(function () { mbLoading = false; });
  }
  function setMbOpen(open) {
    if (!mbPanel) return;
    mbPanel.classList.toggle('open', open);
    mbPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) loadMyBets(true);
  }
  if ($('mbOpen')) $('mbOpen').addEventListener('click', function () { setMbOpen(true); });
  if ($('mbClose')) $('mbClose').addEventListener('click', function () { setMbOpen(false); });

  // ===== Live odds / suspension (Socket.IO) =====
  // Server events: scoreUpdate, oddsUpdate, marketStatusChange, runnerStatusChange, myBetsChanged (services/socket.js, services/notify.js).
  function findOdds(marketId, runner, type) {
    var list = document.querySelectorAll('.odds[data-market-id="' + String(marketId) + '"]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-runner') === String(runner) && list[i].getAttribute('data-bet-type') === type) return list[i];
    }
    return null;
  }
  function flash(el, dir) {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth; // restart the transition if two ticks arrive back to back
    el.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
    clearTimeout(el._flashT);
    el._flashT = setTimeout(function () { el.classList.remove('flash-up', 'flash-down'); }, 900);
  }
  // price: number | null. null = no price offered right now -> grey out this button only.
  function setPrice(el, price) {
    if (!el) return;
    if (price === null || !Number.isFinite(price)) { el.classList.add('price-unavailable'); return; }
    el.classList.remove('price-unavailable');
    var old = parseFloat(el.getAttribute('data-odd'));
    if (price === old) return;
    el.setAttribute('data-odd', String(price));
    el.textContent = String(price);
    if (Number.isFinite(old)) flash(el, price > old ? 1 : -1); // green up / red down
    if (current && el.getAttribute('data-market-id') === String(current.marketId) &&
        el.getAttribute('data-runner') === current.runner &&
        el.getAttribute('data-bet-type') === current.betType) {
      current.odd = price;
      $('bsOdd').textContent = String(price);
      refreshReturn();
    }
  }
  function setRunnerSuspended(marketId, runner, suspended) {
    var cells = document.querySelectorAll('.market-cell[data-runner="' + String(runner) + '"]');
    for (var i = 0; i < cells.length; i++) {
      var box = cells[i].closest('.market-box');
      if (!box || box.getAttribute('data-market-id') !== String(marketId)) continue;
      cells[i].classList.toggle('runner-suspended', !!suspended);
      cells[i].classList.remove('selected');
    }
    if (suspended && current && String(current.marketId) === String(marketId) && current.runner === String(runner)) {
      setError(cfg.suspendedMsg || 'Suspended');
      if (placeBtn) placeBtn.disabled = true;
    } else if (!suspended && current && String(current.marketId) === String(marketId) && current.runner === String(runner) && placeBtn) {
      placeBtn.disabled = false; setError('');
    }
  }
  function setMarketSuspended(marketId, suspended) {
    var box = document.querySelector('.market-box[data-market-id="' + String(marketId) + '"]');
    if (!box) return;
    box.classList.toggle('market-suspended', !!suspended);
    if (suspended && current && String(current.marketId) === String(marketId)) {
      setError(cfg.suspendedMsg || 'Suspended');
      if (placeBtn) placeBtn.disabled = true;
    } else if (!suspended && current && String(current.marketId) === String(marketId) && placeBtn) {
      placeBtn.disabled = false; setError('');
    }
  }

  if (typeof io === 'function' && cfg.matchId) {
    try {
      var socket = io();
      // (re)join on every connect so a reconnect after a network drop resumes updates
      socket.on('connect', function () { socket.emit('joinMatch', cfg.matchId); });

      // Canonical live-score event is `scoreUpdate` (server: emitFeedUpdate / updateLiveScore).
      socket.on('scoreUpdate', function (msg) {
        if (!msg || String(msg.matchId) !== String(cfg.matchId)) return;
        if ($('score-a') && msg.score_a != null) $('score-a').textContent = String(msg.score_a);
        if ($('score-b') && msg.score_b != null) $('score-b').textContent = String(msg.score_b);
        if ($('md-overs') && msg.overs != null) $('md-overs').textContent = String(msg.overs);
      });
      // Private per-user room: tells us our own bets changed (placed / settled / voided) — re-fetch.
      socket.on('myBetsChanged', function () { if (mbPanel && mbPanel.classList.contains('open')) loadMyBets(true); });

      socket.on('oddsUpdate', function (msg) {
        if (!msg || String(msg.matchId) !== String(cfg.matchId) || !Array.isArray(msg.markets)) return;
        msg.markets.forEach(function (m) {
          (m.runners || []).forEach(function (r) {
            setPrice(findOdds(m.marketId, r.key, 'back'), r.back);
            setPrice(findOdds(m.marketId, r.key, 'lay'), r.lay);
          });
        });
      });
      socket.on('marketStatusChange', function (msg) {
        if (msg && String(msg.matchId) === String(cfg.matchId)) setMarketSuspended(msg.marketId, msg.status !== 'open');
      });
      socket.on('runnerStatusChange', function (msg) {
        if (msg && String(msg.matchId) === String(cfg.matchId)) setRunnerSuspended(msg.marketId, msg.runner, msg.status === 'suspended');
      });
    } catch (e) { /* page still works without live updates */ }
  }
})();
