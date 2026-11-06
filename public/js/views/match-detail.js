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
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.md-tab'));
  var activeTab = tabs.length ? tabs[0].getAttribute('data-tab') : 'all';

  function applyTab(id) {
    var visible = 0;
    activeTab = id;
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.market-box'));
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

  // ===== On-screen numeric keypad =====
  var kpToggle = $('bsKpToggle'), kp = $('bsKeypad');
  if (kpToggle && kp) {
    kpToggle.addEventListener('click', function () { kp.classList.toggle('open'); });
    kp.addEventListener('click', function (e) {
      var b = e.target.closest('.bs-key');
      if (!b) return;
      var k = b.getAttribute('data-key');
      var cur = stakeEl.value || '';
      if (k === 'C') cur = '';
      else if (k === '\u232b') cur = cur.slice(0, -1);
      else if (cur.length < 9) cur = (cur === '0' ? '' : cur) + k;
      var n = parseInt(cur || '0', 10);
      if (n > MAX_BET) cur = String(MAX_BET);
      stakeEl.value = cur;
      setError('');
      refreshReturn();
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
          if (data.newBalance != null) {
            document.querySelectorAll('.js-balance').forEach(function (n) { n.textContent = Number(data.newBalance).toLocaleString(); });
          }
          loadMyBets(true); // bet shows up instantly in My Bets
          placeBtn.disabled = false;
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


  // ===== My Bets drawer =====
  var mbDrawer = $('mbDrawer'), mbList = $('mbList'), mbCount = $('mbCount');
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function mbRow(label, value) {
    var r = mk('div', 'mb-row');
    r.appendChild(mk('span', null, label));
    r.appendChild(mk('b', null, value));
    return r;
  }
  function renderBets(bets) {
    if (!mbList) return;
    mbList.textContent = '';
    if (!bets.length) { mbList.appendChild(mk('div', 'mb-row', 'No bets yet')); }
    bets.forEach(function (b) {
      var c = mk('div', 'mb-card ' + b.betType);
      var top = mk('div', 'mb-row');
      top.appendChild(mk('span', 'mb-title', b.match));
      top.appendChild(mk('span', 'mb-st ' + b.status, b.status.charAt(0).toUpperCase() + b.status.slice(1)));
      c.appendChild(top);
      c.appendChild(mbRow('Market', b.market));
      c.appendChild(mbRow('Selection', (b.betType === 'lay' ? 'LAY ' : 'BACK ') + b.selection));
      c.appendChild(mbRow('Odds', String(b.odds)));
      c.appendChild(mbRow('Stake', money(b.stake)));
      if (b.betType === 'lay') c.appendChild(mbRow('Liability', money(b.liability)));
      c.appendChild(mbRow(b.status === 'won' ? 'Return' : 'Potential return', b.status === 'lost' ? '0' : money(b.potentialReturn)));
      mbList.appendChild(c);
    });
    var pending = bets.filter(function (b) { return b.status === 'pending'; }).length;
    if (mbCount) mbCount.textContent = pending ? String(pending) : '';
  }
  function loadMyBets(openAfter) {
    if (!mbDrawer) return;
    fetch('/matches/api/my-bets', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if ((r.headers.get('content-type') || '').indexOf('application/json') === -1) throw new Error('auth');
        return r.json();
      })
      .then(function (d) { if (d && d.success) { renderBets(d.bets || []); if (openAfter) openDrawer(); } })
      .catch(function () { /* signed out or offline: leave drawer as is */ });
  }
  function openDrawer() { if (mbDrawer) { mbDrawer.classList.add('open'); mbDrawer.setAttribute('aria-hidden', 'false'); } }
  function closeDrawer() { if (mbDrawer) { mbDrawer.classList.remove('open'); mbDrawer.setAttribute('aria-hidden', 'true'); } }
  if (mbDrawer) {
    $('mbOpen').addEventListener('click', function () { loadMyBets(true); });
    $('mbClose').addEventListener('click', closeDrawer);
    loadMyBets(false);
  }

  // ===== Live scoreboard (cricket / football / tennis) =====
  var board = $('liveBoard');
  function renderLive(live) {
    if (!board) return;
    board.textContent = '';
    // No stats from the feed (yet): show a placeholder for a live match, nothing for a future one.
    // The first real `liveUpdate` replaces this automatically.
    if (!live || !live.kind || live.waiting) {
      if (cfg.isLive) board.appendChild(mk('div', 'lb-sub', cfg.waitingMsg || 'Waiting for live feed…'));
      return;
    }
    if (live.kind === 'cricket') {
      var head = mk('div');
      head.appendChild(mk('span', 'lb-main', (live.runs != null ? live.runs : '-') + '/' + (live.wickets != null ? live.wickets : '-')));
      var sub = [];
      if (live.overs) sub.push('(' + live.overs + ' ov)');
      if (live.runRate != null) sub.push('RR ' + live.runRate);
      if (live.target) sub.push('Target ' + live.target);
      head.appendChild(mk('span', 'lb-sub', sub.join('  ')));
      board.appendChild(head);
      if (live.batsmen && live.batsmen.length) {
        var t = mk('table'), hr = mk('tr');
        ['Batsman', 'R', 'B', '4s', '6s'].forEach(function (h) { hr.appendChild(mk('th', null, h)); });
        t.appendChild(hr);
        live.batsmen.forEach(function (b) {
          var r = mk('tr', b.strike ? 'strike' : '');
          [b.name, b.runs, b.balls, b.fours, b.sixes].forEach(function (v) { r.appendChild(mk('td', null, String(v))); });
          t.appendChild(r);
        });
        board.appendChild(t);
      }
      if (live.bowler) {
        var bw = live.bowler;
        board.appendChild(mk('div', 'lb-sub', 'Bowler: ' + bw.name + '  ' + bw.overs + '-' + bw.maidens + '-' + bw.runs + '-' + bw.wickets));
      }
      if (live.balls && live.balls.length) {
        var balls = mk('div', 'lb-balls');
        balls.appendChild(mk('span', 'lb-sub', 'This over'));
        live.balls.forEach(function (b) {
          balls.appendChild(mk('span', 'lb-ball' + (b === '4' ? ' b4' : b === '6' ? ' b6' : b === 'W' ? ' bW' : ''), b));
        });
        board.appendChild(balls);
      }
    } else if (live.kind === 'football') {
      var f = mk('div');
      if (live.clock) f.appendChild(mk('span', 'lb-pill', live.clock));
      if (live.period) f.appendChild(mk('span', 'lb-sub', live.period));
      (live.halves || []).forEach(function (h, i) { f.appendChild(mk('span', 'lb-sub', (i === 0 ? 'HT ' : '2H ') + h[0] + '-' + h[1])); });
      board.appendChild(f);
      addMomentum(live.momentum);
    } else if (live.kind === 'tennis') {
      if (live.sets && live.sets.length) {
        var tt = mk('table'), h2 = mk('tr');
        h2.appendChild(mk('th', null, ''));
        live.sets.forEach(function (_, i) { h2.appendChild(mk('th', null, 'S' + (i + 1))); });
        if (live.game) h2.appendChild(mk('th', null, 'Game'));
        tt.appendChild(h2);
        [0, 1].forEach(function (p) {
          var r = mk('tr');
          r.appendChild(mk('td', null, (live.server === p ? '● ' : '') + (p === 0 ? (cfg.teamA || 'Player 1') : (cfg.teamB || 'Player 2'))));
          live.sets.forEach(function (s) { r.appendChild(mk('td', null, String(s[p]))); });
          if (live.game) r.appendChild(mk('td', null, String(live.game[p])));
          tt.appendChild(r);
        });
        board.appendChild(tt);
      }
      addMomentum(live.momentum);
    }
  }
  function addMomentum(m) {
    if (m == null) return;
    var bar = mk('div', 'lb-mom'), fill = mk('i');
    fill.style.width = Math.max(0, Math.min(100, m)) + '%'; // CSSOM write: allowed under style-src-attr CSP
    bar.appendChild(fill);
    board.appendChild(bar);
  }
  renderLive(cfg.live);

  function setVol(marketId, runner, type, size) {
    var o = findOdds(marketId, runner, type);
    var v = o && o.nextElementSibling;
    if (!v || !v.classList.contains('vol')) return;
    var n = Number(size);
    v.textContent = size == null || !Number.isFinite(n) ? '\u2013' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  }


  // ===== Market hydration: build/refresh market boxes from JSON without a page reload =====
  // Used when the feed starts sending a market (or a lay price) that the page was rendered without,
  // e.g. Fancy / Player Performance markets that appear mid-match.
  function sigOfModel(m) {
    return m.runners.map(function (r) { return r.key + (r.lay ? '+' : '-'); }).join('|');
  }
  function sigOfDom(box) {
    var out = [];
    box.querySelectorAll('.market-cell').forEach(function (c) {
      out.push(c.getAttribute('data-runner') + (c.querySelector('.odds.lay') ? '+' : '-'));
    });
    return out.join('|');
  }
  function oddsBtn(m, r, type, price) {
    var b = mk('div', 'odds ' + type, String(price));
    b.setAttribute('data-bet-type', type);
    b.setAttribute('data-market-id', m.id);
    b.setAttribute('data-market-name', m.name);
    b.setAttribute('data-runner', r.key);
    b.setAttribute('data-label', r.label);
    b.setAttribute('data-odd', String(price));
    return b;
  }
  function volEl(type, size) {
    var v = mk('small', 'vol', '\u2013');
    v.setAttribute('data-vol', type);
    if (size != null) { var n = Number(size); v.textContent = n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); }
    return v;
  }
  function buildMarketBox(m) {
    var box = mk('div', 'market-box' + (m.status === 'suspended' ? ' market-suspended' : ''));
    box.setAttribute('data-market-id', m.id);
    box.setAttribute('data-cat', m.category);
    box.setAttribute('data-pop', m.popular ? '1' : '0');
    var head = mk('div', 'market-header');
    head.setAttribute('data-toggle', '');
    head.appendChild(mk('span', 'mh-title', ((m.type === 'bookmaker' || m.type === 'match_odds') ? '\uD83C\uDFC6 ' : '\u26A1 ') + m.name));
    head.appendChild(mk('span', 'mh-toggle', '\u25BE'));
    head.addEventListener('click', function () { box.classList.toggle('collapsed'); });
    var body = mk('div', 'market-body');
    var cols = m.runners.length >= 3 ? 3 : (m.runners.length === 2 ? 2 : 1);
    var grid = mk('div', 'market-grid cols-' + cols);
    m.runners.forEach(function (r) {
      var cell = mk('div', 'market-cell' + (r.status === 'suspended' ? ' runner-suspended' : ''));
      cell.setAttribute('data-runner', r.key);
      cell.appendChild(mk('span', 'mc-label', r.label));
      cell.appendChild(oddsBtn(m, r, 'back', r.odd));
      cell.appendChild(volEl('back', r.backSize));
      if (r.lay) { cell.appendChild(oddsBtn(m, r, 'lay', r.lay)); cell.appendChild(volEl('lay', r.laySize)); }
      grid.appendChild(cell);
    });
    body.appendChild(grid);
    box.appendChild(head);
    box.appendChild(body);
    return box;
  }
  var hydrating = false, lastHydrate = 0;
  function hydrateMarkets() {
    if (hydrating || Date.now() - lastHydrate < 4000 || !cfg.matchId) return;
    hydrating = true; lastHydrate = Date.now();
    fetch('/matches/' + encodeURIComponent(cfg.matchId) + '/markets?tab=all', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.success) return;
        var anchor = $('mdTabEmpty');
        (d.markets || []).forEach(function (m) {
          var existing = document.querySelector('.market-box[data-market-id="' + String(m.id) + '"]');
          if (existing && sigOfDom(existing) === sigOfModel(m)) return;
          var fresh = buildMarketBox(m);
          if (existing) {
            if (existing.classList.contains('collapsed')) fresh.classList.add('collapsed');
            existing.parentNode.replaceChild(fresh, existing);
          } else if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(fresh, anchor);
          }
        });
        applyTab(activeTab); // keep the user's current tab, show/hide the waiting message
      })
      .catch(function () { /* next oddsUpdate retries */ })
      .then(function () { hydrating = false; });
  }
  applyTab(activeTab); // initial empty-tab state ("Waiting for live feed…")

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
        var needHydrate = false;
        msg.markets.forEach(function (m) {
          if (!document.querySelector('.market-box[data-market-id="' + String(m.marketId) + '"]')) needHydrate = true;
          (m.runners || []).forEach(function (r) {
            if ((r.back != null && !findOdds(m.marketId, r.key, 'back') && document.querySelector('.market-box[data-market-id="' + String(m.marketId) + '"]')) ||
                (r.lay != null && !findOdds(m.marketId, r.key, 'lay'))) needHydrate = true;
            setPrice(findOdds(m.marketId, r.key, 'back'), r.back);
            setPrice(findOdds(m.marketId, r.key, 'lay'), r.lay);
            setVol(m.marketId, r.key, 'back', r.backSize);
            setVol(m.marketId, r.key, 'lay', r.laySize);
          });
        });
        if (needHydrate) hydrateMarkets();
      });
      socket.on('liveUpdate', function (msg) {
        if (msg && String(msg.matchId) === String(cfg.matchId)) renderLive(msg.live);
      });
      // settlement / balance notifications arrive on the user room: refresh My Bets statuses
      socket.on('notification', function () { loadMyBets(false); });
      socket.on('marketStatusChange', function (msg) {
        if (msg && String(msg.matchId) === String(cfg.matchId)) setMarketSuspended(msg.marketId, msg.status !== 'open');
      });
      socket.on('runnerStatusChange', function (msg) {
        if (msg && String(msg.matchId) === String(cfg.matchId)) setRunnerSuspended(msg.marketId, msg.runner, msg.status === 'suspended');
      });
    } catch (e) { /* page still works without live updates */ }
  }
})();
