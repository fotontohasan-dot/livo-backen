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
  var current = null; // { marketId, runner, odd, side, btn, cell }
  var labels = cfg.labels || {};
  var sheet = overlay ? overlay.querySelector('.bs-sheet') : null;

  function money(n) {
    return (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function stakeValue() {
    var v = parseInt(stakeEl.value, 10);
    return Number.isFinite(v) ? v : 0;
  }
  // লায়াবিলিটি = স্টেক × (অডস − ১)। সেন্ট পূর্ণসংখ্যায় হিসাব — সার্ভারের services/layMath.js-এর সূত্রই।
  function liabilityOf(stake, odd) {
    return (stake * (Math.round(odd * 100) - 100)) / 100;
  }
  function refreshReturn() {
    if (!current) return;
    var stake = stakeValue();
    if (current.side === 'lay') {
      $('bsLiab').textContent = money(liabilityOf(stake, current.odd));
      $('bsReturn').textContent = money(stake); // লে জিতলে লাভ = ব্যাকারের স্টেক
    } else {
      $('bsReturn').textContent = money(stake * current.odd);
    }
  }
  function applySide() {
    var lay = current && current.side === 'lay';
    if (sheet) sheet.classList.toggle('is-lay', !!lay);
    $('bsSideTag').textContent = lay ? (labels.lay || 'Lay') : (labels.back || 'Back');
    $('bsReturnLabel').textContent = lay ? (labels.layProfit || 'Profit if it wins') : (labels.ret || 'Potential return');
  }
  function setError(msg) { if (errEl) errEl.textContent = msg || ''; }

  function openSlip(btn) {
    var odd = parseFloat(btn.getAttribute('data-odd'));
    if (!Number.isFinite(odd)) return;
    current = {
      marketId: btn.getAttribute('data-market-id'),
      runner: btn.getAttribute('data-runner'),
      odd: odd,
      side: btn.getAttribute('data-side') === 'lay' ? 'lay' : 'back',
      btn: btn,
      cell: btn.closest('.market-cell')
    };
    applySide();
    $('bsMarket').textContent = btn.getAttribute('data-market-name') || '';
    $('bsPick').textContent = btn.getAttribute('data-label') || '';
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

  // প্রতিটা Back/Lay বক্স আলাদা বাটন; সাসপেন্ড/Lay-দাম-নেই বাটন disabled, তাই ক্লিকই হয় না
  document.querySelectorAll('.market-cell .odds').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      openSlip(btn);
    });
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
    if (current.side === 'lay' && liabilityOf(stake, current.odd) > MAX_BET) { setError('Max ' + MAX_BET); return; }

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
        side: current.side,
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

  // ===== রিয়েল-টাইম ওডস, সাসপেনশন ও স্কোর (socket: marketUpdate / scoreUpdate) =====
  function setPrice(btn, value, size) {
    if (!btn) return;
    var priceEl = btn.querySelector('.bl-price');
    var sizeEl = btn.querySelector('.bl-size');
    var next = Number(value);
    var valid = Number.isFinite(next) && next > 1;
    var prev = parseFloat(btn.getAttribute('data-odd'));
    if (valid) {
      btn.setAttribute('data-odd', String(next));
      if (priceEl) priceEl.textContent = String(next);
      if (Number.isFinite(prev) && prev !== next) {
        var cls = next > prev ? 'flash-up' : 'flash-down';
        btn.classList.remove('flash-up', 'flash-down');
        void btn.offsetWidth; // অ্যানিমেশন আবার চালু করতে
        btn.classList.add(cls);
        setTimeout(function () { btn.classList.remove(cls); }, 1000);
      }
    } else {
      btn.setAttribute('data-odd', '');
      if (priceEl) priceEl.textContent = '—';
    }
    if (sizeEl && size !== undefined) sizeEl.textContent = (size === null || size === '') ? '' : String(size);
    return valid;
  }

  function applyMarketUpdate(m) {
    var box = document.querySelector('.market-box[data-market-id="' + String(m.id) + '"]');
    if (!box) return;
    var open = m.status === 'open';
    box.setAttribute('data-status', m.status || 'open');
    box.classList.toggle('suspended', !open);

    var odds = (m.odds && typeof m.odds === 'object') ? m.odds : {};
    var depth = (m.depth && typeof m.depth === 'object') ? m.depth : {};
    box.querySelectorAll('.market-cell').forEach(function (cell) {
      var key = cell.getAttribute('data-runner');
      var d = depth[key] || {};
      var back = d.back !== undefined && d.back !== null ? d.back : odds[key];
      var runnerSusp = d.suspended === true;
      cell.classList.toggle('suspended', runnerSusp);

      var backBtn = cell.querySelector('.odds.back');
      var layBtn = cell.querySelector('.odds.lay');
      var backOk = setPrice(backBtn, back, d.back_size === undefined ? undefined : d.back_size);
      var layOk = setPrice(layBtn, d.lay, d.lay_size === undefined ? undefined : d.lay_size);
      if (backBtn) backBtn.disabled = !open || runnerSusp || !backOk;
      if (layBtn) layBtn.disabled = !open || runnerSusp || !layOk;
    });

    // খোলা স্লিপের দাম/সাসপেনশন সিঙ্ক রাখা
    if (current && String(current.marketId) === String(m.id) && current.btn) {
      if (current.btn.disabled) {
        setError(cfg.labels && cfg.labels.suspended ? cfg.labels.suspended : 'SUSPENDED');
        if (placeBtn) placeBtn.disabled = true;
      } else {
        var o = parseFloat(current.btn.getAttribute('data-odd'));
        if (Number.isFinite(o)) { current.odd = o; $('bsOdd').textContent = String(o); refreshReturn(); }
        if (placeBtn) placeBtn.disabled = false;
        setError('');
      }
    }
  }

  function applyScoreUpdate(s) {
    function set(id, v) { var n = $(id); if (n && v !== undefined && v !== null) n.textContent = v; }
    set('score-a', s.score_a);
    set('score-b', s.score_b);
    set('md-overs', s.overs);
  }

  if (typeof window.io === 'function' && cfg.matchId) {
    try {
      var sock = window.io();
      var join = function () { sock.emit('joinMatch', cfg.matchId); };
      sock.on('connect', join); // রিকানেক্টেও আবার রুমে ঢোকে
      if (sock.connected) join();
      sock.on('marketUpdate', function (p) {
        if (!p || String(p.matchId) !== String(cfg.matchId) || !Array.isArray(p.markets)) return;
        p.markets.forEach(applyMarketUpdate);
      });
      sock.on('scoreUpdate', function (p) {
        if (p && String(p.matchId) === String(cfg.matchId)) applyScoreUpdate(p);
      });
    } catch (e) { /* লাইভ আপডেট ছাড়াও পেজ কাজ করে */ }
  }
})();
