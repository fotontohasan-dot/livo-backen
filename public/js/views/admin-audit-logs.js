// views/admin/audit-logs.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
async function openLogDetail(id) {
  const overlay = document.getElementById('auditLogModalOverlay');
  const body = document.getElementById('auditLogModalBody');
  overlay.style.display = 'flex';
  body.innerHTML = 'লোড হচ্ছে...';
  try {
    const res = await fetch('/admin/audit-logs/' + id + '.json');
    if (!res.ok) throw new Error('not found');
    const log = await res.json();
    // log.actor_username/action/details ইত্যাদি admin-লেখা ফ্রি-টেক্সট হতে পারে (যেমন একটা
    // rejection reason) — আগে এখানে কোনো escape ছাড়াই innerHTML-এ বসানো হতো, ফলে একজন admin-এর
    // টাইপ করা HTML/JS পরে অন্য একজন admin-এর ব্রাউজারে live কোড হিসেবে চলত (stored XSS)।
    const row = (label, value) => '<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f8fafc;"><span style="color:var(--text-muted); font-weight:600;">' + escHtml(label) + '</span><span style="color:#334155; text-align:right; max-width:60%; word-break:break-word;">' + (value == null || value === '' ? '-' : escHtml(String(value))) + '</span></div>';
    body.innerHTML =
      row('ID', '#' + log.id) +
      row('Time', new Date(log.created_at).toLocaleString('en-US')) +
      row('Actor Type', (log.actor_type || '').toUpperCase()) +
      row('Actor', log.actor_username) +
      row('Action', log.action) +
      row('Category', log.category) +
      row('Status', (log.status || '').toUpperCase()) +
      row('Risk Level', (log.risk_level || '').toUpperCase()) +
      row('IP Address', log.ip_address) +
      row('Device', log.device_name) +
      row('Browser', log.browser) +
      row('OS', log.os) +
      row('Location', log.location) +
      row('Request ID', log.request_id) +
      '<div style="margin-top:12px;"><div style="color:var(--text-muted); font-weight:600; margin-bottom:6px;">Details</div><pre style="background:#f8fafc; border-radius:10px; padding:12px; font-size:12px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">' + escHtml(JSON.stringify(log.details || {}, null, 2)) + '</pre></div>';
  } catch (e) {
    body.innerHTML = '<div style="color:#ef4444;">লোড করতে সমস্যা হয়েছে।</div>';
  }
}
function closeLogDetail() {
  document.getElementById('auditLogModalOverlay').style.display = 'none';
}
document.getElementById('auditLogModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeLogDetail();
});

// লগ সারি রানটাইমে বানানো হয় — ডেলিগেশন (docs/CSP.md ধাপ ২)।
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var row = e.target.closest('[data-log-detail]');
  if (row) { openLogDetail(Number(row.getAttribute('data-log-detail'))); return; }
  if (e.target.closest('[data-log-close]')) closeLogDetail();
});
