// views/admin/localization.ejs-এর আচরণ। আগে একটা ইনলাইন <script> ব্লক আর
// ৭টা ইনলাইন হ্যান্ডলার ছিল।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  function prepImport(lang) {
    var textarea = document.getElementById('importTextarea');
    var target = document.getElementById(lang === 'bn' ? 'importJsonBn' : 'importJsonEn');
    if (!textarea || !target) return false;
    target.value = textarea.value;
    return true;
  }

  function submitImport(lang) {
    if (!prepImport(lang)) return;
    var form = document.querySelector('form[action="/admin/localization/import/' + lang + '"]');
    if (form) form.submit();
  }

  function loadFile(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var textarea = document.getElementById('importTextarea');
      if (textarea) textarea.value = String(reader.result);
    };
    reader.readAsText(file);
  }

  function init() {
    // সাধারণ hook (data-confirm, data-modal-open/close, data-auto-submit,
    // data-loading-*) এখন public/js/ui-hooks.js সামলায় — partials/head.ejs ও
    // admin-layout.ejs দুটোতেই লোড হয়। এখানে আবার বাঁধলে হ্যান্ডলার দুবার
    // চলত: confirm দুবার দেখাত, ফর্ম দুবার সাবমিট হত।

    // ইমপোর্ট ফর্ম সাবমিটের আগে textarea-র মান hidden ইনপুটে তোলা
    document.querySelectorAll('form[data-prep-import]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!prepImport(form.getAttribute('data-prep-import'))) e.preventDefault();
      });
    });

    document.querySelectorAll('[data-submit-import]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        submitImport(btn.getAttribute('data-submit-import'));
      });
    });

    document.querySelectorAll('[data-load-file]').forEach(function (input) {
      input.addEventListener('change', loadFile);
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
