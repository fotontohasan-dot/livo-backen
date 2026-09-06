// views/admin/payment-methods.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

(function () {
      // এডিট সারি খোলা/বন্ধ
      document.querySelectorAll('[data-pm-edit]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var row = document.getElementById('pm-edit-' + btn.getAttribute('data-pm-edit'));
          if (!row) return;
          var open = row.classList.toggle('open');
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      });
      document.querySelectorAll('[data-pm-cancel]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-pm-cancel');
          var row = document.getElementById('pm-edit-' + id);
          if (row) row.classList.remove('open');
          var toggle = document.querySelector('[data-pm-edit="' + id + '"]');
          if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
      });

      // ডিলিটের আগে নিশ্চিতকরণ + ডাবল-সাবমিট প্রতিরোধ।
      // একটা ফর্ম দুইবার সাবমিট হলে সার্ভার duplicate/no-op হিসেবেই সামলায়,
      // কিন্তু অ্যাডমিন দুইটা পরস্পরবিরোধী টোস্ট দেখতেন — তাই ক্লায়েন্টেও আটকানো।
      document.querySelectorAll('form[data-pm-form]').forEach(function (form) {
        form.addEventListener('submit', function (e) {
          var confirmMsg = form.getAttribute('data-pm-confirm');
          if (confirmMsg && !window.confirm(confirmMsg)) { e.preventDefault(); return; }
          if (form.dataset.pmSubmitting === '1') { e.preventDefault(); return; }
          form.dataset.pmSubmitting = '1';
          var btn = form.querySelector('button[type="submit"]');
          if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
        });
      });
    })();
