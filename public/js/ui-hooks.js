// সাইটজুড়ে সাধারণ UI hook — partials/head.ejs (ইউজার পেজ) ও
// partials/admin-layout.ejs (অ্যাডমিন পেজ) দুটো লেআউট থেকেই লোড হয়,
// তাই কার্যত সব পেজ এগুলো বিনামূল্যে পায়।
//
// CSP মাইগ্রেশনে (docs/CSP.md ধাপ ২) দেখা গেল একই চারটে প্যাটার্ন পেজে পেজে
// বারবার ফিরে আসছে: মডাল খোলা, মডাল বন্ধ, বদলালেই ফর্ম সাবমিট, আর ডিলিটের
// আগে নিশ্চিতকরণ। প্রতিটা পেজে আলাদা করে লেখা মানে CSRF ইনজেক্টরের মতোই
// ধীরে ধীরে সংস্করণগুলো আলাদা হয়ে যাওয়া। তাই একটাই বাস্তবায়ন।
//
// পেজ-নির্দিষ্ট স্ক্রিপ্টগুলো এই চারটে আর নিজে বাঁধবে না — বাঁধলে হ্যান্ডলার
// দুবার চলত (confirm দুবার দেখাত, ফর্ম দুবার সাবমিট হত)।

(function () {
  'use strict';

  function init() {
    document.querySelectorAll('[data-modal-open]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var el = document.getElementById(btn.getAttribute('data-modal-open'));
        if (!el) return;
        // কিছু মডাল `hidden` ক্লাসে লুকায়, কিছু `show` ক্লাসে দেখায় —
        // দুটো কনভেনশনই কোডবেসে আছে, তাই দুটোই সামলানো হয়।
        el.classList.remove('hidden');
        el.classList.add('show');
      });
    });

    document.querySelectorAll('[data-modal-close]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var el = document.getElementById(btn.getAttribute('data-modal-close'));
        if (!el) return;
        el.classList.add('hidden');
        el.classList.remove('show');
      });
    });

    // সাবমিটের সময় নির্দিষ্ট বাটনে লোডিং স্টেট। LivoToast না থাকলে চুপচাপ
    // এড়িয়ে যায় — আগে ইনলাইন সংস্করণে `LivoToast.setLoading(...)` সরাসরি
    // ডাকা হত, ফলে স্ক্রিপ্টটা লোড না হলে TypeError-এ সাবমিটই আটকে যেত।
    document.querySelectorAll('form[data-loading-target]').forEach(function (form) {
      form.addEventListener('submit', function () {
        var btn = document.getElementById(form.getAttribute('data-loading-target'));
        if (btn && window.LivoToast) {
          window.LivoToast.setLoading(btn, true, form.getAttribute('data-loading-label') || '');
        }
      });
    });

    // বাটনে সরাসরি লোডিং লেবেল (ফর্ম নয়, বাটন নিজেই)
    document.querySelectorAll('[data-loading-label]:not(form)').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (window.LivoToast) {
          window.LivoToast.setLoading(btn, true, btn.getAttribute('data-loading-label'));
        }
      });
    });

    document.querySelectorAll('[data-auto-submit]').forEach(function (el) {
      el.addEventListener('change', function () { if (el.form) el.form.submit(); });
    });

    // "বন্ধ করুন" ধরনের বাটন — আগে অ্যাট্রিবিউটে সরাসরি
    // `this.parentElement.remove()` লেখা ছিল।
    document.querySelectorAll('[data-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sel = btn.getAttribute('data-dismiss');
        // খালি মান = নিকটতম প্যারেন্ট; নইলে CSS selector দিয়ে খোঁজা হয়
        var target = sel ? btn.closest(sel) : btn.parentElement;
        if (target) target.remove();
      });
    });

    document.querySelectorAll('[data-reload]').forEach(function (btn) {
      btn.addEventListener('click', function () { location.reload(); });
    });

    // নেভিগেশন — আগে `location.href='...'` অ্যাট্রিবিউটে বসত।
    // শুধু সাইট-অভ্যন্তরীণ পাথ মানা হয়: `//evil.com` বা `javascript:` দিলে
    // কিছুই হয় না, তাই এই hook দিয়ে বাইরের সাইটে পাঠানো যায় না।
    document.querySelectorAll('[data-href]').forEach(function (el) {
      el.addEventListener('click', function () {
        var href = el.getAttribute('data-href') || '';
        if (href.charAt(0) !== '/' || href.charAt(1) === '/') return;
        location.href = href;
      });
    });

    // গেম পেজের বাজি-নির্বাচন বাটন। এগুলো ইনলাইন স্ক্রিপ্ট innerHTML দিয়ে
    // রানটাইমে বানায়, অর্থাৎ init() চলার সময় DOM-এ থাকেই না — তাই
    // querySelectorAll নয়, ডকুমেন্ট-লেভেল ডেলিগেশন।
    //
    // প্রতিটা গেম নিজের নির্বাচন-ফাংশনটা window.LivoGameSelect-এ রেজিস্টার
    // করে (আগে ফাংশনগুলো গ্লোবাল ছিল বলেই অ্যাট্রিবিউট থেকে ডাকা যেত)।
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      var el = e.target.closest('[data-game-select]');
      if (!el) return;
      if (typeof window.LivoGameSelect === 'function') {
        window.LivoGameSelect(el.getAttribute('data-game-select'), el);
      }
    });

    // ছবি লোড না হলে কী করতে হবে। আগে অ্যাট্রিবিউটে সরাসরি
    // `this.style.display='none'` জাতীয় কোড লেখা ছিল।
    // ডেলিগেশন কাজ করে না — error ইভেন্ট bubble করে না — তাই capture ধাপে।
    document.addEventListener('error', function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'IMG' || !el.hasAttribute('data-img-fallback')) return;
      var mode = el.getAttribute('data-img-fallback');
      if (mode === 'remove') el.remove();
      else if (mode === 'fade') el.style.opacity = '0.3';
      else el.style.display = 'none';
    }, true);

    // নিশ্চিতকরণ ডেলিগেশনে — অনেক অ্যাডমিন টেবিল সারি রানটাইমে বানায়,
    // তাই প্রতি-ফর্ম bind করলে নতুন সারির ফর্ম বাদ পড়ত।
    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || !form.matches || !form.matches('form[data-confirm]')) return;
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    }, true);

    // ফর্ম নয় — বাটন বা লিংকে সরাসরি নিশ্চিতকরণ। আগে এগুলোয়
    // `onclick="return confirm(...)"` ছিল, যেখানে false ফিরলে ডিফল্ট
    // অ্যাকশন (সাবমিট বা নেভিগেশন) থেমে যেত। preventDefault() সেটাই করে।
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      var el = e.target.closest('[data-confirm]');
      if (!el || el.tagName === 'FORM') return;
      if (!window.confirm(el.getAttribute('data-confirm'))) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
