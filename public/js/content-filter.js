/**
 * public/js/content-filter.js
 * ---------------------------------------------------------------------------
 * রিয়েল-টাইম (টাইপ করার সময়) ফ্রন্টএন্ড কনটেন্ট ভ্যালিডেশন।
 * এটা শুধু UX-এর জন্য (ইউজারকে সাথে সাথে ওয়ার্নিং দেখানো) — আসল নিরাপত্তা
 * সবসময় ব্যাকএন্ডের utils/contentFilter.js + middleware/filterMiddleware.js
 * থেকেই আসে, কারণ ফ্রন্টএন্ড কোড যেকেউ DevTools দিয়ে বাইপাস করতে পারে।
 *
 * ব্যবহার:
 *   <script src="/js/content-filter.js"></script>
 *   <script>
 *     attachContentFilter('#message-input', { onBlockChange: (blocked) => { ... } });
 *   </script>
 *
 * অথবা HTML অ্যাট্রিবিউট দিয়ে অটো-অ্যাটাচ:
 *   <textarea data-content-filter></textarea>
 * ---------------------------------------------------------------------------
 */

(function (window) {
  'use strict';

  // ছোট, non-exhaustive ক্লায়েন্ট-সাইড লিস্ট (শুধু ইনস্ট্যান্ট ভিজুয়াল ওয়ার্নিং এর জন্য)
  var CLIENT_BAD_WORDS = [
    // বাংলা
    'মাদারচোদ', 'বাইনচোদ', 'বাল', 'খানকি', 'বেশ্যা', 'চুদ', 'গুদ', 'ল্যাওড়া',
    'শালা', 'শালী', 'শুয়ার', 'হারামজাদা', 'হারামি', 'মাগি', 'পোঁদ', 'ভোদা',
    // ইংরেজি
    'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'pussy', 'cunt',
    'whore', 'slut', 'porn', 'xxx', 'nude', 'sex video', 'onlyfans',
  ];

  var CLIENT_PATTERNS = [
    /\b18\s*\+/i,
    /\bxxx\b/i,
    /\bnsfw\b/i,
    /\bp[o0]rn\w*/i,
  ];

  function normalize(text) {
    return (text || '').toLowerCase().replace(/[\s._\-*]+/g, '');
  }

  function isBad(rawText) {
    if (!rawText || !rawText.trim()) return false;
    var lower = rawText.toLowerCase();
    var squashed = normalize(rawText);

    for (var i = 0; i < CLIENT_BAD_WORDS.length; i++) {
      var w = CLIENT_BAD_WORDS[i].toLowerCase();
      if (lower.indexOf(w) !== -1 || squashed.indexOf(normalize(w)) !== -1) return true;
    }
    for (var j = 0; j < CLIENT_PATTERNS.length; j++) {
      if (CLIENT_PATTERNS[j].test(lower)) return true;
    }
    return false;
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  /**
   * একটা ইনপুট/টেক্সটএরিয়া এলিমেন্টে রিয়েল-টাইম ফিল্টার লাগায়
   * @param {string|Element} selectorOrEl
   * @param {object} [options]
   * @param {number} [options.debounceMs=250]
   * @param {Function} [options.onBlockChange] - (isBlocked, el) => void
   * @param {Element}  [options.submitButton] - খারাপ কনটেন্ট থাকলে যেই বাটন ডিসেবল হবে
   * @param {Element}  [options.warningEl] - ওয়ার্নিং মেসেজ বসানোর জন্য এলিমেন্ট (না দিলে অটো তৈরি হবে)
   */
  function attachContentFilter(selectorOrEl, options) {
    options = options || {};
    var el = typeof selectorOrEl === 'string'
      ? document.querySelector(selectorOrEl)
      : selectorOrEl;
    if (!el) return null;

    var debounceMs = options.debounceMs || 250;
    var submitButton = options.submitButton || null;

    // ওয়ার্নিং মেসেজ এলিমেন্ট — না দেওয়া থাকলে ইনপুটের ঠিক পরে একটা <div> বসিয়ে দেওয়া হয়
    var warningEl = options.warningEl || null;
    if (!warningEl) {
      warningEl = document.createElement('div');
      warningEl.className = 'cf-warning';
      warningEl.style.cssText = 'display:none;color:#ff4d4f;font-size:12px;font-weight:600;margin-top:4px;';
      warningEl.textContent = '⚠️ অনুপযুক্ত/অশ্লীল কনটেন্ট শনাক্ত হয়েছে — অনুগ্রহ করে লেখাটি ঠিক করুন।';
      el.insertAdjacentElement('afterend', warningEl);
    }

    var originalBorder = el.style.border;
    var originalBoxShadow = el.style.boxShadow;

    function setBlocked(blocked) {
      if (blocked) {
        el.classList.add('cf-blocked');
        el.style.border = '1.5px solid #ff4d4f';
        el.style.boxShadow = '0 0 0 2px rgba(255,77,79,0.15)';
        warningEl.style.display = 'block';
        if (submitButton) submitButton.disabled = true;
      } else {
        el.classList.remove('cf-blocked');
        el.style.border = originalBorder;
        el.style.boxShadow = originalBoxShadow;
        warningEl.style.display = 'none';
        if (submitButton) submitButton.disabled = false;
      }
      if (typeof options.onBlockChange === 'function') options.onBlockChange(blocked, el);
    }

    var check = debounce(function () {
      var value = 'value' in el ? el.value : el.textContent;
      setBlocked(isBad(value));
    }, debounceMs);

    el.addEventListener('input', check);
    el.addEventListener('paste', function () { setTimeout(check, 0); });

    return {
      isBad: function () { return el.classList.contains('cf-blocked'); },
      recheck: check,
    };
  }

  // data-content-filter অ্যাট্রিবিউট থাকা সব এলিমেন্টে অটো-অ্যাটাচ
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-content-filter]').forEach(function (el) {
      attachContentFilter(el);
    });
  });

  window.attachContentFilter = attachContentFilter;
  window.contentFilterIsBad = isBad; // দরকার হলে সরাসরি টেক্সট চেক করার জন্য
})(window);
