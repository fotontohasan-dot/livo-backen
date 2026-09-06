// views/partials/head.ejs-এর ক্লায়েন্ট কোড (দুটো ইনলাইন ব্লক একত্রে)।
// docs/CSP.md ধাপ ৩।
//
// ক্রম গুরুত্বপূর্ণ: থিম কোডটা আগে চলে, কারণ ওটা body-তে class বসায়।
// টোস্ট সিস্টেম ও ফ্ল্যাশ বার্তা তার পরে।

/* থিম প্রথম পেইন্টের আগেই বসিয়ে দেয় — Light Mode ইউজার যেন রিফ্রেশে এক মুহূর্তের
     জন্যও Dark Mode ফ্ল্যাশ না দেখে। navbar.ejs-এর টগল স্ক্রিপ্টের সাথে একই
     localStorage key ('livo-theme') ও class ('light-mode') ব্যবহার করে। */
  (function () {
    try {
      if (localStorage.getItem('livo-theme') === 'light') {
        document.body.classList.add('light-mode');
      }
    } catch (e) {}
  })();

(function(){
  var cfg = {};
  var el = document.getElementById('partials-headConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  window.LivoToast = (function () {
      function ensureRoot() { return document.getElementById('livo-toast-root'); }
      function show(message, type, duration) {
        type = type || 'info'; duration = duration || 4000;
        const root = ensureRoot();
        if (!root || !message) return;
        const el = document.createElement('div');
        el.className = 'livo-toast ' + type;
        const icon = type === 'success' ? 'fa-circle-check' : (type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info');
        el.innerHTML = '<i class="fas ' + icon + '"></i><span></span>';
        el.querySelector('span').textContent = message;
        const dismiss = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); };
        el.addEventListener('click', dismiss);
        root.appendChild(el);
        setTimeout(dismiss, duration);
      }
      function setLoading(btn, loading, loadingText) {
        if (!btn) return;
        if (loading) {
          if (!btn.dataset.livoOriginalHtml) btn.dataset.livoOriginalHtml = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = '<span class="livo-spinner"></span>' + (loadingText || 'অপেক্ষা করুন...');
        } else {
          btn.disabled = false;
          if (btn.dataset.livoOriginalHtml) btn.innerHTML = btn.dataset.livoOriginalHtml;
        }
      }
      return { show: show, setLoading: setLoading };
    })();

    // ফ্ল্যাশ বার্তাগুলো আগে EJS লুপ দিয়ে একেকটা LivoToast.show(...) কল
    // হিসেবে স্ক্রিপ্টে লেখা হত — অর্থাৎ সার্ভার ডেটা থেকে কোড তৈরি হত।
    // এখন বার্তাগুলো JSON ডেটা হিসেবে আসে আর ক্লায়েন্ট লুপ চালায়।
    document.addEventListener('DOMContentLoaded', function () {
      (cfg.success || []).forEach(function (msg) { window.LivoToast.show(msg, 'success'); });
      (cfg.error || []).forEach(function (msg) { window.LivoToast.show(msg, 'error'); });
    });
})();
