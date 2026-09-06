// views/profile.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: আগে ইনলাইন ব্লক ছিল আর সার্ভার-সাইড মান সরাসরি
// JS স্ট্রিং-এর ভেতরে ইনজেক্ট হত। EJS-এর আউটপুট ট্যাগ HTML-এস্কেপ করে, যা
// JS কনটেক্সটের জন্য সঠিক নয়। এখন মানগুলো JSON ডেটা ব্লক থেকে আসে —
// JSON.parse বাদে আর কোনো ব্যাখ্যা লাগে না।

(function(){
  var cfg = {};
  var el = document.getElementById('profileConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function copyRef() {
    navigator.clipboard.writeText(cfg.referralCode);
    alert('কোড কপি হয়েছে! ✅');
  }
  function shareRef() {
    if (navigator.share) {
      navigator.share({
        title: cfg.siteName + ' তে যোগ দিন!',
        text: 'আমার রেফারেল কোড দিয়ে রেজিস্ট্রেশন করুন: ' + cfg.referralCode + ' — ১০০ এক্সট্রা কয়েন পাবেন!',
        url: window.location.origin + '/register?ref=' + encodeURIComponent(cfg.referralCode)
      });
    }
  }


  document.addEventListener('DOMContentLoaded', function () {
    var actions = { copy: copyRef, share: shareRef };
    document.querySelectorAll('[data-ref-action]').forEach(function (btn) {
      var fn = actions[btn.getAttribute('data-ref-action')];
      if (fn) btn.addEventListener('click', fn);
    });
  });
})();
