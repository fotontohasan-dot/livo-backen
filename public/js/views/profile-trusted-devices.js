// views/profile/trusted-devices.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মানগুলো এখন JSON ডেটা ব্লক থেকে আসে,
// স্ক্রিপ্টের ভেতরে ইনজেক্ট হয় না।

(function(){
  var cfg = {};
  var el = document.getElementById('profile-trusted-devicesConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function renameDevicePrompt(id, currentName) {
      if (typeof window.prompt === 'function') {
        var newName = window.prompt(cfg.renamePrompt, currentName || '');
        if (newName && newName.trim()) {
          var form = document.getElementById('rename-form-' + id);
          form.querySelector('input[name="label"]').value = newName.trim();
          form.submit();
        }
        return;
      }
      var form = document.getElementById('rename-form-' + id);
      form.style.display = 'flex';
      form.querySelector('input[name="label"]').focus();
    }

    // ডিভাইসের নাম আগে ইনলাইন onclick-এর আর্গুমেন্ট হিসেবে যেত, তাই টেমপ্লেটে
    // হাতে করে কোট-এস্কেপ করতে হত (EJS-এর HTML এস্কেপিং-এর উপরে আরেক স্তর)।
    // নামটা ইউজারের দেওয়া, তাই এক স্তরে আনাই নিরাপদ (docs/CSP.md ধাপ ২)।
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('[data-rename-device]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          renameDevicePrompt(Number(btn.getAttribute('data-rename-device')),
                             btn.getAttribute('data-rename-name'));
        });
      });
    });
})();
