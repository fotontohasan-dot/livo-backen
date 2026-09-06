// views/profile/referral.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: আগে ইনলাইন ব্লক ছিল আর সার্ভার-সাইড মান সরাসরি
// JS স্ট্রিং-এর ভেতরে ইনজেক্ট হত। EJS-এর আউটপুট ট্যাগ HTML-এস্কেপ করে, যা
// JS কনটেক্সটের জন্য সঠিক নয়। এখন মানগুলো JSON ডেটা ব্লক থেকে আসে —
// JSON.parse বাদে আর কোনো ব্যাখ্যা লাগে না।

(function(){
  var cfg = {};
  var el = document.getElementById('profile-referralConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function copyCode() {
    const code = cfg.referralCode;
    navigator.clipboard.writeText(code).then(() => alert('কোড কপি হয়েছে!'));
  }
  function shareLink() {
    const link = cfg.baseUrl + '/register?ref=' + encodeURIComponent(cfg.referralCode);
    if (navigator.share) {
      navigator.share({ title: 'LIVO ত যোগ দিন', text: 'আমার রেফারেল লিংক দিয়ে রেজিস্টার করুন!', url: link });
    } else {
      navigator.clipboard.writeText(link).then(() => alert('লিংক কপি হয়েছে!'));
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var actions = { copy: copyCode, share: shareLink };
    document.querySelectorAll('[data-referral-action]').forEach(function (btn) {
      var fn = actions[btn.getAttribute('data-referral-action')];
      if (fn) btn.addEventListener('click', fn);
    });
  });
})();
