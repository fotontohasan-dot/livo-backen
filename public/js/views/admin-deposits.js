// views/admin/deposits.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

async function approveDeposit(id) {
    if (!confirm('এই ডিপোজিট Approve করবেন?')) return;
    try {
        const res = await fetch('/admin/api/deposits/' + id + '/approve', { method: 'POST' });
        const data = await res.json();
        if (data.success) { alert('✅ ডিপোজিট Approve হয়েছে, ইউজারের কয়েন যোগ হয়ে গেছে।'); location.reload(); }
        else alert('❌ ' + (data.error || 'সমস্যা হয়েছে'));
    } catch (e) { alert('❌ সার্ভার এরর'); }
}
async function rejectDeposit(id) {
    const reason = prompt('বাতিলের কারণ লিখুন (ঐচ্ছিক):', '');
    if (reason === null) return;
    try {
        const res = await fetch('/admin/api/deposits/' + id + '/reject', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (data.success) { alert('✅ ডিপোজিট বাতিল হয়েছে।'); location.reload(); }
        else alert('❌ ' + (data.error || 'সমস্যা হয়েছে'));
    } catch (e) { alert('❌ সার্ভার এরর'); }
}

// উপরের withdrawals-এর মতোই: রানটাইমে বানানো সারি, আর approve/reject
// আলাদা অ্যাট্রিবিউট। ফাংশনগুলোর নিজস্ব confirm() অপরিবর্তিত।
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var ap = e.target.closest('[data-deposit-approve]');
  if (ap) { approveDeposit(Number(ap.getAttribute('data-deposit-approve'))); return; }
  var rj = e.target.closest('[data-deposit-reject]');
  if (rj) rejectDeposit(Number(rj.getAttribute('data-deposit-reject')));
});
