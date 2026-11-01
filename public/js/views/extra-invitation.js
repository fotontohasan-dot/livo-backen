// views/extra/invitation.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: আগে ইনলাইন ব্লক ছিল আর সার্ভার-সাইড মান সরাসরি
// JS স্ট্রিং-এর ভেতরে ইনজেক্ট হত। EJS-এর আউটপুট ট্যাগ HTML-এস্কেপ করে, যা
// JS কনটেক্সটের জন্য সঠিক নয়। এখন মানগুলো JSON ডেটা ব্লক থেকে আসে —
// JSON.parse বাদে আর কোনো ব্যাখ্যা লাগে না।

(function(){
  var cfg = {};
  var el = document.getElementById('extra-invitationConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function copyRef() {
      navigator.clipboard.writeText(cfg.referralCode);
      alert(cfg.copied);
  }

  // প্রতিটা প্ল্যাটফর্মের শেয়ার URL বানানো। লিংক ও টেক্সট এখানেই এনকোড করা
  // হয় (jsonScriptSafe দিয়ে সার্ভার থেকে raw মান আসে) — ইনলাইন href নয়,
  // তাই CSP-তে সমস্যা হয় না।
  function wireShareButtons() {
    var link = cfg.referralLink || '';
    if (!link) return;
    var message = 'BET420-তে যোগ দিন এবং বোনাস নিন! আমার রেফারেল কোড: ' + (cfg.referralCode || '');
    var combined = encodeURIComponent(message + ' ' + link);
    var encLink = encodeURIComponent(link);

    var map = {
      whatsapp:  'https://wa.me/?text=' + combined,
      facebook:  'https://www.facebook.com/sharer/sharer.php?u=' + encLink,
      messenger: 'fb-messenger://share/?link=' + encLink,
      viber:     'viber://forward?text=' + combined,
      imo:       'imo://send?text=' + combined
    };

    document.querySelectorAll('[data-share]').forEach(function (el) {
      var key = el.getAttribute('data-share');
      if (key === 'instagram') {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          navigator.clipboard.writeText(message + ' ' + link).catch(function () {});
          alert(cfg.copied || 'কপি হয়েছে');
          window.location.href = 'instagram://app';
        });
        return;
      }
      if (map[key]) el.href = map[key];
    });
  }

  // আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-copy-ref]').forEach(function (el) {
      el.addEventListener('click', copyRef);
    });
    wireShareButtons();
  });
})();
