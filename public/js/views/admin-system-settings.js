// views/admin/system-settings.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function showTab(id) {
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(el => {
    el.classList.remove('bg-slate-900', 'text-white');
    el.classList.add('bg-white', 'border', 'text-slate-600');
  });
  const panel = document.getElementById('tab-' + id);
  if (panel) panel.classList.remove('hidden');
  const btn = document.querySelector('[data-tab="' + id + '"]');
  if (btn) { btn.classList.add('bg-slate-900', 'text-white'); btn.classList.remove('bg-white', 'border', 'text-slate-600'); }
}
showTab('general');

// ট্যাব রানটাইমে স্ট্রিং জোড়া দিয়ে বানানো হয় — ডেলিগেশন।
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var el = e.target.closest('[data-show-tab]');
  if (el) showTab(el.getAttribute('data-show-tab'));
});
