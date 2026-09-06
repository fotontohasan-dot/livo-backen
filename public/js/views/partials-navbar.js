// views/partials/navbar.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

window.addEventListener('error', function(ev){
  var bar = document.getElementById('navErrBar');
  if(!bar){ bar = document.createElement('div'); bar.id='navErrBar'; bar.style.cssText='position:fixed;top:0;left:0;right:0;z-index:999999;background:#dc2626;color:#fff;font-size:13px;padding:10px;text-align:center;'; document.body.appendChild(bar); }
  bar.textContent = 'ERROR: ' + ev.message + ' @ line ' + ev.lineno + ' (' + (ev.filename||'').split('/').pop() + ')';
});

var lvScrollY = 0;
function toggleMenu() {
  var menu = document.getElementById('sideMenu');
  var overlay = document.getElementById('menuOverlay');
  if (!menu) return;
  var willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  if (overlay) overlay.classList.toggle('show', willOpen);

  if (willOpen) {
    lvScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = (-lvScrollY) + 'px';
    document.body.classList.add('menu-open');
  } else {
    document.body.classList.remove('menu-open');
    document.body.style.top = '';
    window.scrollTo(0, lvScrollY);
  }
}
window.toggleMenu = toggleMenu;
var lvHam = document.getElementById('lvHamburger'); if (lvHam) lvHam.addEventListener('click', toggleMenu);

var lvClose = document.getElementById('lvClose'); if (lvClose) lvClose.addEventListener('click', toggleMenu);
var lvOv = document.getElementById('menuOverlay'); if (lvOv) lvOv.addEventListener('click', toggleMenu);


var lvOv = document.getElementById('menuOverlay'); if (lvOv) lvOv.addEventListener('click', toggleMenu);


document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    var menu = document.getElementById('sideMenu');
    if (menu && menu.classList.contains('open')) toggleMenu();
  }
});

(function () {
  var btnNav = document.getElementById('theme-toggle-nav');
  var btnSide = document.getElementById('theme-toggle-side');
  function applyTheme(theme) {
    var light = theme === 'light';
    document.body.classList.toggle('light-mode', light);
    document.querySelectorAll('.nav-theme-icon').forEach(function (icon) {
      icon.className = 'fas ' + (light ? 'fa-sun' : 'fa-moon') + ' nav-theme-icon';
    });
  }
  applyTheme(localStorage.getItem('livo-theme') || 'dark');
  function handleToggle() {
    var next = document.body.classList.contains('light-mode') ? 'dark' : 'light';
    localStorage.setItem('livo-theme', next);
    applyTheme(next);
  }
  if (btnNav) btnNav.addEventListener('click', handleToggle);
  if (btnSide) btnSide.addEventListener('click', handleToggle);
})();


// ===== রিয়েল-টাইম ব্যালেন্স আপডেট =====
function refreshBalance() {
  var btn = document.getElementById('refreshBtn');
  if (btn) btn.classList.add('spinning');

  fetch('/coins/balance', { headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.success && d.coins != null) {
        // হেডারে সার্ভার-রেন্ডার করা ফরম্যাটের সাথে মিল রাখতে locale ফরম্যাটিং
        var locale = document.documentElement.lang === 'en' ? 'en-US' : 'bn-BD';
        var shown;
        try { shown = Number(d.coins).toLocaleString(locale); } catch (e) { shown = String(d.coins); }
        document.querySelectorAll('.js-balance').forEach(function (el) {
          el.textContent = shown;
        });
      }
    })
    .catch(function () {})
    .finally(function() {
      setTimeout(function() {
        if (btn) btn.classList.remove('spinning');
      }, 500);
    });
}
window.refreshBalance = refreshBalance;

(function () {
  // অ্যাপে ফিরলে বা ট্যাব আবার দেখলে ব্যালেন্স রিফ্রেশ
  window.addEventListener('focus', refreshBalance);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshBalance();
  });
  // প্রতি ৩০ সেকেন্ডে একবার
  setInterval(refreshBalance, 30000);
})();

// নেভবারের বাটন — আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  var actions = { 'toggle-menu': toggleMenu, 'refresh-balance': refreshBalance };
  document.querySelectorAll('[data-navbar-action]').forEach(function (el) {
    var fn = actions[el.getAttribute('data-navbar-action')];
    if (fn) el.addEventListener('click', fn);
  });
});
