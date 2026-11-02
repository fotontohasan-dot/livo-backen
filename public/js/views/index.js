// views/index.ejs-এর ক্লায়েন্ট কোড (দুটো ইনলাইন ব্লক একত্রে)।
// docs/CSP.md ধাপ ৩। সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('indexConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  // ---- প্রথম ইনলাইন ব্লক (আগের ব্যাচে সরানো) ----
  (function () {
    var box = document.getElementById('winsContainer');
    var state = document.getElementById('winsState');
    if (!box || !state) return;

    function esc(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function money(n) {
      return '৳ ' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    fetch('/games/api/recent-wins', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var wins = (data && data.wins) || [];
        if (!wins.length) {
          // কোনো বানানো ডেটা নয় — সত্যিকারের খালি অবস্থা
          state.textContent = 'এখনো কোনো বড় জয় নেই। প্রথম হোন!';
          return;
        }
        box.innerHTML = wins.map(function (w) {
          return '<div class="win-item">'
            + '<div><span>' + esc(w.user) + '</span><br>'
            + '<span class="game-name">' + esc(w.game) + '</span></div>'
            + '<div class="win-amount">' + money(w.amount) + '</div>'
            + '</div>';
        }).join('');
      })
      .catch(function () {
        state.textContent = 'সাম্প্রতিক জয় লোড করা যায়নি।';
      });
  })();

  // ---- দ্বিতীয় ইনলাইন ব্লক ----
// পূর্ণ গেইম ক্যাটালগ — ১১৮টি গেইম, প্রকৃত স্লাগ (routes/games.js অনুযায়ী) ও প্রোভাইডারসহ
  // অ্যাডমিন প্যানেল থেকে ম্যানেজ করা গেম (games টেবিল) — থাকলে এটাই ব্যবহার হবে,
  // টেবিল খালি থাকলে (মাইগ্রেশন এখনো না চললে) নিচের হার্ডকোড করা তালিকা ফলব্যাক হিসেবে কাজ করবে
  const SERVER_GAMES = cfg.games || [];

  // PHASE 9 (XSS): games তথ্য admin-নিয়ন্ত্রিত এবং নিচে innerHTML-এ বসানো হয়।
  // JSON.stringify()-এর \u003C escaping শুধু <script> block থেকে বেরোনো ঠেকায়,
  // DOM-এ বসানোর সময় HTML হিসেবে ব্যাখ্যা হওয়া ঠেকায় না। তাই প্রতিটি
  // dynamic মান এখানে escape করা হয়।
  function escHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // PHASE 1: আগে এখানে ১১৮টি গেমের একটা হার্ডকোড করা ফলব্যাক তালিকা ছিল এবং
  // gameRegistry থেকে আসা PLAYABLE_SLUGS দিয়ে ঠিক হতো কোন কার্ড ক্লিক করা যাবে।
  // ইন-হাউস গেম সরে যাওয়ায় দুটোরই আর অস্তিত্ব নেই — লবির একমাত্র উৎস সার্ভার:
  // games টেবিল (PHASE 3-এ প্রোভাইডার sync থেকে ভরে)। তালিকা খালি হলে খালি
  // স্টেটই দেখানো হবে, বানানো গেম নয়।
  const allGames = SERVER_GAMES;

  const PROVIDER_META = {
    'Jili':             { mono: 'JILI', color: '#F5A623', logo: '/images/providers/jili.jpg' },
    'PG Soft':          { mono: 'PG',   color: '#00B4D8', logo: '/images/providers/pg-soft.jpg' },
    'Spribe':           { mono: 'SB',   color: '#6C2EB9', logo: '/images/providers/spribe.jpg' },
    'Pragmatic Play':   { mono: 'PP',   color: '#E8302A', logo: '/images/providers/pragmatic-play.jpg' },
    'Evolution':        { mono: 'EVO',  color: '#C8102E', logo: '/images/providers/evolution.jpg' },
    'NetEnt':           { mono: 'NE',   color: '#003D7A', logo: '/images/providers/netent.jpg' },
    "Play'n GO":        { mono: 'PnGO', color: '#00A651', logo: '/images/providers/playn-go.jpg' },
    'Red Tiger':        { mono: 'RT',   color: '#D71920', logo: '/images/providers/red-tiger.jpg' },
    'Hacksaw Gaming':   { mono: 'HG',   color: '#FF6B00', logo: '/images/providers/hacksaw-gaming.jpg' },
    'Relax Gaming':     { mono: 'RX',   color: '#14B8A6', logo: '/images/providers/relax-gaming.jpg' },
    'Nolimit City':     { mono: 'NLC',  color: '#1A1A1A', logo: '/images/providers/nolimit-city.jpg' },
    'Playtech':         { mono: 'PT',   color: '#0B2545', logo: null },
    'Microgaming':      { mono: 'MG',   color: '#5A2D82', logo: '/images/providers/microgaming.jpg' },
    'Big Time Gaming':  { mono: 'BTG',  color: '#8A6D00', logo: '/images/providers/big-time-gaming.jpg' },
    'Yggdrasil':        { mono: 'YGG',  color: '#0F9B8E', logo: '/images/providers/yggdrasil.jpg' },
    'Quickspin':        { mono: 'QS',   color: '#9B2FAE', logo: '/images/providers/quickspin.jpg' },
    'Betsoft':          { mono: 'BS',   color: '#1B3A6B', logo: '/images/providers/betsoft.jpg' },
    'Wazdan':           { mono: 'WZ',   color: '#D62828', logo: '/images/providers/wazdan.jpg' },
    'Playson':          { mono: 'PS',   color: '#F77F00', logo: '/images/providers/playson.jpg' },
    'Spinomenal':       { mono: 'SM',   color: '#4C3B8C', logo: '/images/providers/spinomenal.jpg' }
  };

  let selectedCategory = 'all';
  let selectedProvider = 'all';
  const CATALOG_CATEGORIES = ['slots', 'live', 'sports', 'poker'];
  // শুধুমাত্র এই ক্যাটাগরিগুলোতে উপরে Hot | Favorite | Recent সেকেন্ডারি ট্যাব দেখাবে।
  // Live Casino এবং Sports-এ কোনো সেকেন্ডারি ট্যাব থাকবে না — শুধু প্রোভাইডার লিস্ট ও গেম গ্রিড দেখাবে।
  const SECONDARY_TAB_CATEGORIES = ['slots'];
  let selectedLayout = localStorage.getItem('bet420_game_layout') || 'standard';

  // ==================== বাম পাশের প্রোভাইডার কলাম (Slots/Live/Sports/Poker ক্যাটাগরির জন্য) ====================
  function renderCatalogProviderList() {
    const wrap = document.getElementById('catalogProviderList');
    const sidebar = document.getElementById('providerSidebar');
    if (!wrap || !sidebar) return;
    wrap.innerHTML = '';
    if (!CATALOG_CATEGORIES.includes(selectedCategory)) {
      sidebar.style.display = 'none';
      return;
    }
    sidebar.style.display = 'flex';

    // সবগুলো প্রোভাইডার দেখাবে (পুরো গেম ক্যাটালগ থেকে), শুধু বর্তমান ক্যাটাগরির না —
    // যাতে কোনো প্রোভাইডার তালিকা থেকে বাদ না পড়ে
    const providersInCategory = [...new Set(
      allGames.filter(g => g.provider).map(g => g.provider)
    )].sort((a, b) => a.localeCompare(b));

    const allItem = document.createElement('div');
    allItem.className = 'catalog-provider-item' + (selectedProvider === 'all' ? ' active' : '');
    allItem.innerHTML = `<div class="fallback" style="background:var(--gold);color:#000;">সব</div><div class="name">${cfg.allLabel}</div>`;
    allItem.addEventListener('click', () => {
      selectedProvider = 'all';
      renderCatalogProviderList();
      renderGames();
    });
    wrap.appendChild(allItem);

    providersInCategory.forEach(p => {
      // PROVIDER_META-তে লোগো/রঙ থাকলে সেটা ব্যবহার হবে, নাহলে নাম থেকে একটা ফলব্যাক আইকন বানানো হবে
      const meta = PROVIDER_META[p] || { mono: p.slice(0, 3).toUpperCase(), color: '#555c6b', logo: null };
      const item = document.createElement('div');
      item.className = 'catalog-provider-item' + (selectedProvider === p ? ' active' : '');
      const logoHTML = meta.logo
        ? `<img src="${escHtml(meta.logo)}" alt="${escHtml(p)}">`
        : `<div class="fallback" style="background:${escHtml(meta.color)}">${escHtml(meta.mono)}</div>`;
      item.innerHTML = `${logoHTML}<div class="name">${escHtml(p)}</div>`;
      item.addEventListener('click', () => {
        selectedProvider = (selectedProvider === p) ? 'all' : p;
        renderCatalogProviderList();
        renderGames();
      });
      wrap.appendChild(item);
    });
  }

  // প্রোভাইডার লিস্ট উপরে/নিচে স্ক্রল করার বাটন (▲▼)
  (function setupProviderScrollButtons() {
    const list = document.getElementById('catalogProviderList');
    const upBtn = document.getElementById('providerScrollUp');
    const downBtn = document.getElementById('providerScrollDown');
    if (!list || !upBtn || !downBtn) return;
    upBtn.addEventListener('click', () => list.scrollBy({ top: -150, behavior: 'smooth' }));
    downBtn.addEventListener('click', () => list.scrollBy({ top: 150, behavior: 'smooth' }));
  })();

  // ==================== গেইম গ্রিড রেন্ডার ====================
  function renderGames() {
    const c = document.getElementById('gameContainer');
    if (!c) return;
    c.innerHTML = '';
    // গেম কার্ড/গ্রিড হোমপেজে আপাতত দেখানো হচ্ছে না — #gameContainer ভবিষ্যতের
    // API কানেক্টিভিটির জন্য খালি রাখা হয়েছে। নিচের সব রেন্ডার লজিক বাইপাস।
    return;
  }

  // ==================== ক্যাটাগরি ট্যাব ====================
  document.querySelectorAll('.nav-tab-item').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      selectedCategory = el.dataset.category;
      selectedProvider = 'all';

      // সেকেন্ডারি ট্যাব (Hot | Favorite | Recent) শুধুমাত্র Slots ক্যাটাগরিতে দেখাবে।
      // Live Casino ও Sports-এ ক্লিক করলে সরাসরি সেই ক্যাটাগরির গেম + প্রোভাইডার লিস্ট দেখাবে, কোনো সেকেন্ডারি ট্যাব ছাড়াই।
      const showSecondaryTabs = SECONDARY_TAB_CATEGORIES.includes(selectedCategory);
      const secTabs = document.getElementById('secondaryTabs');
      if (secTabs) {
        secTabs.style.display = showSecondaryTabs ? 'flex' : 'none';
        secTabs.querySelectorAll('.secondary-tab-item').forEach(t => t.classList.remove('active'));
        const defaultTab = secTabs.querySelector('[data-secondary="hot"]');
        if (defaultTab) defaultTab.classList.add('active');
      }

      renderCatalogProviderList();
      renderGames();
    });
  });

  // ==================== সেকেন্ডারি ফিল্টার ট্যাব (All/Hot/Favorites/Recent) ====================
  document.querySelectorAll('.secondary-tab-item').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.secondary-tab-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      renderGames();
    });
  });

  // ==================== লেআউট সুইচার ====================
  function applyLayout() {
    const c = document.getElementById('gameContainer');
    if (!c) return;
    c.classList.remove('layout-compact', 'layout-list');
    if (selectedLayout === 'compact') c.classList.add('layout-compact');
    if (selectedLayout === 'list') c.classList.add('layout-list');
    document.querySelectorAll('.layout-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.layout === selectedLayout);
    });
  }
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedLayout = btn.dataset.layout;
      localStorage.setItem('bet420_game_layout', selectedLayout);
      applyLayout();
    });
  });

  var gs = document.getElementById('gameSearch');
  if (gs) {
    gs.addEventListener('input', renderGames);
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderCatalogProviderList();
    applyLayout();
    renderGames();
  });
})();
