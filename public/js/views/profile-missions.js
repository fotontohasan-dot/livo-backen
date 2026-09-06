// views/profile/missions.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

document.querySelectorAll('.mtab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mtab').forEach(b => { b.style.background = 'rgba(255,255,255,0.08)'; });
        btn.style.background = '#10b981';
        document.querySelectorAll('.mtab-panel').forEach(p => { p.style.display = 'none'; });
        document.querySelector('.mtab-panel[data-panel="' + btn.dataset.tab + '"]').style.display = 'block';
      });
    });
