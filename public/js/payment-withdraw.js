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
    });

    document.querySelectorAll('[data-reveal-field]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        toggleReveal(btn.getAttribute('data-reveal-field'), btn.getAttribute('data-reveal-icon'));
      });
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
