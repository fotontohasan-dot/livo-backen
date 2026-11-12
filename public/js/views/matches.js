// views/matches.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('matchesConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  const CURRENT_SPORT = cfg.sport;
  const IS_LOGGED_IN = !!cfg.loggedIn;

  // Feed data comes from an external JSON source: escape before putting it in innerHTML.
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // CSP is img-src 'self' data: — only local paths / data: images can load; anything else falls back to the jersey.
  function safeLogo(u) {
    if (!u || typeof u !== 'string') return '';
    return (/^\/(?!\/)/.test(u) || /^data:image\//.test(u)) ? u : '';
  }
  function crest(url, cls) {
    const src = safeLogo(url);
    return src ? `<img class="team-logo" src="${esc(src)}" alt="" loading="lazy">` : `<div class="jersey ${cls}">👕</div>`;
  }

  // ========== Card builder ==========
  function buildMatchCard(m, isLive) {
    const sportIcon = m.sport === 'football' ? '⚽' : (m.sport === 'tennis' ? '🎾' : '🏏');
    const tournament = esc(m.league || m.name || cfg.matchLabel);
    const teamA = esc((m.teams && m.teams[0]) || m.homeTeam || cfg.teamA);
    const teamB = esc((m.teams && m.teams[1]) || m.awayTeam || cfg.teamB);
    const scoreA = m.homeScore != null ? esc(m.homeScore) : (m.score && m.score[0] ? `${m.score[0].r}/${m.score[0].w}` : null);
    const scoreB = m.awayScore != null ? esc(m.awayScore) : (m.score && m.score[1] ? `${m.score[1].r}/${m.score[1].w}` : null);
    const dateStr = m.date ? new Date(m.date).toLocaleString(cfg.locale, {dateStyle:'medium', timeStyle:'short'}) : '';
    
    const badge = isLive 
      ? `<span class="live-badge"><span style="width:7px;height:7px;border-radius:50%;background:#ef4444;animation:livedot 1.5s infinite;"></span>${cfg.liveLabel}</span>`
      : `<span class="upcoming-badge">📅 ${dateStr || cfg.upcoming}</span>`;
    
    const scoreHTML = isLive && scoreA != null
      ? `<div style="font-family:'Teko',sans-serif;font-size:1.4rem;color: var(--text-accent);">${scoreA}</div>`
      : '';
    
    const scoreBHTML = isLive && scoreB != null
      ? `<div style="font-family:'Teko',sans-serif;font-size:1.4rem;color: var(--text-accent);">${scoreB}</div>`
      : '';
    
    const staleHTML = m.data_stale
      ? `<div style="margin-top:6px;font-size:11px;color:#e0a800;font-weight:600;text-align:center;" role="status">⚠ ${esc(m.stale_label || '')}</div>`
      : '';
    
    const statusHTML = isLive && m.status
      ? `<div style="margin-top:10px;font-size:12px;color: var(--text-accent);font-weight:600;text-align:center;">${esc(m.status)}</div>`
      : '';
    
    const oversHTML = isLive && m.overs ? `<div class="mc-overs">${esc(m.overs)}</div>` : '';

    const btnHTML = IS_LOGGED_IN
      ? `<a href="/matches/${encodeURIComponent(m.id)}" class="predict-btn-card">🎯 ${cfg.predictNow}</a>`
      : `<a href="/login" class="predict-btn-card" style="background:var(--bg-glass);color:var(--text-main);border:1px solid var(--border-glass); text-decoration: none;">${cfg.loginToPredict}</a>`;
    
    return `
      <div class="match-card ${isLive ? 'live' : ''}" data-match-href="/matches/${encodeURIComponent(m.id)}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;">
            ${sportIcon} <span class="lg-badge">${tournament}</span>
          </div>
          ${badge}
        </div>
        
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;">
          ${crest(m.logoA, 'jersey-a')}
          <div style="flex:1;font-weight:600;font-size:14px;color:var(--text-main);">${teamA}</div>
          ${scoreHTML}
        </div>
        
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--border-glass);">
          ${crest(m.logoB, 'jersey-b')}
          <div style="flex:1;font-weight:600;font-size:14px;color:var(--text-main);">${teamB}</div>
          ${scoreBHTML}
        </div>
        
        ${statusHTML}${staleHTML}
        ${oversHTML}
        ${btnHTML}
      </div>
    `;
  }

  // ========== Render ==========
  let ALL_DATA = { cricket: [], football: [], tennis: [], other: [] };
  let statusFilter = 'all';
  let leagueFilter = '';

  // Local-calendar day key so Today/Tomorrow follow the viewer's own clock
  function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function matchDay(m) {
    if (!m.date) return null;
    const d = new Date(m.date);
    return Number.isNaN(d.getTime()) ? null : dayKey(d);
  }

  function isLiveStatus(m) {
    const st = (m.status || '').toLowerCase();
    return st === 'live' || st.includes('live') || st.includes('in play') || st.includes('progress');
  }
  // In-Play = live AND already has a score or overs on the board
  function isInPlay(m) { return isLiveStatus(m) && (m.homeScore || m.awayScore || m.overs); }

  function updateCounts() {
    const per = {
      cricket: ALL_DATA.cricket.filter(isLiveStatus).length,
      football: ALL_DATA.football.filter(isLiveStatus).length,
      tennis: ALL_DATA.tennis.filter(isLiveStatus).length
    };
    per.all = per.cricket + per.football + per.tennis + ALL_DATA.other.filter(isLiveStatus).length;
    Object.keys(per).forEach(function (k) {
      const n = document.querySelector('[data-cnt="' + k + '"]');
      if (n) n.textContent = per[k] > 0 ? per[k] : '';
    });
  }

  function renderMatches(matches) {
    const live = [];
    const upcoming = [];

    // ডাটাবেজে matches.status-এর মান তিনটাই: 'live' | 'upcoming' | 'finished'
    // (services/providers/normalizedMatch.js-এর VALID_STATUSES দ্রষ্টব্য)। আগে এখানে
    // শুধু 'live' খোঁজা হতো আর বাকি সবকিছু "upcoming" ধরে নেওয়া হতো — ফলে শেষ হয়ে
    // যাওয়া ম্যাচও "আসন্ন ম্যাচ" তালিকায় দেখাত। নতুন কোনো স্ট্যাটাস কনভেনশন তৈরি করা
    // হয়নি; বিদ্যমান তিনটা মানকেই সঠিকভাবে আলাদা করা হলো।
    matches.forEach(m => {
      if (statusFilter === 'inplay' && !isInPlay(m)) return;
      if (statusFilter === 'live' && !isLiveStatus(m)) return;
      if (statusFilter === 'upcoming' && isLiveStatus(m)) return;
      if (statusFilter === 'today' && !(isLiveStatus(m) || matchDay(m) === dayKey(new Date()))) return;
      if (statusFilter === 'tomorrow') {
        const t = new Date(); t.setDate(t.getDate() + 1);
        if (matchDay(m) !== dayKey(t)) return;
      }
      if (leagueFilter && (m.league || '') !== leagueFilter) return;
      const status = (m.status || '').toLowerCase();
      if (status === 'live' || status.includes('live') || status.includes('in play') || status.includes('progress')) {
        live.push(m);
      } else if (status === 'finished' || status.includes('finished') || status.includes('ended')) {
        // শেষ হওয়া ম্যাচ কোনো তালিকাতেই যাবে না — বিস্তারিত /matches/:id পেজে আগের মতোই দেখা যায়
      } else {
        upcoming.push(m);
      }
    });
    
    // Live section
    const liveSection = document.getElementById('liveSection');
    const liveList = document.getElementById('liveList');
    const liveCount = document.getElementById('liveCount');
    
    if (live.length > 0) {
      liveSection.style.display = 'block';
      liveCount.textContent = live.length;
      liveList.innerHTML = live.map(m => buildMatchCard(m, true)).join('');
    } else {
      liveSection.style.display = 'none';
    }
    
    // Upcoming section
    const upcomingList = document.getElementById('upcomingList');
    const upcomingCount = document.getElementById('upcomingCount');
    const upcomingSection = document.getElementById('upcomingSection');
    
    if (upcoming.length > 0) {
      upcomingSection.style.display = 'block';
      upcomingCount.textContent = upcoming.length;
      upcomingList.innerHTML = upcoming.slice(0, 30).map(m => buildMatchCard(m, false)).join('');
    } else {
      upcomingSection.style.display = 'none';
    }
    
    // Empty state
    document.getElementById('emptyState').style.display =
      (live.length === 0 && upcoming.length === 0) ? 'block' : 'none';
  }

  // ========== Fetch from API ==========
  function rerender() {
    let all = [];
    if (CURRENT_SPORT === 'all') all = all.concat(ALL_DATA.cricket, ALL_DATA.football, ALL_DATA.tennis, ALL_DATA.other);
    else all = (ALL_DATA[CURRENT_SPORT] || []).slice();
    populateLeagues(all);
    renderMatches(all);
  }

  // Competitions dropdown built from whatever leagues the current sport tab contains
  function populateLeagues(all) {
    const sel = document.getElementById('leagueFilter');
    if (!sel) return;
    const names = Array.from(new Set(all.map(function (m) { return m.league; }).filter(Boolean))).sort();
    if (names.indexOf(leagueFilter) === -1) leagueFilter = '';
    sel.textContent = '';
    const first = document.createElement('option');
    first.value = ''; first.textContent = 'Competitions';
    sel.appendChild(first);
    names.forEach(function (n) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
    sel.value = leagueFilter;
  }

  async function fetchMatches() {
    try {
      const res = await fetch('/matches/api/live');
      const data = await res.json();
      if (!data.success) throw new Error('API error');
      
      ALL_DATA = {
        cricket: data.cricket || [], football: data.football || [],
        tennis: data.tennis || [], other: data.other || []
      };
      updateCounts();
      rerender();
      updateStatus(cfg.lastUpdate + ': ' + new Date().toLocaleTimeString(cfg.locale));
    } catch (err) {
      console.error('Fetch error:', err);
      updateStatus('ডেটা লোড করতে সমস্যা', '#ef4444');
    }
  }

  function updateStatus(text, color) {
    const dot = document.getElementById('liveDot');
    const status = document.getElementById('liveStatus');
    if (status) status.textContent = text;
    if (dot && color) dot.style.background = color;
  }

  // ========== Socket.io ==========
  const socket = window.livoSocket();

  socket.on('connect', () => {
    updateStatus(cfg.statusOk, '#10b981');
    socket.emit('join_matches');
  });

  socket.on('disconnect', () => {
    updateStatus(cfg.statusError, '#94a3b8');
  });

  // Feed pushes: debounce, then refetch (the feed endpoint already cleared the Redis cache)
  let refetchTimer = null;
  socket.on('matchListUpdate', () => {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(fetchMatches, 400);
  });

  const filters = document.getElementById('statusFilters');
  if (filters) {
    filters.addEventListener('click', function (e) {
      const b = e.target.closest('.flt');
      if (!b || b.tagName === 'SELECT') return; // the Competitions <select> has its own change handler
      statusFilter = b.dataset.filter;
      filters.querySelectorAll('.flt').forEach(function (x) { x.classList.toggle('active', x === b); });
      rerender();
    });
  }

  const leagueSel = document.getElementById('leagueFilter');
  if (leagueSel) {
    leagueSel.addEventListener('change', function () {
      leagueFilter = leagueSel.value;
      leagueSel.classList.toggle('active', !!leagueFilter);
      rerender();
    });
  }

  socket.on('matches_update', (data) => {
    // Server sent DB-shaped data; refetch our API endpoint instead for consistency
    fetchMatches();
    
    // Flash the dot
    const dot = document.getElementById('liveDot');
    if (dot) {
      dot.style.transform = 'scale(2)';
      setTimeout(() => dot.style.transform = 'scale(1)', 400);
    }
  });

  window.addEventListener('beforeunload', () => {
    socket.emit('leave_matches');
    socket.disconnect();
  });

  // Initial load
  fetchMatches();

  // Refresh every 30 seconds (backup if socket fails)
  setInterval(fetchMatches, 30000);

  // ম্যাচ কার্ডে ক্লিক করলে বিস্তারিত পেজে যায়, কিন্তু কার্ডের ভেতরের <a>
  // ক্লিক করলে নয় — আগের ইনলাইন কোডে সেই শর্তটাই ছিল, তাই সেটা রাখা হয়েছে।
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('a')) return;
    var card = e.target.closest('[data-match-href]');
    if (!card) return;
    var href = card.getAttribute('data-match-href') || '';
    if (href.charAt(0) !== '/' || href.charAt(1) === '/') return;
    window.location.href = href;
  });
})();
