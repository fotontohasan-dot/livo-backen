// public/pwa.js
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
  var HINT_KEY = 'bet420_ios_install_hint_dismissed';
  var HINT_AUTO_DISMISS_MS = 8000;

  function isIos() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }
  function isInStandaloneMode() {
    return ('standalone' in window.navigator) && window.navigator.standalone;
  }

  // Safari প্রাইভেট মোডে localStorage এরর দিতে পারে; এরর হলে যেন বাকি স্ক্রিপ্ট না থামে
  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* উপেক্ষা */ }
  }

  function showIosHint() {
    if (document.getElementById('iosInstallHint')) return;

    var bar = document.createElement('div');
    bar.id = 'iosInstallHint';
    bar.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'bottom:12px', 'z-index:9999',
      'background:#171b23', 'color:#fff', 'padding:12px 16px', 'border-radius:14px',
      'font-size:12px', 'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
      'font-family:Segoe UI, Hind Siliguri, sans-serif', 'display:flex',
      'align-items:center', 'gap:10px', 'border:1px solid rgba(245,158,11,0.4)'
    ].join(';');

    var text = document.createElement('span');
    text.textContent = '\uD83D\uDCF2 অ্যাপ হিসেবে ইনস্টল করতে নিচের শেয়ার বাটনে ট্যাপ করে "Add to Home Screen" বেছে নিন।';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'বন্ধ করুন');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = 'margin-left:auto;background:none;border:none;color:#f59e0b;font-weight:700;font-size:16px;cursor:pointer;';

    bar.appendChild(text);
    bar.appendChild(closeBtn);
    document.body.appendChild(bar);

    // ইনলাইন onclick ব্যবহার করা যাবে না: CSP-তে scriptSrcAttr 'none' থাকায়
    // ব্রাউজার ওটা ব্লক করে। তাই addEventListener।
    var autoDismissTimer = setTimeout(function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }, HINT_AUTO_DISMISS_MS);

    closeBtn.addEventListener('click', function () {
      clearTimeout(autoDismissTimer);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      safeSet(HINT_KEY, '1');
    });
  }

  if (isIos() && !isInStandaloneMode() && !safeGet(HINT_KEY)) {
    if (document.body) {
      showIosHint();
    } else {
      document.addEventListener('DOMContentLoaded', showIosHint);
    }
  }
})();
