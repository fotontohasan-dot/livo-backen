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
  var current = null; // { marketId, runner, odd, cell, betType }

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
      cell: btn.closest('.market-cell')
    };
    $('bsMarket').textContent = btn.getAttribute('data-market-name') || '';
    $('bsPick').textContent = (btn.getAttribute('data-label') || '') + (current.betType === 'lay' ? ' (Lay)' : '');
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
    $('bsClose').addEventListener('click', closeSlip);
    $('bsCancel').addEventListener('click', closeSlip);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSlip(); });
    stakeEl.addEventListener('input', function () { setError(''); refreshReturn(); });
    document.querySelectorAll('.bs-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var add = parseInt(chip.getAttribute('data-add'), 10) || 0;
        stakeEl.value = String(Math.min(MAX_BET, stakeValue() + add));
        setError('');
        refreshReturn();
      });
    });
  }

  function placeBet() {
    if (!current) return;
    var stake = stakeValue();
    if (!stake || stake < MIN_BET) { setError(cfg.minBetMsg || ('Min ' + MIN_BET)); return; }
    if (stake > MAX_BET) { setError('Max ' + MAX_BET); return; }

    placeBtn.disabled = true;
    setError('');

    fetch('/matches/' + encodeURIComponent(cfg.matchId) + '/bet', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
        if (data.success) {
          closeSlip();
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
        setError(e && e.sessionExpired ? (cfg.sessionExpired || 'Session expired') : cfg.networkError);
        placeBtn.disabled = false;
      });
  }
  if (placeBtn) placeBtn.addEventListener('click', placeBet);

  // ===== Live odds / suspension (Socket.IO) =====
  // Server events: oddsUpdate, marketStatusChange, runnerStatusChange (services/socket.js).
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
