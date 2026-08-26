/**
 * public/js/age-gate.js
 * ---------------------------------------------------------------------------
 * ১৮+ **সেল্ফ-ডিক্লারেশন ওভারলে** — বয়স যাচাই নয়।
 *
 * ⚠️ এটি আইনগত অর্থে age verification নয়, এবং সেভাবে উপস্থাপন করা যাবে না।
 *
 * যা আসলে হয়: ইউজার "হ্যাঁ" চাপলে ব্রাউজারে একটা কুকি
 * (`livo_age_verified=1`) বসে। কুকিটা সম্পূর্ণ ক্লায়েন্ট-সাইড — যে কেউ
 * DevTools খুলে নিজেই বসিয়ে নিতে পারে, বা সরাসরি কোনো URL-এ গিয়ে ওভারলে
 * এড়াতে পারে। সার্ভার এই কুকির উপর কোনো সিদ্ধান্ত নেয় না, কোথাও সংরক্ষণও
 * করে না।
 *
 * অর্থাৎ এটি একটি UI গেট: উদ্দেশ্য জানানো ও নথিভুক্ত করা যে সাইটটি ১৮+,
 * নাবালকদের ঠেকানো নয়।
 *
 * প্রকৃত বয়স যাচাই দরকার হলে (নিয়ন্ত্রক চাহিদা অনুযায়ী) সেটা সার্ভার-সাইডে
 * করতে হবে — KYC ডকুমেন্টের জন্মতারিখ থেকে, যাচাইকৃত অবস্থা ডাটাবেসে রেখে,
 * এবং নিয়ন্ত্রিত রুটগুলো সেই অবস্থার ভিত্তিতে আটকে। বর্তমান কোডবেসে সেটা
 * নেই।
 *
 * views/partials/head.ejs-এ <script defer> হিসেবে যুক্ত।
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var COOKIE_NAME = 'livo_age_verified';
  var COOKIE_DAYS = 365;

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/; SameSite=Lax';
  }

  function showGate() {
    var overlay = document.createElement('div');
    overlay.id = 'age-gate-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:999999;background:rgba(5,8,14,0.96);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;' +
      'font-family:"Hind Siliguri",sans-serif;';

    overlay.innerHTML =
      '<div style="max-width:380px;width:100%;background:#121212;border:1px solid rgba(234,179,8,0.35);' +
      'border-radius:18px;padding:28px 22px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.5);">' +
        '<div style="font-size:40px;margin-bottom:10px;">🔞</div>' +
        '<div style="color:#EAB308;font-size:19px;font-weight:800;margin-bottom:10px;">বয়স নিশ্চিতকরণ</div>' +
        '<div style="color:#cbd5e1;font-size:13.5px;line-height:1.6;margin-bottom:20px;">' +
          'এই ওয়েবসাইটে রিয়েল-মানি গেমিং কনটেন্ট রয়েছে। প্রবেশ করতে হলে আপনার বয়স অবশ্যই ' +
          '<b style="color:#fff;">১৮ বছর বা তার বেশি</b> হতে হবে।' +
        '</div>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="age-gate-no" style="flex:1;padding:12px 0;border-radius:10px;border:1px solid rgba(255,255,255,0.15);' +
          'background:transparent;color:#94a3b8;font-weight:700;font-size:14px;cursor:pointer;">না, বের হচ্ছি</button>' +
          '<button id="age-gate-yes" style="flex:1;padding:12px 0;border-radius:10px;border:none;' +
          'background:linear-gradient(135deg,#EAB308,#FCD34D);color:#000;font-weight:800;font-size:14px;cursor:pointer;">' +
          'হ্যাঁ, আমি ১৮+</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('age-gate-yes').addEventListener('click', function () {
      setCookie(COOKIE_NAME, '1', COOKIE_DAYS);
      overlay.remove();
    });

    document.getElementById('age-gate-no').addEventListener('click', function () {
      window.location.href = 'https://www.google.com';
    });
  }

  function init() {
    if (getCookie(COOKIE_NAME) === '1') return;
    if (document.body) {
      showGate();
    } else {
      document.addEventListener('DOMContentLoaded', showGate);
    }
  }

  init();
})();
