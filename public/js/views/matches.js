// views/matches.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('matchesConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  const CURRENT_SPORT = cfg.sport;
  const IS_LOGGED_IN = !!cfg.loggedIn;

  // ========== Card builder ==========
  function buildMatchCard(m, isLive) {
    const sportIcon = m.sport === 'football' ? '⚽' : '🏏';
    const tournament = m.league || m.name || cfg.matchLabel;
    const teamA = (m.teams && m.teams[0]) || m.homeTeam || cfg.teamA;
    const teamB = (m.teams && m.teams[1]) || m.awayTeam || cfg.teamB;
    const scoreA = m.homeScore != null ? m.homeScore : (m.score && m.score[0] ? `${m.score[0].r}/${m.score[0].w}` : null);
    const scoreB = m.awayScore != null ? m.awayScore : (m.score && m.score[1] ? `${m.score[1].r}/${m.score[1].w}` : null);
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
    
    const statusHTML = isLive && m.status
      ? `<div style="margin-top:10px;font-size:12px;color: var(--text-accent);font-weight:600;text-align:center;">${m.status}</div>`
      : '';
    
    const btnHTML = IS_LOGGED_IN
      ? `<a href="/matches/${m.id}" class="predict-btn-card">🎯 ${cfg.predictNow}</a>`
      : `<a href="/login" class="predict-btn-card" style="background:var(--bg-glass);color:var(--text-main);border:1px solid var(--border-glass); text-decoration: none;">${cfg.loginToPredict}</a>`;
    
    return `
      <div class="match-card ${isLive ? 'live' : ''}" data-match-href="/matches/${m.id}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;">
            ${sportIcon} ${tournament}
          </div>
          ${badge}
        </div>
        
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;">
          <div class="jersey jersey-a">👕</div>
          <div style="flex:1;font-weight:600;font-size:14px;color:var(--text-main);">${teamA}</div>
          ${scoreHTML}
        </div>
        
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--border-glass);">
          <div class="jersey jersey-b">👕</div>
          <div style="flex:1;font-weight:600;font-size:14px;color:var(--text-main);">${teamB}</div>
          ${scoreBHTML}
        </div>
        
        ${statusHTML}
        ${btnHTML}
      </div>
    `;
  }

  // ========== Render ==========
  function renderMatches(matches) {
    const live = [];
    const upcoming = [];

    // ডাটাবেজে matches.status-এর মান তিনটাই: 'live' | 'upcoming' | 'finished'
    // (services/providers/normalizedMatch.js-এর VALID_STATUSES দ্রষ্টব্য)। আগে এখানে
    // শুধু 'live' খোঁজা হতো আর বাকি সবকিছু "upcoming" ধরে নেওয়া হতো — ফলে শেষ হয়ে
    // যাওয়া ম্যাচও "আসন্ন ম্যাচ" তালিকায় দেখাত। নতুন কোনো স্ট্যাটাস কনভেনশন তৈরি করা
    // হয়নি; বিদ্যমান তিনটা মানকেই সঠিকভাবে আলাদা করা হলো।
    matches.forEach(m => {
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
  async function fetchMatches() {
    try {
      const res = await fetch('/matches/api/live');
      const data = await res.json();
      if (!data.success) throw new Error('API error');
      
      let all = [];
      if (CURRENT_SPORT === 'all' || CURRENT_SPORT === 'cricket') all = all.concat(data.cricket || []);
      if (CURRENT_SPORT === 'all' || CURRENT_SPORT === 'football') all = all.concat(data.football || []);
      
      renderMatches(all);
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
  const socket = io();

  socket.on('connect', () => {
    updateStatus(cfg.statusOk, '#10b981');
    socket.emit('join_matches');
  });

  socket.on('disconnect', () => {
    updateStatus(cfg.statusError, '#94a3b8');
  });

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
