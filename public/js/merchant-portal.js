// public/js/merchant-portal.js
// মার্চেন্ট ব্যাকএন্ডের (views/merchant/partials/merchant-layout.ejs) ক্লায়েন্ট কোড।
//
// উপরের ডানের খরগোশ-পিয়ানো আইকনে ক্লিক → POST /merchant/credentials → মডালে Merchant ID ও API Key।
//
// নিরাপত্তা-সিদ্ধান্ত:
//  • API Key পেজের HTML-এ থাকে না; শুধু ক্লিকের পর আনা হয় (প্রতিবার সার্ভারে অডিট হয়)
//  • মডাল বন্ধ হলে ইনপুট থেকে মান মুছে ফেলা হয় — DOM-এ গোপন মান পড়ে থাকে না
//  • কী ডিফল্টভাবে masked (type=password); "দেখুন" চাপলে তবেই দেখায়
//  • fetch-এ CSRF হেডার /js/csrf-inject.js নিজেই বসায়
// লেবেল সার্ভার-রেন্ডার করা data-* অ্যাট্রিবিউট থেকে আসে (ভাষা-সচেতন; JS-এ হার্ডকোড স্ট্রিং নেই)।

(function () {
  'use strict';

  var modal = document.getElementById('mpCredsModal');
  if (!modal) return;

  var openers = document.querySelectorAll('[data-merchant-creds-open]');
  var closers = modal.querySelectorAll('[data-merchant-creds-close]');
  var statusEl = document.getElementById('mpCredsStatus');
  var errorEl = document.getElementById('mpCredsError');
  var fieldsEl = document.getElementById('mpCredsFields');
  var uidInput = document.getElementById('mpMerchantId');
  var keyInput = document.getElementById('mpApiKey');
  var toggleBtn = document.getElementById('mpToggleKey');
  var lastFocus = null;
  var requestSeq = 0; // দ্রুত খোলা-বন্ধ করলে পুরনো রেসপন্স নতুন মডালে না বসার জন্য

  function setBtnLabel(btn, text) {
    var span = btn.querySelector('span');
    if (span) span.textContent = text;
  }

  function resetView() {
    uidInput.value = '';
    keyInput.value = '';
    keyInput.type = 'password';
    setBtnLabel(toggleBtn, modal.getAttribute('data-show'));
    toggleBtn.querySelector('i').className = 'fas fa-eye';
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
    fieldsEl.classList.remove('hidden');
  }

  function openModal() {
    lastFocus = document.activeElement;
    resetView();
    modal.classList.remove('hidden');
    statusEl.textContent = modal.getAttribute('data-loading');
    statusEl.classList.remove('hidden');
    fieldsEl.classList.add('hidden');

    var seq = ++requestSeq;
    fetch('/merchant/credentials', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (res) {
        if (seq !== requestSeq) return; // এর মধ্যে মডাল বন্ধ/আবার খোলা হয়েছে
        statusEl.classList.add('hidden');
        if (!res.ok || !res.data || !res.data.success) {
          errorEl.textContent = (res.data && res.data.error) || '';
          errorEl.classList.remove('hidden');
          return;
        }
        uidInput.value = res.data.merchantId || '';
        keyInput.value = res.data.apiKey || '';
        fieldsEl.classList.remove('hidden');
        toggleBtn.focus();
      })
      .catch(function () {
        if (seq !== requestSeq) return;
        statusEl.classList.add('hidden');
        errorEl.textContent = modal.getAttribute('data-error') || '';
        errorEl.classList.remove('hidden');
      });
  }

  function closeModal() {
    requestSeq++;            // ভেসে থাকা রিকোয়েস্টের ফল বাতিল
    modal.classList.add('hidden');
    resetView();             // গোপন মান DOM থেকে মুছে ফেলা
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function copyFrom(inputId, btn) {
    var input = document.getElementById(inputId);
    if (!input || !input.value) return;
    var done = function () {
      var original = modal.getAttribute('data-copy');
      setBtnLabel(btn, modal.getAttribute('data-copied'));
      setTimeout(function () { setBtnLabel(btn, original); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, function () { fallbackCopy(input, done); });
    } else {
      fallbackCopy(input, done);
    }
  }

  // password টাইপ ইনপুট থেকে select() কপি কাজ করে, তবে পুরনো ব্রাউজারের জন্য fallback
  function fallbackCopy(input, done) {
    var prev = input.type;
    input.type = 'text';
    input.select();
    try { if (document.execCommand('copy')) done(); } catch (e) { /* ignore */ }
    input.type = prev;
    input.setSelectionRange(0, 0);
  }

  openers.forEach(function (b) { b.addEventListener('click', openModal); });
  closers.forEach(function (b) { b.addEventListener('click', closeModal); });

  // ব্যাকড্রপে ক্লিক (মডালের ভেতরে নয়) ও Esc
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  toggleBtn.addEventListener('click', function () {
    var showing = keyInput.type === 'text';
    keyInput.type = showing ? 'password' : 'text';
    setBtnLabel(toggleBtn, modal.getAttribute(showing ? 'data-show' : 'data-hide'));
    toggleBtn.querySelector('i').className = showing ? 'fas fa-eye' : 'fas fa-eye-slash';
  });

  modal.querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () { copyFrom(btn.getAttribute('data-copy-target'), btn); });
  });
})();
