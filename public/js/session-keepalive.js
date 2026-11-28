// স্থায়ী সেশনের silent keep-alive।
//
// লগইন করা ব্যবহারকারীর ব্রাউজার নিঃশব্দে POST /auth/refresh পাঠায়, যাতে ব্যাকএন্ড
//  (ক) সেশন কুকির rolling মেয়াদ বাড়ায়, এবং
//  (খ) HttpOnly রিফ্রেশ টোকেন মেয়াদ ফুরানোর আগেই রোটেট করে।
// টোকেন কখনো JavaScript-এ আসে না (HttpOnly) — এই স্ক্রিপ্ট শুধু "ping" দেয়।
//
// CSRF হেডার csrf-inject.js নিজেই fetch-এ বসায় (same-origin POST)।
// ট্যাব লুকানো থাকলে ping হয় না; ট্যাব ফিরলে শেষ ping অনেক আগের হলে সঙ্গে সঙ্গে হয়।
(function () {
  'use strict';
  if (!window.fetch) return;

  var INTERVAL_MS = 20 * 60 * 1000;      // সক্রিয় ট্যাবে প্রতি ২০ মিনিটে
  var MIN_GAP_MS = 5 * 60 * 1000;        // দুই ping-এর মধ্যে ন্যূনতম ব্যবধান
  var lastPing = 0;
  var inFlight = false;
  var stopped = false;
  var timer = null;

  function ping() {
    if (stopped || inFlight) return;
    if (Date.now() - lastPing < MIN_GAP_MS) return;
    inFlight = true;
    lastPing = Date.now();
    fetch('/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      cache: 'no-store'
    }).then(function (res) {
      // ৪০১ = সেশন নেই/বাতিল; ৪০৩ = CSRF টোকেন পুরনো। দুটোতেই থামি — পরের নেভিগেশনে সার্ভার
      // নিজেই (রিফ্রেশ কুকি থেকে) সেশন পুনরুদ্ধার করবে, ইউজারকে জোর করে কিছু করানো হয় না।
      if (res.status === 401) stopped = true;
    }).catch(function () {
      // নেটওয়ার্ক সমস্যা — নিঃশব্দে পরের বারে আবার চেষ্টা
      lastPing = 0;
    }).then(function () { inFlight = false; });
  }

  function start() {
    if (timer) return;
    timer = setInterval(function () { if (!document.hidden) ping(); }, INTERVAL_MS);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastPing >= INTERVAL_MS) ping();
  });
  window.addEventListener('online', function () { ping(); });

  start();
  // পেজ খোলার একটু পরে প্রথম ping (পুরনো সেশনে টোকেন না থাকলে এতে ইস্যু হয়ে যায়)
  setTimeout(ping, 5000);
})();
