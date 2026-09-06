// views/admin/users.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function getSelectedUserIds() {
  return Array.from(document.querySelectorAll('.user-row-check:checked')).map(function (el) { return el.getAttribute('data-id'); });
}
function updateBulkBar() {
  var ids = getSelectedUserIds();
  var bar = document.getElementById('bulkActionBar');
  var countEl = document.getElementById('bulkSelectedCount');
  countEl.textContent = ids.length;
  bar.classList.toggle('hidden', ids.length === 0);
  bar.classList.toggle('flex', ids.length > 0);
  var allChecks = document.querySelectorAll('.user-row-check');
  var selectAll = document.getElementById('selectAllUsers');
  selectAll.checked = allChecks.length > 0 && ids.length === allChecks.length;
}
function toggleSelectAllUsers(checkbox) {
  document.querySelectorAll('.user-row-check').forEach(function (el) { el.checked = checkbox.checked; });
  updateBulkBar();
}
function clearBulkSelection() {
  document.querySelectorAll('.user-row-check').forEach(function (el) { el.checked = false; });
  document.getElementById('selectAllUsers').checked = false;
  updateBulkBar();
}
function bulkBanSelected() {
  var ids = getSelectedUserIds();
  if (ids.length === 0) return;
  if (!confirm(ids.length + 'টা ইউজারকে ব্যান করবেন? এই অ্যাকশন একসাথে সবার উপর প্রয়োগ হবে।')) return;
  fetch('/admin/users/bulk-ban', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ids })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.success) {
        if (typeof LivoToast !== 'undefined') {
          LivoToast.show(data.succeeded + 'টা সফল, ' + data.failed + 'টা ব্যর্থ', data.failed > 0 ? 'info' : 'success');
        } else {
          alert(data.succeeded + 'টা সফল, ' + data.failed + 'টা ব্যর্থ');
        }
        setTimeout(function () { window.location.reload(); }, 900);
      } else {
        if (typeof LivoToast !== 'undefined') LivoToast.show(data.error || 'সমস্যা হয়েছে', 'error');
        else alert(data.error || 'সমস্যা হয়েছে');
      }
    })
    .catch(function () {
      if (typeof LivoToast !== 'undefined') LivoToast.show('নেটওয়ার্ক সমস্যা হয়েছে', 'error');
      else alert('নেটওয়ার্ক সমস্যা হয়েছে');
    });
}

// বাল্ক নির্বাচনের কন্ট্রোল — আগে ইনলাইন হ্যান্ডলার ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-users-check]').forEach(function (cb) {
    cb.addEventListener('change', updateBulkBar);
  });
  document.querySelectorAll('[data-users-select-all]').forEach(function (cb) {
    cb.addEventListener('change', function () { toggleSelectAllUsers(cb); });
  });
  var actions = { 'bulk-ban': bulkBanSelected, 'clear': clearBulkSelection };
  document.querySelectorAll('[data-users-action]').forEach(function (btn) {
    var fn = actions[btn.getAttribute('data-users-action')];
    if (fn) btn.addEventListener('click', fn);
  });
});
