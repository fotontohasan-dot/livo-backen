// views/payment/withdraw.ejs-এর আচরণ। আগে একটা ইনলাইন <script> ব্লক আর
// ৬টা ইনলাইন হ্যান্ডলার ছিল।
//
// দুটো "চোখ" টগল প্রায় একই কোড ছিল (পাসওয়ার্ড আর withdraw PIN) — এখন
// একটাই জেনেরিক হ্যান্ডলার, লক্ষ্য এলিমেন্ট data-* থেকে আসে।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  function syncWallet() {
    var sel = document.getElementById('walletSelect');
    if (!sel) return;
    var opt = sel.options[sel.selectedIndex];
    if (!opt) return;
    var methodField = document.getElementById('methodField');
    var numberField = document.getElementById('accountNumberField');
    if (methodField) methodField.value = opt.dataset.method || '';
    if (numberField) numberField.value = opt.dataset.number || '';
  }

  // পাসওয়ার্ড / PIN দেখানো-লুকানো। আগে দুটো আলাদা ফাংশনে একই যুক্তি ছিল।
  function toggleReveal(fieldId, iconId) {
    var field = document.getElementById(fieldId);
    var icon = document.getElementById(iconId);
    if (!field || !icon) return;
    var hidden = field.type === 'password';
    field.type = hidden ? 'text' : 'password';
    icon.classList.toggle('fa-eye', hidden);
    icon.classList.toggle('fa-eye-slash', !hidden);
  }

  function init() {
    // সাধারণ hook (data-confirm, data-modal-open/close, data-auto-submit,
    // data-loading-*) এখন public/js/ui-hooks.js সামলায় — partials/head.ejs ও
    // admin-layout.ejs দুটোতেই লোড হয়। এখানে আবার বাঁধলে হ্যান্ডলার দুবার
    // চলত: confirm দুবার দেখাত, ফর্ম দুবার সাবমিট হত।

    document.querySelectorAll('[data-sync-wallet]').forEach(function (el) {
      el.addEventListener('change', syncWallet);
      // পেজ লোডেই প্রথম ওয়ালেট আগে থেকে সিলেক্ট করা থাকে (views/payment/withdraw.ejs),
      // কিন্তু 'change' ইভেন্ট তখন ফায়ার হয় না — তাই hidden method/account_number
      // ফিল্ড খালি থেকে যেত যতক্ষণ না ইউজার নিজে ম্যানুয়ালি dropdown বদলাত।
      syncWallet();
    });

    document.querySelectorAll('[data-reveal-field]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        toggleReveal(btn.getAttribute('data-reveal-field'), btn.getAttribute('data-reveal-icon'));
      });
    });

    initTabs();
    initBalanceRefresh();
  }

  // E-wallet / ক্রিপ্টো ট্যাব। টেমপ্লেটের ইনলাইন <script> থেকে সরানো হলো।
  function switchTab(tab) {
    var tabEwallet = document.getElementById('tabEwallet');
    var tabCrypto = document.getElementById('tabCrypto');
    var panelEwallet = document.getElementById('panelEwallet');
    var panelCrypto = document.getElementById('panelCrypto');
    if (!tabEwallet || !tabCrypto || !panelEwallet || !panelCrypto) return;
    tabEwallet.classList.toggle('active', tab === 'ewallet');
    tabCrypto.classList.toggle('active', tab === 'crypto');
    panelEwallet.style.display = tab === 'ewallet' ? 'block' : 'none';
    panelCrypto.style.display = tab === 'crypto' ? 'block' : 'none';
  }

  function initTabs() {
    var tabEwallet = document.getElementById('tabEwallet');
    var tabCrypto = document.getElementById('tabCrypto');
    if (tabEwallet) tabEwallet.addEventListener('click', function () { switchTab('ewallet'); });
    if (tabCrypto) tabCrypto.addEventListener('click', function () { switchTab('crypto'); });
  }

  function initBalanceRefresh() {
    var refreshBtn = document.getElementById('refreshBalanceBtn');
    if (!refreshBtn) return;
    refreshBtn.addEventListener('click', function () {
      // আগে শুধু location.reload() করা হতো — সার্ভিস ওয়ার্কার বা ব্রাউজার
      // ক্যাশে আটকে গেলে ইউজারের কাছে মনে হতো বাটনটা "কাজ করছে না" (কোনো
      // দৃশ্যমান পরিবর্তন নেই)। এখন সরাসরি সার্ভার থেকে ব্যালেন্স ফেচ করে
      // DOM-এ বসানো হয়, সাথে বাটনে স্পষ্ট লোডিং অবস্থা দেখানো হয়।
      var icon = document.getElementById('refreshIcon');
      refreshBtn.disabled = true;
      if (icon) icon.classList.add('fa-spin');
      fetch('/profile/api/balance', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(function (data) {
          if (!data || data.success === false) { location.reload(); return; }
          var amt = (Number(data.coins) || 0).toFixed(2);
          var mainEl = document.getElementById('mainWalletAmt');
          var availEl = document.getElementById('availableAmt');
          if (mainEl) mainEl.textContent = amt;
          if (availEl) availEl.textContent = amt;
        })
        .catch(function () {
          // ফেচ ব্যর্থ হলে পুরনো ব্যবহারে ফিরে গিয়ে পুরো পেজ রিলোড করা হয়
          location.reload();
        })
        .finally(function () {
          refreshBtn.disabled = false;
          if (icon) icon.classList.remove('fa-spin');
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
