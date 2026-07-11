// public/js/pwa.js
(function () {
  // ==== সার্ভিস ওয়ার্কার রেজিস্ট্রেশন ====
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/service-worker.js').catch(function (err) {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  // ==== ইনস্টল বাটন (Android/Chrome) ====
  let deferredPrompt = null;

  function showInstallButton() {
    if (document.getElementById('pwaInstallBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'pwaInstallBtn';
    btn.innerHTML = '📲 অ্যাপ ইনস্টল করুন';
    btn.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:9999',
      'background:#f59e0b', 'color:#111', 'border:none', 'padding:12px 18px',
      'border-radius:999px', 'font-weight:700', 'font-size:13px',
      'box-shadow:0 8px 24px rgba(0,0,0,0.35)', 'cursor:pointer',
      'font-family:Segoe UI, Hind Siliguri, sans-serif'
    ].join(';');
    btn.onclick = async function () {
      btn.style.display = 'none';
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    };
    document.body.appendChild(btn);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallButton();
  });

  window.addEventListener('appinstalled', function () {
    const btn = document.getElementById('pwaInstallBtn');
    if (btn) btn.remove();
    deferredPrompt = null;
  });

  // ==== iOS Safari-তে beforeinstallprompt সাপোর্ট নেই, তাই ম্যানুয়াল নির্দেশনা দেখানো হয় ====
  function isIos() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }
  function isInStandaloneMode() {
    return ('standalone' in window.navigator) && window.navigator.standalone;
  }
  if (isIos() && !isInStandaloneMode()) {
    if (!localStorage.getItem('livo_ios_install_hint_dismissed')) {
      const bar = document.createElement('div');
      bar.style.cssText = [
        'position:fixed', 'left:12px', 'right:12px', 'bottom:12px', 'z-index:9999',
        'background:#171b23', 'color:#fff', 'padding:12px 16px', 'border-radius:14px',
        'font-size:12px', 'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
        'font-family:Segoe UI, Hind Siliguri, sans-serif', 'display:flex',
        'align-items:center', 'gap:10px', 'border:1px solid rgba(245,158,11,0.4)'
      ].join(';');
      bar.innerHTML = '📲 অ্যাপ হিসেবে ইনস্টল করতে নিচের শেয়ার বাটনে ট্যাপ করে "Add to Home Screen" বেছে নিন।' +
        '<button style="margin-left:auto;background:none;border:none;color:#f59e0b;font-weight:700;font-size:16px;" onclick="this.parentElement.remove();localStorage.setItem(\'livo_ios_install_hint_dismissed\',\'1\')">✕</button>';
      document.body.appendChild(bar);
    }
  }
})();
