/* theme-contrast.js
   অনেক পেইজে inline style-এ হার্ডকোড করা হালকা টেক্সট কালার (#fff, rgba(255,255,255,..),
   #cbd5e1, #94a3b8 ...) আছে। Dark Mode-এ ঠিক দেখায়, কিন্তু Light Mode-এ সাদা ব্যাকগ্রাউন্ডের
   ওপর সাদা লেখা পড়ে যায় — অদৃশ্য/ফ্যাকাশে হয়ে যায়।

   এই স্ক্রিপ্ট রানটাইমে প্রতিটি এলিমেন্টের কার্যকর ব্যাকগ্রাউন্ড দেখে সিদ্ধান্ত নেয়:
     - ব্যাকগ্রাউন্ড হালকা + টেক্সট হালকা  -> টেক্সট গাঢ় করা হয় (var(--text-main))
     - ব্যাকগ্রাউন্ড গাঢ়/গ্রেডিয়েন্ট (সবুজ কার্ড, VIP ব্যানার ইত্যাদি) -> সাদাই থাকে
   Dark Mode-এ ফিরলে আসল inline কালার হুবহু ফিরিয়ে দেওয়া হয়। */
(function () {
  'use strict';

  var ORIG = '__livoOrigColor';
  var PATCHED = 'livo-contrast-patched';
  var DARK_TEXT = '#181B19';
  var MUTED_TEXT = '#646965';

  function parseColor(str) {
    if (!str) return null;
    var m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i);
    if (!m) return null;
    return {
      r: parseFloat(m[1]),
      g: parseFloat(m[2]),
      b: parseFloat(m[3]),
      a: m[4] === undefined ? 1 : parseFloat(m[4])
    };
  }

  function luminance(c) {
    // WCAG relative luminance
    var ch = [c.r, c.g, c.b].map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function blend(fg, bgLum) {
    // আংশিক স্বচ্ছ টেক্সট: ব্যাকগ্রাউন্ডের সাথে মিশিয়ে কার্যকর উজ্জ্বলতা
    var l = luminance(fg);
    return l * fg.a + bgLum * (1 - fg.a);
  }

  /* এলিমেন্টের পেছনে আসলে কী রঙ আছে — স্বচ্ছ ব্যাকগ্রাউন্ড ভেদ করে ওপরে ওঠে।
     কোনো ancestor-এ image/gradient থাকলে "অজানা" ধরে নিয়ে হাত দেওয়া হয় না। */
  function effectiveBackground(el) {
    var node = el;
    var lum = 1; // ডিফল্ট: Light Mode পেইজ ব্যাকগ্রাউন্ড সাদা
    while (node && node.nodeType === 1) {
      var cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // গ্রেডিয়েন্ট/ছবি
      var bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 0.85) return luminance(bg);
        // আধা-স্বচ্ছ লেয়ার: পেছনের রঙের সাথে মিশিয়ে দেখা হয়
        var parentLum = effectiveBackground(node.parentElement || document.body);
        if (parentLum === null) return null;
        return luminance(bg) * bg.a + parentLum * (1 - bg.a);
      }
      node = node.parentElement;
    }
    return lum;
  }

  function hasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    }
    return false;
  }

  function fixElement(el) {
    var inline = el.style && el.style.color;
    if (!inline) return;
    if (!hasOwnText(el) && !el.querySelector('i,svg')) return;

    var fg = parseColor(getComputedStyle(el).color);
    if (!fg) return;

    var bgLum = effectiveBackground(el.parentElement || document.body);
    if (bgLum === null) return;           // গ্রেডিয়েন্ট/ছবির ওপর — সাদাই থাক
    if (bgLum < 0.5) return;              // গাঢ় ব্যাকগ্রাউন্ড — সাদাই ঠিক আছে

    var fgLum = blend(fg, bgLum);
    var contrast = (Math.max(fgLum, bgLum) + 0.05) / (Math.min(fgLum, bgLum) + 0.05);
    if (contrast >= 4.5) return;          // কনট্রাস্ট ঠিক আছে

    if (el.dataset[ORIG] === undefined) el.dataset[ORIG] = inline;
    // আসল কালার হালকা-ধূসর হলে muted, নাহলে মূল টেক্সট কালার
    el.style.color = fg.a < 0.9 || fgLum > 0.75 ? MUTED_TEXT : DARK_TEXT;
    el.classList.add(PATCHED);
  }

  function restore() {
    document.querySelectorAll('.' + PATCHED).forEach(function (el) {
      if (el.dataset[ORIG] !== undefined) el.style.color = el.dataset[ORIG];
      el.classList.remove(PATCHED);
    });
  }

  function run() {
    if (!document.body.classList.contains('light-mode')) { restore(); return; }
    restore(); // আগের প্যাচ সরিয়ে নতুন করে হিসাব
    document.querySelectorAll('[style*="color"]').forEach(fixElement);
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; run(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }

  // থিম টগল (body-র class বদল) ধরার জন্য
  new MutationObserver(schedule).observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });

  // AJAX/ডাইনামিক কনটেন্ট আসার পর নতুন এলিমেন্টও ঠিক করা
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      if (muts[i].addedNodes.length) { schedule(); return; }
    }
  }).observe(document.body, { childList: true, subtree: true });

  window.LivoThemeContrast = { refresh: schedule };
})();
