// views/admin/withdrawals.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

async function approveWithdrawal(id) {
    const txn = prompt('Transaction ID / Reference দিন:', 'TXN' + Date.now().toString().slice(-8));
    if (txn === null) return;
    try {
        const res = await fetch('/admin/api/withdrawals/' + id + '/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txn })
        });
        const data = await res.json();
        if (data.success) { alert('✅ উইথড্র Approve হয়েছে!'); location.reload(); }
        else alert('❌ ' + (data.error || 'সমস্যা হয়েছে'));
    } catch (e) { alert('❌ সার্ভার এরর'); }
}
async function rejectWithdrawal(id) {
    const reason = prompt('বাতিলের কারণ লিখুন:', '');
    if (reason === null) return;
    try {
        const res = await fetch('/admin/api/withdrawals/' + id + '/reject', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (data.success) { alert('✅ উইথড্র বাতিল হয়েছে, কয়েন ফেরত দেওয়া হয়েছে।'); location.reload(); }
        else alert('❌ ' + (data.error || 'সমস্যা হয়েছে'));
    } catch (e) { alert('❌ সার্ভার এরর'); }
}

// সারি রানটাইমে স্ট্রিং জোড়া দিয়ে বানানো হয়, তাই ডেলিগেশন।
// Approve আর Reject আলাদা অ্যাট্রিবিউট — একটাই "action" অ্যাট্রিবিউট হলে
// মানের একটা টাইপো নীরবে ভুল দিকে নিয়ে যেত, আর এখানে ভুল মানে টাকা।
// approveWithdrawal() নিজের prompt()/confirm() নিজেই করে; সেটা অপরিবর্তিত।
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var ap = e.target.closest('[data-withdrawal-approve]');
  if (ap) { approveWithdrawal(Number(ap.getAttribute('data-withdrawal-approve'))); return; }
  var rj = e.target.closest('[data-withdrawal-reject]');
  if (rj) rejectWithdrawal(Number(rj.getAttribute('data-withdrawal-reject')));
});
