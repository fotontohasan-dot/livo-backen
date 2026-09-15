// public/js/badges-realtime.js
// -----------------------------------------------------------------------------
// মেম্বার সেন্টারের 'রিওয়ার্ড সেন্টার', 'মিশন', 'ইনটারনাল মেসেজ' আইকনের ব্যাজ এবং
// প্রোফাইল আইকনের মাস্টার ব্যাজ রিয়েল-টাইমে সিঙ্ক রাখে। services/socket.js-এর
// বিদ্যমান Socket.IO সংযোগ ব্যবহার করে (একই origin, session-authenticated)।
//
// DOM কনট্র্যাক্ট: যেকোনো এলিমেন্টে data-badge="reward" | "mission" | "message" | "master"
// বসালেই সেটা স্বয়ংক্রিয়ভাবে আনরিড সংখ্যা দেখাবে/লুকাবে। এলিমেন্ট নিজে খালি <span> হলেই
// চলবে — স্টাইলিং টেমপ্লেটের CSS-এ।
// -----------------------------------------------------------------------------
(function () {
  'use strict';

  function setBadge(el, count) {
    if (!el) return;
    var n = Number(count) || 0;
    if (n <= 0) {
      el.textContent = '';
      el.style.display = 'none';
      el.removeAttribute('data-count');
      return;
    }
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = '';
    el.setAttribute('data-count', String(n));
  }

  function applyCounts(counts) {
    if (!counts) return;
    var reward = counts.reward || 0;
    var mission = counts.mission || 0;
    var message = counts.message || 0;
    var total = typeof counts.total === 'number' ? counts.total : (reward + mission + message);

    var nodes = document.querySelectorAll('[data-badge="reward"]');
    for (var i = 0; i < nodes.length; i++) setBadge(nodes[i], reward);

    nodes = document.querySelectorAll('[data-badge="mission"]');
    for (i = 0; i < nodes.length; i++) setBadge(nodes[i], mission);

    nodes = document.querySelectorAll('[data-badge="message"]');
    for (i = 0; i < nodes.length; i++) setBadge(nodes[i], message);

    // ছোট ডট-স্টাইল ব্যাজ (সংখ্যাবিহীন) — নেভবারের মতো টাইট জায়গায় ব্যবহৃত
    nodes = document.querySelectorAll('[data-badge="message-dot"]');
    for (i = 0; i < nodes.length; i++) nodes[i].style.display = message > 0 ? '' : 'none';

    // প্রোফাইল আইকনের মাস্টার ব্যাজ — সংখ্যা না দেখিয়ে শুধু একটা ডট (bottom-nav/navbar-এর
    // বিদ্যমান .badge-dot / .pub-nav-dot প্যাটার্নের সাথে সামঞ্জস্যপূর্ণ), তাই আলাদা করে
    // data-badge="master-dot" হিসেবে টগল করা হয়।
    nodes = document.querySelectorAll('[data-badge="master"]');
    for (i = 0; i < nodes.length; i++) setBadge(nodes[i], total);

    nodes = document.querySelectorAll('[data-badge="master-dot"]');
    for (i = 0; i < nodes.length; i++) {
      nodes[i].style.display = total > 0 ? '' : 'none';
    }
  }

  function fetchBadges() {
    fetch('/notifications/badges', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data) applyCounts(data); })
      .catch(function () { /* নীরবে ব্যর্থ — পরের রিয়েল-টাইম ইভেন্টে ঠিক হয়ে যাবে */ });
  }

  function init() {
    fetchBadges();

    if (typeof window.io !== 'function') return; // socket.io ক্লায়েন্ট লোড না হলে শুধু প্রাথমিক fetch-এই থামে

    // অন্য স্ক্রিপ্ট (যেমন profile-chat.js) আগে থেকে io() কল করে থাকতে পারে; socket.io v4
    // একই origin/path-এর জন্য কানেকশন multiplex করে, তাই নতুন io() কল বাড়তি TCP কানেকশন তৈরি করে না।
    var socket = window.io();

    socket.on('connect', function () {
      socket.emit('join');
      fetchBadges(); // রি-কানেক্টের পর সংখ্যা মিস হয়ে থাকলে ঠিক করে নেয়
    });

    socket.on('badges:update', applyCounts);
    socket.on('badges:refresh', fetchBadges);
    // সাধারণ নোটিফিকেশন ইভেন্টেও (যেগুলো ব্রডকাস্ট নয়, ব্যক্তিগত) badges:update একই সাথে
    // পাঠানো হয় সার্ভার থেকে; তবু কোনো কারণে মিস হলে fallback হিসেবে রিফ্রেশ করা হয়।
    socket.on('notification', function () { fetchBadges(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
