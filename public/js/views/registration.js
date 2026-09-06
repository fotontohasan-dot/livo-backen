// views/registration.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('registrationConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  (function () {
    var MSG = {
      usernameRequired: cfg.errUsernameRequired,
      usernameFormat: cfg.errUsernameFormat,
      atLeastOne: cfg.errAtLeastOne,
      emailInvalid: cfg.errEmailInvalid,
      phoneInvalid: cfg.errPhoneInvalid,
      passwordLength: cfg.errPasswordLength,
      passwordMismatch: cfg.errPasswordMismatch,
      creating: cfg.creatingAccount
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

    var form = document.getElementById('registerForm');
    var submitBtn = document.getElementById('registerSubmitBtn');
    var submitted = false;

    var username = document.getElementById('username');
    var email = document.getElementById('email');
    var phone = document.getElementById('phone');
    var password = document.getElementById('password');
    var confirmPassword = document.getElementById('confirmPassword');

    var usernameError = document.getElementById('usernameError');
    var emailError = document.getElementById('emailError');
    var phoneError = document.getElementById('phoneError');
    var passwordError = document.getElementById('passwordError');
    var confirmError = document.getElementById('confirmError');
    var confirmOk = document.getElementById('confirmOk');

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

    // ইউজার ঠিক করা শুরু করলেই সংশ্লিষ্ট এরর সরে যাবে
    [[username, usernameError], [email, emailError], [phone, phoneError], [password, passwordError]]
      .forEach(function (pair) {
        pair[0].addEventListener('input', function () { clearError(pair[0], pair[1]); });
      });

    // কনফার্ম পাসওয়ার্ড লাইভ ম্যাচ ইন্ডিকেটর
    function checkMatch() {
      clearError(confirmPassword, confirmError);
      confirmOk.classList.remove('is-visible');
      if (!confirmPassword.value) return;
      if (password.value === confirmPassword.value) {
        confirmOk.classList.add('is-visible');
      } else {
        showError(confirmPassword, confirmError, MSG.passwordMismatch);
      }
    }
    confirmPassword.addEventListener('input', checkMatch);
    password.addEventListener('input', function () { if (confirmPassword.value) checkMatch(); });

    form.addEventListener('submit', function (e) {
      // ডাবল সাবমিশন প্রতিরোধ
      if (submitted) { e.preventDefault(); return; }

      var valid = true;
      var emailVal = email.value.trim();
      var phoneVal = phone.value.trim();

      // ব্যাকএন্ডের নিয়মের সাথে হুবহু মিল রাখা হয়েছে (routes/auth.js):
      // username আবশ্যক ও ৩-২০ ক্যারেক্টার, email অথবা phone অন্তত একটি, password ≥ ৮
      if (!username.value.trim()) {
        showError(username, usernameError, MSG.usernameRequired); valid = false;
      } else if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username.value.trim())) {
        showError(username, usernameError, MSG.usernameFormat); valid = false;
      }

      if (!emailVal && !phoneVal) {
        showError(email, emailError, MSG.atLeastOne);
        showError(phone, phoneError, MSG.atLeastOne);
        valid = false;
      } else {
        if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
          showError(email, emailError, MSG.emailInvalid); valid = false;
        }
        if (phoneVal && !/^01\d{9}$/.test(phoneVal)) {
          showError(phone, phoneError, MSG.phoneInvalid); valid = false;
        }
      }

      if (password.value.length < 8) {
        showError(password, passwordError, MSG.passwordLength); valid = false;
      }
      if (password.value !== confirmPassword.value) {
        showError(confirmPassword, confirmError, MSG.passwordMismatch); valid = false;
      }

      if (!valid) {
        e.preventDefault();
        var firstBad = form.querySelector('.has-error');
        if (firstBad) firstBad.focus();
        return;
      }

      submitted = true;
      LivoToast.setLoading(submitBtn, true, MSG.creating);
    });
  })();
})();
