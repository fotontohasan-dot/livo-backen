// CSRF টোকেন স্বয়ংক্রিয়ভাবে যুক্ত করা।
//
// এই কোডটা ১০টা টেমপ্লেটে কপি করা ছিল। কিন্তু কপিগুলো এক ছিল না:
// views/partials/head.ejs-এর সংস্করণে একটা same-origin যাচাই ছিল যা বাকি
// ন'টায় ছিল না। সেটাই এখানে রাখা হয়েছে — দুর্বল সংস্করণটা নয়।
//
// কেন যাচাইটা জরুরি: ওটা ছাড়া সব POST/PUT/PATCH/DELETE-এ হেডার বসে,
// অর্থাৎ পেইজের যেকোনো স্ক্রিপ্ট (তৃতীয় পক্ষের উইজেট, ব্রাউজার এক্সটেনশন,
// ভবিষ্যতের কোনো ইন্টিগ্রেশন) বাইরের সার্ভারে রিকোয়েস্ট করলে আমাদের বৈধ
// CSRF টোকেনও সেখানে চলে যেত।
//
// একটাই কপি রাখার আসল কারণ এটাই: ১০ কপির একটায় সুরক্ষা যোগ হলে বাকি ন'টা
// নীরবে পিছিয়ে থাকে, আর কোন পেজ কোন সংস্করণ পাচ্ছে তা কেউ জানে না।
//
// টোকেন <meta name="csrf-token"> থেকে পড়া হয়, তাই কোনো সার্ভার-সাইড
// ইন্টারপোলেশন লাগে না — ফাইলটা স্ট্যাটিকভাবে পরিবেশন করা যায়।
//
// docs/CSP.md, ধাপ ২।

(function() {
  var CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  if (!CSRF_TOKEN) return;

  function injectIntoForms() {
    document.querySelectorAll('form').forEach(function(form) {
      var method = (form.getAttribute('method') || 'get').toLowerCase();
      if (method !== 'post') return;
      if (form.querySelector('input[name="_csrf"]')) return;
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = '_csrf';
      input.value = CSRF_TOKEN;
      form.appendChild(input);
    });
  }
  document.addEventListener('DOMContentLoaded', injectIntoForms);
  // ডাইনামিকভাবে JS দিয়ে যোগ হওয়া ফর্মও কভার করার জন্য
  new MutationObserver(injectIntoForms).observe(document.documentElement, { childList: true, subtree: true });

  // fetch() প্যাচ — সেইম-অরিজিন state-changing রিকোয়েস্টে অটো হেডার যোগ করে
  var origFetch = window.fetch;
  /* CSRF টোকেন শুধু নিজেদের অরিজিনে যাবে।
     আগে অরিজিন যাচাই ছাড়াই সব POST/PUT/PATCH/DELETE-এ হেডার বসত — অর্থাৎ
     পেইজের কোনো স্ক্রিপ্ট (তৃতীয় পক্ষের উইজেট, ব্রাউজার এক্সটেনশন, ভবিষ্যতে
     যোগ হওয়া কোনো ইন্টিগ্রেশন) বাইরের সার্ভারে রিকোয়েস্ট করলে আমাদের বৈধ
     CSRF টোকেনও সেখানে চলে যেত। */
  function isSameOrigin(url) {
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
      return false; // পার্স করা না গেলে নিরাপদ দিক — টোকেন পাঠাব না
    }
  }

  window.fetch = function(input, init) {
    init = init || {};
    var method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && isSameOrigin(url)) {
      init.headers = new Headers(init.headers || {});
      if (!init.headers.has('X-CSRF-Token')) init.headers.set('X-CSRF-Token', CSRF_TOKEN);
    }
    return origFetch.call(this, input, init);
  };

  // XMLHttpRequest প্যাচ — legacy AJAX কভার করার জন্য
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._csrfMethod = (method || 'GET').toUpperCase();
    this._csrfSameOrigin = isSameOrigin(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(this._csrfMethod) && this._csrfSameOrigin) {
      try { this.setRequestHeader('X-CSRF-Token', CSRF_TOKEN); } catch (e) {}
    }
    return origSend.call(this, body);
  };
})();
