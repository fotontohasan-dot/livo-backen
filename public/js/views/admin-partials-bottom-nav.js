// views/admin/partials/bottom-nav.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

(function () {
  // "More" → সম্পূর্ণ অ্যাডমিন নেভিগেশন (সাইডবার ড্রয়ার)। openMobileSidebar()
  // admin-layout.ejs-এ সংজ্ঞায়িত; না থাকলে (অন্য লেআউট) নিঃশব্দে কিছুই হয় না।
  var moreBtn = document.getElementById('adminBnMore');
  if (moreBtn) {
    moreBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (typeof window.openMobileSidebar === 'function') {
        window.openMobileSidebar();
        moreBtn.setAttribute('aria-expanded', 'true');
      }
    });
  }

  function setBadge(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    var n = Number(val) || 0;
    if (n > 0) { el.textContent = n > 99 ? '99+' : n; el.classList.add('show'); }
    else { el.classList.remove('show'); }
  }

  function bump(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('pulse');
    void el.offsetWidth; // রিফ্লো — অ্যানিমেশন আবার ট্রিগার করার জন্য
    el.classList.add('pulse');
  }

  function loadCounts() {
    fetch('/admin/api/notification-counts')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        setBadge('bnBadgeDeposit', d.deposits);
        setBadge('bnBadgeWithdraw', d.withdrawals);
        setBadge('bnBadgeChat', d.chats);
        // KYC এখন বটম নেভে সরাসরি নেই — তার পেন্ডিং সংখ্যা "More"-এ দেখানো হয়,
        // যাতে মোবাইলে কিউটা চোখের আড়ালে না চলে যায়।
        setBadge('bnBadgeMore', d.kyc);
      })
      .catch(function () {});
  }

  function showToast(text) {
    var toastEl = document.getElementById('adminBnToast');
    if (!toastEl) return;
    // `text` আসে admin_alert ইভেন্ট থেকে, যার message ফিল্ডে ইউজারের পাঠানো চ্যাট-বার্তা
    // থাকে — অর্থাৎ সম্পূর্ণ অবিশ্বস্ত। innerHTML দিলে সেটা অ্যাডমিনের পেজে HTML হিসেবে
    // পার্স হতো; textContent-এ কখনোই হয় না।
    toastEl.textContent = '🔔 ' + String(text == null ? '' : text);
    toastEl.classList.add('show');
    clearTimeout(toastEl._hideTimer);
    toastEl._hideTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }

  // এক্সটার্নাল ফাইলের উপর নির্ভর না করে ছোট বিপ শব্দ জেনারেট করা হচ্ছে
  function playSound() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      [0, 0.14].forEach(function (delay) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 920;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.28);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.3);
      });
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    } catch (e) {}
  }

  var LABELS = { deposit: 'নতুন ডিপোজিট রিকোয়েস্ট', withdraw: 'নতুন উইথড্র রিকোয়েস্ট', chat: 'নতুন সাপোর্ট মেসেজ' };
  var BADGE_IDS = { deposit: 'bnBadgeDeposit', withdraw: 'bnBadgeWithdraw', chat: 'bnBadgeChat' };

  function handleAlert(data) {
    var type = data && data.type;
    if (BADGE_IDS[type]) bump(BADGE_IDS[type]);
    showToast((data && data.message) ? data.message : (LABELS[type] || 'নতুন নোটিফিকেশন'));
    playSound();
    loadCounts();
  }

  loadCounts();
  setInterval(loadCounts, 30000); // সকেট কোনো কারণে না পৌঁছালেও ৩০ সেকেন্ড পরপর ফলব্যাক আপডেট

  function connectSocket() {
    if (typeof io === 'undefined') return;
    var socket = io();
    socket.on('connect', function () { socket.emit('join_admin'); });
    socket.on('admin_alert', handleAlert);
    socket.on('new_message', function (data) {
      if (data && !data.isAdmin) handleAlert({ type: 'chat', message: 'নতুন সাপোর্ট মেসেজ এসেছে' });
    });
  }

  if (typeof io === 'undefined') {
    var s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = connectSocket;
    document.head.appendChild(s);
  } else {
    connectSocket();
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Layout A (Tailwind ড্যাশবোর্ড)-এর স্ক্রলযোগ্য কন্টেইনারে বটম-নেভের জন্য জায়গা রাখা
    var layoutAContent = document.querySelector('.flex-1.overflow-auto');
    if (layoutAContent) layoutAContent.style.paddingBottom = '76px';

    var path = window.location.pathname;
    var curTab = new URLSearchParams(window.location.search).get('tab') || 'deposit';
    document.querySelectorAll('#adminBottomNav a').forEach(function (a) {
      var href = a.getAttribute('href');
      var hp = href.split('?')[0];
      var hq = href.split('?')[1] || '';
      var samePath = (path === hp) || (hp !== '/admin/dashboard' && path.indexOf(hp) === 0);
      var sameTab = true;
      if (hq) sameTab = (new URLSearchParams(hq).get('tab') === curTab);
      if (samePath && sameTab) a.classList.add('active');
    });
    if (path === '/admin' || path === '/admin/dashboard') {
      document.querySelector('#adminBottomNav a').classList.add('active');
    }
  });
})();
