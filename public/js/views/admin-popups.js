// views/admin/popups.ejs-এর ক্লায়েন্ট কোড (docs/CSP.md: কোনো ইনলাইন স্ক্রিপ্ট নেই)।
//  ১) ছবি আপলোড (fetch → /admin/popups/upload; CSRF হেডার csrf-inject.js নিজে বসায়)
//  ২) সেটিংস বদলালেই লাইভ প্রিভিউ — পাবলিক পপআপের একই CSS ভেরিয়েবল দিয়ে

(function () {
  var cfg = {};
  var cfgEl = document.getElementById('admin-popupsConfig');
  if (cfgEl) { try { cfg = JSON.parse(cfgEl.textContent) || {}; } catch (e) { cfg = {}; } }
  var ratios = cfg.ratios || {};

  // ---------- আপলোড ----------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-popup-upload]') : null;
    if (!btn) return;
    var form = btn.closest('form');
    if (!form) return;
    var fileInput = form.querySelector('[data-popup-file]');
    var urlInput = form.querySelector('[data-popup-image-url]');
    var status = form.querySelector('[data-popup-status]');
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { if (status) status.textContent = cfg.pickFileLabel || ''; return; }

    var fd = new FormData();
    fd.append('image', file);
    btn.disabled = true;
    if (status) status.textContent = cfg.uploadingLabel || '...';
    fetch('/admin/popups/upload', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d && res.d.url) {
          if (urlInput) urlInput.value = res.d.url;
          if (status) status.textContent = cfg.uploadedLabel || 'OK';
          updatePreviewImage(res.d.url);
        } else if (status) {
          status.textContent = (res.d && res.d.error) || 'Error';
        }
      })
      .catch(function () { if (status) status.textContent = 'Error'; })
      .then(function () { btn.disabled = false; });
  });

  // ---------- লাইভ প্রিভিউ ----------
  var form = document.getElementById('popSettingsForm');
  var stage = document.getElementById('popPvStage');
  var box = document.getElementById('popPvBox');
  var media = document.getElementById('popPvMedia');
  var img = document.getElementById('popPvImg');
  var cap = document.getElementById('popPvCap');
  var dots = document.getElementById('popPvDots');
  var nav = document.getElementById('popPvNav');

  function val(name) { var el = form && form.elements[name]; return el ? el.value : ''; }
  function checked(name) { var el = form && form.elements[name]; return !!(el && el.checked); }

  function updatePreviewImage(url) {
    if (img && /^(https:\/\/res\.cloudinary\.com\/|\/(?!\/))/.test(url)) img.src = url;
  }

  function applyPreview() {
    if (!form || !stage || !box) return;
    stage.style.setProperty('--pp-overlay', String((parseInt(val('overlayOpacity'), 10) || 0) / 100));
    box.style.setProperty('--pp-maxw', (parseInt(val('maxWidthPx'), 10) || 480) + 'px');
    box.style.setProperty('--pp-bg', val('frameBg') || '#ffffff');
    box.style.setProperty('--pp-radius', (parseInt(val('radiusPx'), 10) || 0) + 'px');
    box.style.setProperty('--pp-bw', (parseInt(val('borderWidthPx'), 10) || 0) + 'px');
    box.style.setProperty('--pp-bc', val('borderColor') || '#ffffff');
    box.style.setProperty('--pp-fit', val('imageFit') || 'cover');
    var ratio = ratios[val('shape')];
    if (ratio) {
      media.classList.add('fixed');
      media.style.setProperty('--pp-ratio', String(ratio));
    } else {
      media.classList.remove('fixed');
    }
    stage.classList.toggle('pos-top', val('position') === 'top');
    stage.classList.toggle('pos-bottom', val('position') === 'bottom');
    if (cap) cap.classList.toggle('pop-hidden', !checked('showCaption'));
    if (dots) dots.classList.toggle('pop-hidden', !checked('showDots'));
    if (nav) nav.classList.toggle('pop-hidden', !checked('showNav'));
  }

  if (form) {
    form.addEventListener('input', applyPreview);
    form.addEventListener('change', applyPreview);
    applyPreview();
  }

  // ছবির URL ফিল্ড বদলালে প্রিভিউ ছবিও বদলায়
  document.addEventListener('change', function (e) {
    if (e.target && e.target.matches && e.target.matches('[data-popup-image-url]')) updatePreviewImage(e.target.value.trim());
  });
})();
