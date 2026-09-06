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

  // সার্ভারে যেসব গেমের আসল লজিক আছে — শুধু এগুলোই খেলা যায়। বাকিগুলো কার্ডে
  // দেখা যাবে কিন্তু "শীঘ্রই" অবস্থায়, ক্লিক করলে কিছু হবে না। তালিকাটা
  // services/gameRegistry.js থেকে আসে, লবি নিজে অনুমান করে না।
  const PLAYABLE_SLUGS = new Set(cfg.playableSlugs || []);

  const allGames = SERVER_GAMES.length > 0 ? SERVER_GAMES : [
    { name: 'Aviator', emoji: '🎰', type: 'slots', slug: 'aviator', badge: 'hot', provider: 'Spribe' },
    { name: 'Slots', emoji: '💎', type: 'slots', slug: 'slots', badge: 'pop', provider: 'Playtech' },
    { name: 'Roulette', emoji: '🍭', type: 'live', slug: 'roulette', badge: 'new', provider: 'Playtech' },
    { name: 'Andar Bahar', emoji: '⚡', type: 'live', slug: 'andar-bahar', badge: null, provider: 'Jili' },
    { name: 'Teen Patti', emoji: '🔥', type: 'poker', slug: 'teen-patti', badge: 'hot', provider: 'Jili' },
    { name: 'Blackjack', emoji: '🐉', type: 'live', slug: 'blackjack', badge: 'hot', provider: 'Playtech' },
    { name: 'Poker', emoji: '🎴', type: 'poker', slug: 'poker', badge: 'pop', provider: 'Playtech' },
    { name: 'Baccarat', emoji: '🃏', type: 'live', slug: 'baccarat', badge: 'new', provider: 'Playtech' },
    { name: 'Crash Game', emoji: '🎲', type: 'slots', slug: 'crash-game', badge: null, provider: 'Playtech' },
    { name: 'Starburst', emoji: '🎯', type: 'slots', slug: 'starburst', badge: 'hot', provider: 'NetEnt' },
    { name: 'Book of Dead', emoji: '🎡', type: 'slots', slug: 'book-of-dead', badge: 'hot', provider: 'Play\'n GO' },
    { name: 'Gonzo\'s Quest', emoji: '🚀', type: 'slots', slug: 'gonzos-quest', badge: 'pop', provider: 'NetEnt' },
    { name: 'Mega Moolah', emoji: '👑', type: 'slots', slug: 'mega-moolah', badge: 'hot', provider: 'Microgaming' },
    { name: 'Gates of Olympus', emoji: '🦁', type: 'slots', slug: 'gates-of-olympus', badge: 'hot', provider: 'Pragmatic Play' },
    { name: 'Sweet Bonanza', emoji: '🐯', type: 'slots', slug: 'sweet-bonanza', badge: 'hot', provider: 'Pragmatic Play' },
    { name: 'Legacy of Dead', emoji: '🌊', type: 'slots', slug: 'legacy-of-dead', badge: 'hot', provider: 'Play\'n GO' },
    { name: 'Crazy Time', emoji: '⚓', type: 'live', slug: 'crazy-time', badge: 'hot', provider: 'Evolution' },
    { name: 'Lightning Roulette', emoji: '🥷', type: 'live', slug: 'lightning-roulette', badge: 'new', provider: 'Evolution' },
    { name: 'Monopoly Live', emoji: '🀄', type: 'live', slug: 'monopoly-live', badge: null, provider: 'Evolution' },
    { name: 'Mega Ball', emoji: '🐺', type: 'live', slug: 'mega-ball', badge: null, provider: 'Evolution' },
    { name: 'Dream Catcher', emoji: '🍀', type: 'live', slug: 'dream-catcher', badge: 'hot', provider: 'Evolution' },
    { name: 'Super Sic Bo', emoji: '💰', type: 'live', slug: 'super-sic-bo', badge: 'pop', provider: 'Evolution' },
    { name: 'Fan Tan', emoji: '🏆', type: 'live', slug: 'fan-tan', badge: 'new', provider: 'Evolution' },
    { name: 'Bac Bo', emoji: '🎪', type: 'live', slug: 'bac-bo', badge: null, provider: 'Evolution' },
    { name: 'Rummy', emoji: '🌟', type: 'poker', slug: 'rummy', badge: null, provider: 'Jili' },
    { name: 'Call Break', emoji: '🎆', type: 'poker', slug: 'call-break', badge: 'hot', provider: 'Jili' },
    { name: 'Dragon Tiger', emoji: '❄️', type: 'live', slug: 'dragon-tiger', badge: 'hot', provider: 'Jili' },
    { name: 'JetX', emoji: '⛩️', type: 'slots', slug: 'jetx', badge: 'hot', provider: 'Spribe' },
    { name: 'Plinko', emoji: '🍬', type: 'slots', slug: 'plinko', badge: null, provider: 'Spribe' },
    { name: 'Super Ace', emoji: '👑', type: 'slots', slug: 'super-ace', badge: 'hot', provider: 'Jili' },
    { name: 'Golden Empire', emoji: '🏛️', type: 'slots', slug: 'golden-empire', badge: null, provider: 'PG Soft' },
    { name: 'Wild Bandito', emoji: '🤠', type: 'slots', slug: 'wild-bandito', badge: 'pop', provider: 'PG Soft' },
    { name: 'Sweet Bonanza Xmas', emoji: '🎄', type: 'slots', slug: 'sweet-bonanza-xmas', badge: null, provider: 'Pragmatic Play' },
    { name: 'Wild West Gold', emoji: '🐎', type: 'slots', slug: 'wild-west-gold', badge: 'hot', provider: 'Pragmatic Play' },
    { name: 'Gonzo\'s Quest Megaways', emoji: '🗿', type: 'slots', slug: 'gonzos-quest-megaways', badge: null, provider: 'Evolution' },
    { name: 'Mega Moolah Absolootly', emoji: '🐮', type: 'slots', slug: 'mega-moolah-absolootly', badge: null, provider: 'Microgaming' },
    { name: 'Piggy Riches Megaways', emoji: '🐷', type: 'slots', slug: 'piggy-riches-megaways', badge: null, provider: 'Red Tiger' },
    { name: 'Wanted Dead or a Wild', emoji: '🔫', type: 'slots', slug: 'wanted-dead-or-a-wild', badge: 'hot', provider: 'Hacksaw Gaming' },
    { name: 'Money Train 4', emoji: '🚂', type: 'slots', slug: 'money-train-4', badge: 'pop', provider: 'Relax Gaming' },
    { name: 'Mental', emoji: '🧠', type: 'slots', slug: 'mental', badge: null, provider: 'Nolimit City' },
    { name: 'Bonanza Megaways', emoji: '⛏️', type: 'slots', slug: 'bonanza-megaways', badge: null, provider: 'Big Time Gaming' },
    { name: 'Vikings Go Berzerk', emoji: '⚔️', type: 'slots', slug: 'vikings-go-berzerk', badge: null, provider: 'Yggdrasil' },
    { name: 'Sakura Fortune', emoji: '🌸', type: 'slots', slug: 'sakura-fortune', badge: null, provider: 'Quickspin' },
    { name: 'The Dog House', emoji: '🐶', type: 'slots', slug: 'the-dog-house', badge: null, provider: 'Betsoft' },
    { name: 'Larry Gonna Make It', emoji: '🎲', type: 'slots', slug: 'larry-gonna-make-it', badge: null, provider: 'Wazdan' },
    { name: 'Solar Queen', emoji: '☀️', type: 'slots', slug: 'solar-queen', badge: null, provider: 'Playson' },
    { name: 'Rise of Egypt', emoji: '🏺', type: 'slots', slug: 'rise-of-egypt', badge: null, provider: 'Spinomenal' },
  ];

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
  const PROVIDERS = Object.keys(PROVIDER_META);

  let selectedCategory = 'all';
  let selectedProvider = 'all';
  let selectedSecondaryTab = 'all';
  const CATALOG_CATEGORIES = ['slots', 'live', 'sports', 'poker'];
  // শুধুমাত্র এই ক্যাটাগরিগুলোতে উপরে Hot | Favorite | Recent সেকেন্ডারি ট্যাব দেখাবে।
  // Live Casino এবং Sports-এ কোনো সেকেন্ডারি ট্যাব থাকবে না — শুধু প্রোভাইডার লিস্ট ও গেম গ্রিড দেখাবে।
  const SECONDARY_TAB_CATEGORIES = ['slots'];
  let selectedLayout = localStorage.getItem('livo_game_layout') || 'standard';

  // ==================== ফেভারিটস / রিসেন্ট (localStorage-ভিত্তিক) ====================
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem('livo_favorites') || '[]'); } catch (e) { return []; }
  }
  function toggleFavorite(slug) {
    let favs = getFavorites();
    if (favs.includes(slug)) favs = favs.filter(s => s !== slug);
    else favs.push(slug);
    localStorage.setItem('livo_favorites', JSON.stringify(favs));
    renderGames();
  }
  function getRecent() {
    try { return JSON.parse(localStorage.getItem('livo_recent') || '[]'); } catch (e) { return []; }
  }
  function pushRecent(slug) {
    let recent = getRecent().filter(s => s !== slug);
    recent.unshift(slug);
    recent = recent.slice(0, 20);
    localStorage.setItem('livo_recent', JSON.stringify(recent));
  }

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

    const searchQ = document.getElementById('gameSearch') ? document.getElementById('gameSearch').value.toLowerCase() : '';
    const favs = getFavorites();
    const recent = getRecent();
    const isCatalogCategory = CATALOG_CATEGORIES.includes(selectedCategory);

    let source = allGames;
    if (isCatalogCategory) {
      // মূল ক্যাটাগরি (Slots/Live/Sports/Poker) অনুযায়ী নির্দিষ্ট, তার উপর secondary ট্যাব প্রয়োগ হয়
      source = allGames.filter(g => g.type === selectedCategory);
      if (selectedSecondaryTab === 'hot') {
        source = source.filter(g => g.badge === 'hot');
      } else if (selectedSecondaryTab === 'favorites') {
        source = source.filter(g => favs.includes(g.slug));
      } else if (selectedSecondaryTab === 'recent') {
        const recentSlugsInCategory = recent.filter(slug => source.some(g => g.slug === slug));
        source = recentSlugsInCategory.map(slug => source.find(g => g.slug === slug)).filter(Boolean);
      }
    } else if (selectedCategory === 'favorites') {
      source = allGames.filter(g => favs.includes(g.slug));
    } else if (selectedCategory === 'recent') {
      source = recent.map(slug => allGames.find(g => g.slug === slug)).filter(Boolean);
    }

    const filtered = source.filter(g => {
      const matchesSearch = g.name.toLowerCase().includes(searchQ);
      const matchesCategory = isCatalogCategory || selectedCategory === 'all' || selectedCategory === 'favorites' || selectedCategory === 'recent'
        || (selectedCategory === 'hot' ? g.badge === 'hot' : g.type === selectedCategory);
      const matchesProvider = selectedProvider === 'all' || g.provider === selectedProvider;
      return matchesSearch && matchesCategory && matchesProvider;
    });

    if (filtered.length === 0) {
      const isFavView = (isCatalogCategory && selectedSecondaryTab === 'favorites') || selectedCategory === 'favorites';
      const isRecentView = (isCatalogCategory && selectedSecondaryTab === 'recent') || selectedCategory === 'recent';
      const msg = isFavView ? 'এখনো কোনো গেইম ফেভারিটে যোগ করা হয়নি ⭐'
        : isRecentView ? 'সম্প্রতি কোনো গেইম খেলা হয়নি 🕒'
        : cfg.noGamesFound;
      c.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted); font-size: 13px;">${msg}</div>`;
      return;
    }

    filtered.forEach(g => {
      const playable = PLAYABLE_SLUGS.size === 0 || PLAYABLE_SLUGS.has(g.slug);
      const badgeHTML = !playable
        ? `<div class="game-badge-premium badge-soon">শীঘ্রই</div>`
        : (g.badge ? `<div class="game-badge-premium badge-${escHtml(g.badge)}">${escHtml(g.badge)}</div>` : '');
      const isFav = favs.includes(g.slug);
      const card = document.createElement('a');
      card.href = playable ? '/games/' + g.slug : 'javascript:void(0)';
      card.className = 'game-card-premium' + (playable ? '' : ' game-card-soon');
      if (!playable) card.setAttribute('aria-disabled', 'true');
      card.innerHTML = `
        <div class="game-thumb-wrapper">
          <i class="fa-star fav-star ${isFav ? 'fas active' : 'far'}" data-slug="${escHtml(g.slug)}"></i>
          <img class="game-thumb-img" src="/images/games/${escHtml(g.slug)}.svg" alt="" aria-hidden="true"
               loading="lazy" decoding="async" width="300" height="300"
               data-img-fallback="remove">
          <span class="game-emoji">${escHtml(g.emoji)}</span>
          ${badgeHTML}
        </div>
        <div class="game-info-premium">
          <div class="game-title-premium">${escHtml(g.name)}</div>
          <div class="game-provider-premium">${escHtml(g.provider)}</div>
        </div>`;
      card.addEventListener('click', (e) => {
        if (!playable) { e.preventDefault(); return; }
        pushRecent(g.slug);
      });
      const star = card.querySelector('.fav-star');
      star.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(g.slug);
      });
      c.appendChild(card);
    });
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
      selectedSecondaryTab = showSecondaryTabs ? 'hot' : 'all';
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
      selectedSecondaryTab = el.dataset.secondary;
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
      localStorage.setItem('livo_game_layout', selectedLayout);
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
