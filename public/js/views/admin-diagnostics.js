// views/admin/diagnostics.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

async function refreshDiagnostics() {
  const icon = document.getElementById('refresh-icon');
  const ts   = document.getElementById('ts');
  icon.classList.add('fa-spin');
  try {
    const res  = await fetch('/admin/diagnostics/json');
    const data = await res.json();
    const statusLabel = (s) => s === 'healthy' ? 'Healthy' : s === 'warning' ? 'Warning' : 'Error';
    const badgeClass  = (s) => s === 'healthy' ? 'bg-emerald-100 text-emerald-700' : s === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
    const ob = document.getElementById('overall-badge');
    ob.textContent  = statusLabel(data.overall);
    ob.className    = 'px-4 py-1.5 text-sm font-bold rounded-full ' + badgeClass(data.overall);
    ts.textContent  = new Date(data.timestamp).toLocaleString('bn-BD');
  } catch(e) {}
  finally { icon.classList.remove('fa-spin'); }
}
// 30 সেকেন্ড পর পর অটো-রিফ্রেশ
setInterval(refreshDiagnostics, 30000);

// আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-diagnostics-refresh]').forEach(function (el) {
    el.addEventListener('click', refreshDiagnostics);
  });
});
