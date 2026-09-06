// views/admin/leaderboard.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

// username ইউজার-নিয়ন্ত্রিত — আগে সরাসরি innerHTML স্ট্রিং-এ বসানো হতো, ফলে
    // একজন ইউজার নিজের নামে HTML রেখে অ্যাডমিনের লিডারবোর্ড পেজে স্ক্রিপ্ট চালাতে পারত।
    function esc(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function loadContestHistory() {
      const box = document.getElementById('contestHistory');
      box.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">লোড হচ্ছে...</p>';
      try {
        const res = await fetch('/admin/leaderboard/contest/history?months=3');
        const data = await res.json();
        if (!data.success || !data.past || !data.past.length) {
          box.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">আগের কোনো মাসের কনটেস্ট রেজাল্ট নেই।</p>';
          return;
        }
        box.innerHTML = data.past.map(function (m) {
          const rows = m.leaders.map(function (l) {
            return '<tr><td class="lb-rank">#' + esc(l.rank) + '</td><td>@' + esc(l.username) + '</td><td>' + esc(l.referrals) + '</td><td>' + esc(l.prize || '—') + '</td></tr>';
          }).join('');
          return '<div style="margin-top:14px;"><div style="font-weight:700;color:var(--text-muted);font-size:13px;margin-bottom:6px;">' + esc(m.monthName) + '</div>' +
            '<table class="admin-table"><thead><tr><th>র‍্যাঙ্ক</th><th>ইউজার</th><th>রেফারেল</th><th>প্রাইজ</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        }).join('');
      } catch (e) {
        box.innerHTML = '<p style="color:#ef4444;font-size:12px;">লোড করা যায়নি: ' + esc(e.message) + '</p>';
      }
    }
  
// আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-load-history]').forEach(function (el) {
    el.addEventListener('click', loadContestHistory);
  });
});
