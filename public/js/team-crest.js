/* ==========================================================================
   Livo — Team Crest Renderer
   দলের নাম থেকে একটি generic ব্যাজ (initials + স্থিতিশীল রঙ) আঁকে।
   কোনো আসল ক্লাব/লিগ লোগো ব্যবহার বা অনুকরণ করা হয় না — ট্রেডমার্ক-নিরাপদ।

   ব্যবহার (markup):
     <span class="team-crest" data-team="Man City"></span>
     <span class="team-crest" data-team="Barcelona" data-size="28"></span>

   ডাইনামিকভাবে যোগ হওয়া এলিমেন্টও স্বয়ংক্রিয়ভাবে রেন্ডার হয়।
   ========================================================================== */
(function () {
  'use strict';

  var PALETTE = [
    ['#006A4E', '#008F5A'], ['#D62828', '#8F1616'], ['#1F6FB2', '#124668'],
    ['#D4A72C', '#8A6A12'], ['#5B2E8F', '#341A54'], ['#0F766E', '#0A4B45'],
    ['#B45309', '#7C3A06'], ['#334155', '#1E293B']
  ];

  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function initials(name) {
    var parts = String(name).trim().split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function crestSVG(name, size) {
    var pair = PALETTE[hash(name) % PALETTE.length];
    var txt = initials(name);
    var uid = 'tc' + (hash(name) % 100000);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="' + size + '" height="' + size + '" role="img" aria-label="' + escAttr(name) + '">' +
      '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + pair[0] + '"/><stop offset="1" stop-color="' + pair[1] + '"/>' +
      '</linearGradient></defs>' +
      '<path d="M36 3 L67 13 v27c0 17-13 26-31 32C18 66 5 57 5 40V13z" fill="url(#' + uid + ')" stroke="#D4A72C" stroke-width="2.5"/>' +
      '<path d="M36 3 L67 13 v27c0 17-13 26-31 32z" fill="#000" opacity=".12"/>' +
      '<text x="36" y="45" text-anchor="middle" font-family="Teko, Arial, sans-serif" font-size="30" font-weight="700" fill="#FFFFFF">' + escText(txt) + '</text>' +
      '</svg>';
  }

  function escAttr(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function escText(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  function render(root) {
    (root || document).querySelectorAll('.team-crest[data-team]:not([data-crest-done])').forEach(function (el) {
      var size = parseInt(el.getAttribute('data-size'), 10) || 24;
      el.innerHTML = crestSVG(el.getAttribute('data-team') || '', size);
      el.setAttribute('data-crest-done', '1');
    });
  }

  window.LivoCrest = { render: render, svg: crestSVG };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { render(); });
  } else {
    render();
  }
  new MutationObserver(function () { render(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
