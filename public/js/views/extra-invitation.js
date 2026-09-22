/*
  ⚠️ এটা সম্পূর্ণ ফাইল নয় — শুধু পরিবর্তিত/যোগ হওয়া অংশ (fragment)।
  আসল public/js/views/extra-invitation.js-এর সঠিক জায়গায় বসান।
*/

// ---- copyRef() ফাংশনের ঠিক পরে, DOMContentLoaded ব্লকের আগে যোগ করুন ----

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

// ---- DOMContentLoaded ব্লকের ভেতরে শেষে একটা কল যোগ করুন ----

// আগে ছিল:
/*
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-copy-ref]').forEach(function (el) {
      el.addEventListener('click', copyRef);
    });
  });
*/

// এখন হবে:
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-copy-ref]').forEach(function (el) {
    el.addEventListener('click', copyRef);
  });
  wireShareButtons();
});
