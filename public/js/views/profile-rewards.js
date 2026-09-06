// views/profile/rewards.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

(function () {
  // ==================== টার্নওভার প্রোগ্রেস বার — ১ থেকে টার্গেট পর্যন্ত অ্যানিমেট ====================
  const fill = document.getElementById('turnoverProgressFill');
  const pctLabel = document.getElementById('turnoverProgressPct');
  if (fill && pctLabel) {
    const target = Math.max(1, parseInt(fill.getAttribute('data-target'), 10) || 1);
    requestAnimationFrame(function () { fill.style.width = target + '%'; });
    let cur = 1;
    const step = setInterval(function () {
      cur++;
      if (cur >= target) { cur = target; clearInterval(step); }
      pctLabel.textContent = cur;
    }, Math.max(8, Math.floor(600 / target)));
  }

  // ==================== সোনার ডিম + রেড কার্ড — লাইভ স্ট্যাটাস ====================
  const eggStatusEl = document.getElementById('goldenEggStatus');
  const eggBtn = document.getElementById('goldenEggBtn');
  const eggGrid = document.getElementById('goldenEggGrid');
  const eggResult = document.getElementById('goldenEggResult');
  const redStatusEl = document.getElementById('redCardStatus');
  const redBtn = document.getElementById('redCardBtn');

  function applyStatus(status) {
    if (!status) return;
    if (status.goldenEgg.claimed) {
      eggStatusEl.textContent = 'আজকেরটা নেওয়া হয়ে গেছে ✅';
      eggBtn.disabled = true; eggBtn.textContent = 'নেওয়া হয়েছে';
    } else if (status.goldenEgg.locked) {
      eggStatusEl.textContent = '🔒 আজ ডিপোজিট করুন, তারপর ভাঙতে পারবেন';
      eggBtn.disabled = true; eggBtn.textContent = 'লক';
    } else {
      eggStatusEl.textContent = 'ডিমে টোকা দিয়ে কয়েন জিতুন';
      eggBtn.disabled = false; eggBtn.textContent = 'ডিম ভাঙুন';
    }

    if (status.redPacket.claimed) {
      redStatusEl.textContent = 'আজকেরটা নেওয়া হয়ে গেছে ✅';
      redBtn.disabled = true; redBtn.textContent = 'নেওয়া হয়েছে';
    } else if (status.redPacket.locked) {
      redStatusEl.textContent = '🔒 আজ ডিপোজিট করুন, তারপর খুলতে পারবেন';
      redBtn.disabled = true; redBtn.textContent = 'লক';
    } else {
      redStatusEl.textContent = 'দৈনিক লাল প্যাকেট খুলুন';
      redBtn.disabled = false; redBtn.textContent = 'খুলুন';
    }
  }

  fetch('/profile/daily-rewards/status')
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.ok) applyStatus(d.status); })
    .catch(function () {
      eggStatusEl.textContent = 'লোড করা যায়নি';
      redStatusEl.textContent = 'লোড করা যায়নি';
    });

  // ডিম ভাঙা — ৮টি ডিমের গ্রিড দেখিয়ে একটা বাছাই করতে বলা
  eggBtn.addEventListener('click', function () {
    if (eggGrid.style.display === 'grid') return;
    eggGrid.style.display = 'grid';
    eggGrid.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '🥚';
      b.style.cssText = 'font-size:22px;background:rgba(255,255,255,0.25);border:none;border-radius:10px;padding:10px 0;cursor:pointer;';
      b.addEventListener('click', function () {
        Array.from(eggGrid.children).forEach(function (c) { c.disabled = true; });
        fetch('/profile/daily-rewards/golden-egg/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pickedIndex: i })
        })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            eggResult.style.display = 'block';
            if (res.ok) {
              eggResult.textContent = '🎉 আপনি ' + res.amount + ' কয়েন জিতেছেন!';
              eggBtn.disabled = true; eggBtn.textContent = 'নেওয়া হয়েছে';
              eggStatusEl.textContent = 'আজকেরটা নেওয়া হয়ে গেছে ✅';
            } else {
              eggResult.textContent = res.message || 'সমস্যা হয়েছে।';
            }
            eggGrid.style.display = 'none';
          })
          .catch(function () {
            eggResult.style.display = 'block';
            eggResult.textContent = 'সার্ভার ত্রুটি।';
            eggGrid.style.display = 'none';
          });
      });
      eggGrid.appendChild(b);
    }
  });

  // রেড কার্ড খোলা
  redBtn.addEventListener('click', function () {
    redBtn.disabled = true;
    fetch('/profile/daily-rewards/red-packet/claim', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) {
          redStatusEl.textContent = '🎉 আপনি ' + res.amount + ' কয়েন জিতেছেন!';
          redBtn.textContent = 'নেওয়া হয়েছে';
        } else {
          redStatusEl.textContent = res.message || 'সমস্যা হয়েছে।';
          redBtn.disabled = false;
        }
      })
      .catch(function () {
        redStatusEl.textContent = 'সার্ভার ত্রুটি।';
        redBtn.disabled = false;
      });
  });
})();
