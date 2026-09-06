// views/profile/security.ejs-এর আচরণ। আগে এটা একটা ইনলাইন <script> ব্লক ছিল
// আর ১৭টা ইনলাইন onclick/onsubmit হ্যান্ডলার টেমপ্লেটে ছড়ানো ছিল — দুটোই CSP-তে
// 'unsafe-inline' রাখতে বাধ্য করত। এখন সব আচরণ এখানে, আর টেমপ্লেট শুধু
// data-* অ্যাট্রিবিউট দিয়ে বলে কোন এলিমেন্ট কী করে।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  function switchTab(tab) {
    document.querySelectorAll('.sec-content').forEach(function (c) { c.style.display = 'none'; });
    document.querySelectorAll('.sec-tab').forEach(function (b) { b.classList.remove('active'); });
    var content = document.getElementById('tab-' + tab);
    var btn = document.getElementById('btn-' + tab);
    if (content) content.style.display = 'block';
    if (btn) btn.classList.add('active');
  }

  // ==================== Withdraw PIN ফর্ম টগল ====================
  function hidePinForms() {
    ['create', 'change', 'reset'].forEach(function (t) {
      var f = document.getElementById('pinForm' + t);
      if (f) f.style.display = 'none';
    });
  }

  function showPinForm(type) {
    hidePinForms();
    var f = document.getElementById('pinForm' + type);
    if (f) f.style.display = 'flex';
  }

  function handlePinSubmit(form) {
    var btn = form.querySelector('.pin-submit-btn');
    if (window.LivoToast) window.LivoToast.setLoading(btn, true);
    return true;
  }

  function init() {
    // সাধারণ hook (data-confirm, data-modal-open/close, data-auto-submit,
    // data-loading-*) এখন public/js/ui-hooks.js সামলায় — partials/head.ejs ও
    // admin-layout.ejs দুটোতেই লোড হয়। এখানে আবার বাঁধলে হ্যান্ডলার দুবার
    // চলত: confirm দুবার দেখাত, ফর্ম দুবার সাবমিট হত।

    // ট্যাব সুইচ — ট্যাব বাটন ও উপরের স্ট্যাটাস কার্ড, দুটোই
    document.querySelectorAll('[data-switch-tab]').forEach(function (el) {
      el.addEventListener('click', function () {
        switchTab(el.getAttribute('data-switch-tab'));
      });
    });

    // PIN ফর্ম খোলা
    document.querySelectorAll('[data-pin-form]').forEach(function (el) {
      el.addEventListener('click', function () {
        showPinForm(el.getAttribute('data-pin-form'));
      });
    });

    // PIN ফর্ম বাতিল
    document.querySelectorAll('[data-pin-cancel]').forEach(function (el) {
      el.addEventListener('click', function () { hidePinForms(); });
    });

    // PIN ফর্ম সাবমিট — বাটনে লোডিং স্টেট
    document.querySelectorAll('[data-pin-submit]').forEach(function (form) {
      form.addEventListener('submit', function () { handlePinSubmit(form); });
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
