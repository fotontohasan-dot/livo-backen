// অ্যাডমিন প্যানেলে TrxID ট্যাপ/ক্লিক করলেই সঙ্গে সঙ্গে কপি হয়ে যায়।
// ডকুমেন্ট-লেভেল ডেলিগেশন — টেবিল রো JS দিয়ে বারবার নতুন করে বানানো হলেও কাজ করে।
// নিরাপত্তা: শুধু এলিমেন্টের textContent কপি হয় (কখনো HTML নয়), কোনো ইনলাইন হ্যান্ডলার নেই।
(function () {
  'use strict';

  function notify(msg) {
    if (typeof window.showAdminToast === 'function' && document.getElementById('adminToast')) {
      window.showAdminToast(msg);
      return;
    }
    var t = document.createElement('div');
    t.className = 'trx-copy-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 1800);
  }

  // clipboard API শুধু HTTPS/secure context-এ চলে; না চললে পুরনো পদ্ধতি
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'trx-copy-ghost';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function onActivate(el) {
    var text = (el.getAttribute('data-copy') || el.textContent || '').trim();
    if (!text) return;
    copyText(text).then(function (ok) {
      if (ok) {
        el.classList.add('copied');
        setTimeout(function () { el.classList.remove('copied'); }, 1200);
        notify('✅ TrxID কপি হয়েছে: ' + text);
      } else {
        notify('কপি করা যায়নি — চেপে ধরে নিজে কপি করুন');
      }
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.trx-id') : null;
    if (el) onActivate(el);
  });
  // কীবোর্ড অ্যাক্সেসিবিলিটি
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target && e.target.closest ? e.target.closest('.trx-id') : null;
    if (el) { e.preventDefault(); onActivate(el); }
  });
})();
