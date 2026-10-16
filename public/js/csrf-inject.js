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
  var META = document.querySelector('meta[name="csrf-token"]');
  var CSRF_TOKEN = (META && META.getAttribute('content')) || '';
  if (!CSRF_TOKEN) return;

  // ===== টোকেন রিফ্রেশ =====
  // সেশন রোটেট হলে (লগইন), bfcache/back-forward থেকে পেজ ফিরলে, বা ট্যাব ঘণ্টার পর ঘণ্টা
  // খোলা থাকলে পেজে বসানো টোকেন পুরনো হয়ে যায় এবং পরের POST-এ 403 "Invalid or Expired CSRF
  // Token" আসে। তাই /csrf-token থেকে নতুন টোকেন এনে মেটা ট্যাগ ও সব ফর্ম-ফিল্ড আপডেট করা হয়।
  var origFetchRef = window.fetch;
  var refreshing = null;

  function applyToken(token) {
    if (!token || token === CSRF_TOKEN) return;
    CSRF_TOKEN = token;
    if (META) META.setAttribute('content', token);
    document.querySelectorAll('input[name="_csrf"]').forEach(function(i) { i.value = token; });
  }

  function refreshToken() {
    if (refreshing) return refreshing;
    refreshing = origFetchRef.call(window, '/csrf-token', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { if (d && d.token) applyToken(d.token); return !!(d && d.token); })
      .catch(function() { return false; })
      .then(function(ok) { refreshing = null; return ok; });
    return refreshing;
  }

  // bfcache থেকে ফিরলে (ব্যাক বাটন) এবং ট্যাবে ফিরে এলে টোকেন নবায়ন
  window.addEventListener('pageshow', function(e) { if (e.persisted) refreshToken(); });
  document.addEventListener('visibilitychange', function() { if (!document.hidden) refreshToken(); });
  // দীর্ঘক্ষণ খোলা পেজের জন্য ১০ মিনিটে একবার
  setInterval(refreshToken, 10 * 60 * 1000);

  // ফর্ম সাবমিটের ঠিক আগে টোকেন ফিল্ড সর্বশেষ মানে সিঙ্ক রাখা
  document.addEventListener('submit', function(e) {
    var f = e.target;
    if (!f || !f.querySelector) return;
    var inp = f.querySelector('input[name="_csrf"]');
    if (inp && inp.value !== CSRF_TOKEN) inp.value = CSRF_TOKEN;
  }, true);

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
    var mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && isSameOrigin(url);

    function send() {
      var opts = Object.assign({}, init);
      if (mutating) {
        opts.headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || {});
        if (!opts.headers.has('X-CSRF-Token') || opts._csrfRetry) opts.headers.set('X-CSRF-Token', CSRF_TOKEN);
      }
      return origFetch.call(window, input, opts);
    }

    if (!mutating) return send();

    return send().then(function(res) {
      // টোকেন মেয়াদোত্তীর্ণ হলে একবার নতুন টোকেন এনে স্বয়ংক্রিয়ভাবে পুনরায় চেষ্টা।
      // শুধু string/FormData/JSON বডিতে নিরাপদ (Request অবজেক্টের বডি একবারই পড়া যায়)।
      if (res.status !== 403 || typeof input !== 'string') return res;
      return res.clone().json().then(function(body) {
        if (!body || body.code !== 'CSRF_TOKEN_INVALID') return res;
        return refreshToken().then(function(ok) {
          if (!ok) return res;
          init = Object.assign({}, init, { _csrfRetry: true });
          return send();
        });
      }).catch(function() { return res; });
    });
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
