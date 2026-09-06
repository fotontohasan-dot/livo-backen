// views/profile/vip.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

(function () {
  var box = document.getElementById('vipProgressBox');
  if (!box) return;

  var fill      = document.getElementById('vipProgressFill');
  var floatTag  = document.getElementById('vipProgressFloat');
  var numText   = document.getElementById('vipProgressNum');
  var turnText  = document.getElementById('vipTurnoverText');
  var toNextEl  = document.getElementById('vipToNextText');
  var deltaPop  = document.getElementById('vipDeltaPop');

  var current = 0; // বর্তমানে স্ক্রিনে দেখানো প্রোগ্রেস (0-1000)

  function setBar(progress) {
    progress = Math.max(0, Math.min(1000, Number(progress) || 0));
    var pct = progress / 10; // 0-1000 -> 0-100%
    fill.style.width = pct + '%';
    floatTag.style.left = pct + '%';
    floatTag.textContent = Math.round(progress) + ' / 1000';
    numText.textContent = Math.round(progress);
  }

  // পেজ লোড হওয়ার সাথে সাথে ০ থেকে অ্যানিমেট করে বর্তমান মান পর্যন্ত ভরাট করা
  var target = Number(box.dataset.progress) || 0;
  requestAnimationFrame(function () {
    setBar(0);
    requestAnimationFrame(function () {
      setBar(target);
      current = target;
    });
  });

  function showDelta(amount) {
    if (amount <= 0) return;
    deltaPop.textContent = '+' + amount;
    deltaPop.style.opacity = '1';
    deltaPop.style.transform = 'translateY(-6px)';
    setTimeout(function () {
      deltaPop.style.opacity = '0';
      deltaPop.style.transform = 'translateY(0)';
    }, 1400);
  }

  function refreshVipProgress() {
    fetch('/profile/api/vip-progress')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.success) return;

        if (data.progress > current) {
          showDelta(Math.round(data.progress - current));
        }
        setBar(data.progress);
        current = data.progress;

        if (turnText) {
          turnText.textContent = Number(data.totalTurnover).toLocaleString('bn-BD');
        }
        if (data.isMax) {
          if (toNextEl && toNextEl.parentElement) toNextEl.parentElement.style.display = 'none';
        } else if (toNextEl) {
          toNextEl.textContent = Number(data.toNext).toLocaleString('bn-BD');
        }
      })
      .catch(function () { /* নীরবে ব্যর্থ — পরের পোলে আবার চেষ্টা হবে */ });
  }

  // পেজ খোলা থাকা অবস্থায় প্রতি ১০ সেকেন্ডে লাইভ আপডেট চেক করা হবে
  var pollTimer = setInterval(function () {
    if (document.visibilityState === 'visible') refreshVipProgress();
  }, 10000);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshVipProgress();
  });

  window.addEventListener('beforeunload', function () { clearInterval(pollTimer); });
})();
