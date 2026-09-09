// views/tickets/event.ejs-এর ক্লায়েন্ট কোড। docs/CSP.md ধাপ ৩ — ইনলাইন
// স্ক্রিপ্ট নেই, সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।
//
// এখানে কোনো ইনভেন্টরি-সিদ্ধান্ত নেওয়া হয় না। বোতাম নিষ্ক্রিয় থাকা শুধু
// UX; আসল "sold out" রায় সার্ভার দেয় (services/tickets.js, FOR UPDATE)।
(function () {
  var cfg = {};
  var el = document.getElementById('ticketEventConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  var msg = document.getElementById('tkMsg');
  function showError(text) {
    if (!msg) return;
    msg.textContent = text;
    msg.hidden = false;
  }

  document.querySelectorAll('[data-reserve]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!cfg.loggedIn) { window.location.href = '/login'; return; }

      var categoryId = btn.dataset.reserve;
      var qtyInput = document.querySelector('[data-qty-for="' + categoryId + '"]');
      var qty = qtyInput ? parseInt(qtyInput.value, 10) : 1;
      if (!qty || qty < 1) { showError('Invalid quantity'); return; }

      btn.disabled = true;
      fetch('/tickets/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': cfg.csrfToken },
        body: JSON.stringify({ category_id: categoryId, qty: qty })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.success && data.redirect) {
            window.location.href = data.redirect;
            return;
          }
          showError((data && data.message) || 'Could not reserve');
          btn.disabled = false;
        })
        .catch(function () {
          showError('Network error');
          btn.disabled = false;
        });
    });
  });
})();
