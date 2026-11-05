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
  var current = null; // { marketId, runner, odd, cell }

  function money(n) {
    return (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function stakeValue() {
    var v = parseInt(stakeEl.value, 10);
    return Number.isFinite(v) ? v : 0;
  }
  function refreshReturn() {
    if (!current) return;
    $('bsReturn').textContent = money(stakeValue() * current.odd);
  }
  function setError(msg) { if (errEl) errEl.textContent = msg || ''; }

  function openSlip(btn) {
    var odd = parseFloat(btn.getAttribute('data-odd'));
    if (!Number.isFinite(odd)) return;
    current = {
      marketId: btn.getAttribute('data-market-id'),
      runner: btn.getAttribute('data-runner'),
      odd: odd,
      cell: btn.closest('.market-cell')
    };
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

  document.querySelectorAll('.market-cell').forEach(function (cell) {
    cell.addEventListener('click', function () {
      var btn = cell.querySelector('.odds');
      if (btn) openSlip(btn);
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
})();
