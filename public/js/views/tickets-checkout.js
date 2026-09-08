// views/tickets/checkout.ejs-এর ক্লায়েন্ট কোড।
//
// বোতামটা প্রথম ক্লিকেই নিষ্ক্রিয় হয় — ডাবল-সাবমিট ঠেকাতে। তবে এটা শুধু
// UX-স্তরের সুরক্ষা; সার্ভারে payWithBalance() ইতিমধ্যে paid অর্ডারে টাকা
// দ্বিতীয়বার কাটে না (services/tickets.js দেখুন)।
(function () {
  var cfg = {};
  var el = document.getElementById('ticketCheckoutConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  var btn = document.getElementById('ckPay');
  var msg = document.getElementById('ckMsg');
  if (!btn) return;

  btn.addEventListener('click', function () {
    btn.disabled = true;
    fetch('/tickets/checkout/' + encodeURIComponent(cfg.orderRef) + '/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': cfg.csrfToken },
      body: '{}'
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.success && data.redirect) {
          window.location.href = data.redirect;
          return;
        }
        if (msg) { msg.textContent = (data && data.message) || 'Payment failed'; msg.hidden = false; }
        btn.disabled = false;
      })
      .catch(function () {
        if (msg) { msg.textContent = 'Network error'; msg.hidden = false; }
        btn.disabled = false;
      });
  });
})();
