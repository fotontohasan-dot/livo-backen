// views/login.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('loginConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  (function () {
    var MSG = {
      identifierRequired: cfg.errIdentifier,
      passwordRequired: cfg.errPassword,
      signingIn: cfg.signingIn
    };

    // ==================== পাসওয়ার্ড Show/Hide ====================
    document.querySelectorAll('[data-toggle-password]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById(btn.getAttribute('data-toggle-password'));
        if (!input) return;
        var willShow = input.type === 'password';
        input.type = willShow ? 'text' : 'password';
        btn.setAttribute('aria-label', willShow ? btn.dataset.labelHide : btn.dataset.labelShow);
        btn.querySelector('span').textContent = willShow ? '🙈' : '👁️';
      });
    });

    // ==================== ফিল্ড-লেভেল ভ্যালিডেশন (ফ্রন্টএন্ড; ব্যাকএন্ড ভ্যালিডেশন অপরিবর্তিত) ====
    var form = document.getElementById('loginForm');
    var submitBtn = document.getElementById('loginSubmitBtn');
    var submitted = false;

    function showError(input, errEl, message) {
      input.classList.add('has-error');
      input.setAttribute('aria-invalid', 'true');
      errEl.textContent = '⚠ ' + message;
      errEl.classList.add('is-visible');
    }
    function clearError(input, errEl) {
      input.classList.remove('has-error');
      input.removeAttribute('aria-invalid');
      errEl.textContent = '';
      errEl.classList.remove('is-visible');
    }

    var identifier = document.getElementById('identifier');
    var identifierError = document.getElementById('identifierError');
    var password = document.getElementById('password');
    var passwordError = document.getElementById('passwordError');

    // ইউজার ঠিক করা শুরু করলেই এরর সরে যাবে
    identifier.addEventListener('input', function () { clearError(identifier, identifierError); });
    password.addEventListener('input', function () { clearError(password, passwordError); });

    form.addEventListener('submit', function (e) {
      // ডাবল সাবমিশন প্রতিরোধ
      if (submitted) { e.preventDefault(); return; }

      var valid = true;
      if (!identifier.value.trim()) { showError(identifier, identifierError, MSG.identifierRequired); valid = false; }
      if (!password.value) { showError(password, passwordError, MSG.passwordRequired); valid = false; }

      if (!valid) {
        e.preventDefault();
        var firstBad = form.querySelector('.has-error');
        if (firstBad) firstBad.focus();
        return;
      }

      submitted = true;
      LivoToast.setLoading(submitBtn, true, MSG.signingIn);
    });
  })();
})();
