// views/games/lobby.ejs-এর ক্লায়েন্ট কোড। docs/CSP.md ধাপ ৩ — কোনো ইনলাইন
// স্ক্রিপ্ট নেই; সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।
//
// লবির কোনো গেম-তালিকা এখানে নেই এবং কখনো থাকবেও না — সব ডেটা
// /games/api/list থেকে, যেটা সরাসরি games টেবিল পড়ে।
(function () {
  var cfg = {};
  var el = document.getElementById('lobbyConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  var grid = document.getElementById('gameGrid');
  var moreBtn = document.getElementById('lobbyMore');
  var search = document.getElementById('lobbySearch');
  var state = {
    page: cfg.page || 1,
    hasMore: !!cfg.hasMore,
    loading: false,
    selected: cfg.selected || { category: 'all', provider: 'all', q: '' }
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function queryString(extra) {
    var p = new URLSearchParams();
    if (state.selected.category && state.selected.category !== 'all') p.set('category', state.selected.category);
    if (state.selected.provider && state.selected.provider !== 'all') p.set('provider', state.selected.provider);
    if (state.selected.q) p.set('q', state.selected.q);
    Object.keys(extra || {}).forEach(function (k) { p.set(k, extra[k]); });
    return p.toString();
  }

  function cardHtml(g) {
    // থাম্বনেইল না থাকলে ইমোজি ফলব্যাক — স্লাগ থেকে কোনো পথ অনুমান করা হয় না।
    var thumb = g.thumbnail_url
      ? '<img src="' + esc(g.thumbnail_url) + '" alt="" aria-hidden="true" loading="lazy" decoding="async">'
      : '<div class="game-thumb-fallback">\uD83C\uDFB2</div>';
    return '<a class="game-card" href="/games/launch/'
      + encodeURIComponent(g.provider) + '/' + encodeURIComponent(g.provider_game_id) + '">'
      + thumb
      + '<div class="game-meta">'
      + '<div class="game-name">' + esc(g.name) + '</div>'
      + '<div class="game-provider">' + esc(g.provider) + '</div>'
      + '</div></a>';
  }

  function render(games, append) {
    if (!grid) return;
    var html = games.map(cardHtml).join('');
    if (append) {
      grid.insertAdjacentHTML('beforeend', html);
    } else {
      grid.innerHTML = html || '<div class="lobby-empty">' + esc(cfg.noGamesFound || '') + '</div>';
    }
  }

  function load(page, append) {
    if (state.loading) return;
    state.loading = true;
    fetch('/games/api/list?' + queryString({ page: page }), { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.page = data.page || page;
        state.hasMore = !!data.hasMore;
        render(data.games || [], append);
        if (moreBtn) moreBtn.style.display = state.hasMore ? 'block' : 'none';
      })
      .catch(function () { /* নেটওয়ার্ক সমস্যায় আগের তালিকাই থাকুক */ })
      .then(function () { state.loading = false; });
  }

  // ফিল্টার বোতাম (ক্যাটাগরি ও প্রোভাইডার — দুটোই একই হ্যান্ডলার)
  document.querySelectorAll('.lobby-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var kind = btn.dataset.filter;
      state.selected[kind] = btn.dataset.value;
      var group = btn.parentElement;
      group.querySelectorAll('.lobby-tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      // URL-ও আপডেট হয়, যাতে ফিল্টার করা লবি শেয়ার/বুকমার্ক করা যায়
      history.replaceState(null, '', '/games' + (queryString() ? '?' + queryString() : ''));
      load(1, false);
    });
  });

  // সার্চ — টাইপ করার সময় প্রতিটা কীস্ট্রোকে রিকোয়েস্ট না পাঠিয়ে debounce
  if (search) {
    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.selected.q = search.value.trim();
        load(1, false);
      }, 300);
    });
  }

  if (moreBtn) {
    moreBtn.addEventListener('click', function () { load(state.page + 1, true); });
  }

  // infinite scroll — বোতামটা দৃশ্যমান হলেই পরের পেজ। IntersectionObserver
  // না থাকলে (পুরনো ব্রাউজার) বোতামটাই ফলব্যাক হিসেবে কাজ করে।
  if (moreBtn && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && state.hasMore && !state.loading) {
        load(state.page + 1, true);
      }
    }, { rootMargin: '200px' });
    io.observe(moreBtn);
  }
})();
