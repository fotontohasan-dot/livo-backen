// views/profile/index.ejs-এর আচরণ। আগে একটা ইনলাইন <script> ব্লক আর ৮টা
// ইনলাইন onclick হ্যান্ডলার ছিল।
//
// দুটো জিনিস বদলেছে:
//   ১. তিনটে সার্ভার-সাইড মান (UID, সাইটের নাম, locale) স্ক্রিপ্টের ভেতরে
//      ইনজেক্ট হত; এখন <script type="application/json"> ব্লক থেকে আসে।
//   ২. openAvatarPicker() প্রতিটা অ্যাভাটারে click প্রপার্টি সরাসরি বসাত।
//      DOM প্রপার্টি হওয়ায় CSP ওটা ব্লক করত না, কিন্তু addEventListener-এ
//      নেওয়া হয়েছে যাতে পুরো ফাইলে একটাই প্যাটার্ন থাকে।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  var config = {};

  function readConfig() {
    var el = document.getElementById('profileConfig');
    if (!el) return {};
    try { return JSON.parse(el.textContent) || {}; } catch (e) { return {}; }
  }

  function showToast(msg) {
    var el = document.getElementById('copyToast');
    el.textContent = msg;
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(20px)';
    }, 1800);
  }

  function copyUsername() {
    var name = document.getElementById('usernameText').textContent.trim();
    copyText(name);
  }

  function copyUid() {
    copyText(String(config.uid));
  }

  function copyProfileUrl() {
    var el = document.getElementById('profileUrlText');
    if (el) copyText(el.textContent.trim());
  }

  function shareProfileUrl() {
    var el = document.getElementById('profileUrlText');
    if (!el) return;
    var url = el.textContent.trim();
    if (navigator.share) {
      navigator.share({ title: config.siteName, url: url }).catch(function () {});
    } else {
      copyText(url);
    }
  }

  function copyText(val) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(function () { showToast('✅ কপি হয়েছে!'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = val;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('✅ কপি হয়েছে!');
    }
  }

  var AVATAR_OPTIONS = [
    'https://i.pravatar.cc/300?img=12',
    'https://i.pravatar.cc/300?img=33',
    'https://i.pravatar.cc/300?img=5',
    'https://i.pravatar.cc/300?img=47',
    'https://i.pravatar.cc/300?img=8',
    'https://i.pravatar.cc/300?img=25',
    'https://i.pravatar.cc/300?img=15',
    'https://i.pravatar.cc/300?img=44',
    'https://i.pravatar.cc/300?img=68',
    'https://i.pravatar.cc/300?img=32',
    'https://i.pravatar.cc/300?img=60',
    'https://i.pravatar.cc/300?img=51',
    'https://i.pravatar.cc/300?img=20',
    'https://i.pravatar.cc/300?img=49',
    'https://i.pravatar.cc/300?img=65',
    'https://i.pravatar.cc/300?img=57'
  ];

  function openAvatarPicker() {
    var grid = document.getElementById('avatarGrid');
    grid.innerHTML = '';
    AVATAR_OPTIONS.forEach(function (url) {
      var img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      img.style.cssText = 'width:100%; aspect-ratio:1/1; border-radius:14px; background:rgba(255,255,255,0.06); border:2px solid rgba(255,255,255,0.08); cursor:pointer; padding:6px;';
      img.addEventListener('click', function () { selectAvatar(url); });
      grid.appendChild(img);
    });
    document.getElementById('avatarModal').style.display = 'flex';
  }

  function closeAvatarPicker() {
    document.getElementById('avatarModal').style.display = 'none';
  }

  function selectAvatar(url) {
    fetch('/profile/update-avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: url })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success) {
          var circle = document.getElementById('avatarCircle');
          circle.style.backgroundImage = "url('" + url + "')";
          circle.textContent = '';
          closeAvatarPicker();
          showToast('✅ প্রোফাইল ছবি পরিবর্তন হয়েছে!');
        } else {
          showToast('❌ আপডেট ব্যর্থ হয়েছে');
        }
      })
      .catch(function () { showToast('❌ সমস্যা হয়েছে'); });
  }

  function refreshBalance() {
    var icon = document.getElementById('refreshIcon');
    icon.classList.add('spinning');
    fetch('/profile/api/balance')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success) {
          document.getElementById('balanceText').textContent = '৳ ' + Number(data.coins).toLocaleString(config.locale);
          var lu = document.getElementById('lastUpdatedText');
          if (lu) lu.textContent = 'এখনই';
          showToast('✅ ব্যালেন্স আপডেট হয়েছে');
        } else {
          showToast('❌ আপডেট ব্যর্থ হয়েছে');
        }
      })
      .catch(function () { showToast('❌ সমস্যা হয়েছে'); })
      .finally(function () {
        setTimeout(function () { icon.classList.remove('spinning'); }, 400);
      });
  }

  function init() {
    config = readConfig();

    var actions = {
      'avatar-open': openAvatarPicker,
      'avatar-close': closeAvatarPicker,
      'copy-username': copyUsername,
      'copy-uid': copyUid,
      'copy-profile-url': copyProfileUrl,
      'share-profile-url': shareProfileUrl,
      'refresh-balance': refreshBalance
    };

    document.querySelectorAll('[data-profile-action]').forEach(function (el) {
      var fn = actions[el.getAttribute('data-profile-action')];
      if (fn) el.addEventListener('click', fn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
