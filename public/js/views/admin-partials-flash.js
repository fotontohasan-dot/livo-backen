// views/admin/partials/admin-layout.ejs-এর ফ্ল্যাশ টোস্ট।
// docs/CSP.md ধাপ ৩: বার্তাগুলো JSON ডেটা ব্লক থেকে আসে।
//
// টেমপ্লেটে Array.isArray() শর্তটা রাখা হয়েছে। কারণ কিছু অ্যাডমিন পেজ
// (backups, feature-flags, roles, sentry-status, notification-templates)
// render locals-এ `error` নামে একটা *স্ট্রিং* পাঠায় পেজের ভেতরে দেখানোর
// জন্য, যা ফ্ল্যাশ অ্যারেটাকে shadow করত। স্ট্রিং-এরও .length আছে, তাই
// শর্তটা true হয়ে forEach() চালাত → TypeError → পুরো পেজ 500।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-partials-flashConfig');
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
        document.addEventListener('DOMContentLoaded', function () {
          
          (cfg.success || []).forEach(function (msg) { window.LivoToast.show(msg, 'success'); });
          (cfg.error || []).forEach(function (msg) { window.LivoToast.show(msg, 'error'); });
        });
})();
