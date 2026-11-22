// views/profile/referral.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: আগে ইনলাইন ব্লক ছিল আর সার্ভার-সাইড মান সরাসরি
// JS স্ট্রিং-এর ভেতরে ইনজেক্ট হত। EJS-এর আউটপুট ট্যাগ HTML-এস্কেপ করে, যা
// JS কনটেক্সটের জন্য সঠিক নয়। এখন মানগুলো JSON ডেটা ব্লক থেকে আসে —
// JSON.parse বাদে আর কোনো ব্যাখ্যা লাগে না।

(function(){
  var cfg = {};
  var el = document.getElementById('profile-referralConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function toast(msg) { if (msg) alert(msg); }
  function copyCode() {
    const code = cfg.referralCode;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => toast(cfg.msgCodeCopied));
  }
  function copyLink() {
    if (!cfg.refLink) return;
    navigator.clipboard.writeText(cfg.refLink).then(() => toast(cfg.msgLinkCopied));
  }
  function shareLink() {
    const link = cfg.refLink;
    if (!link) return;
    if (navigator.share) {
      navigator.share({ title: cfg.shareTitle, text: cfg.shareText, url: link });
    } else {
      navigator.clipboard.writeText(link).then(() => toast(cfg.msgLinkCopied));
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var actions = { copy: copyCode, 'copy-link': copyLink, share: shareLink };
    document.querySelectorAll('[data-referral-action]').forEach(function (btn) {
      var fn = actions[btn.getAttribute('data-referral-action')];
      if (fn) btn.addEventListener('click', fn);
    });
  });
})();
