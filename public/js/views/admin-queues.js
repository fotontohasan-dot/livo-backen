// views/admin/queues.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

// প্রতি ৫ সেকেন্ডে লাইভ স্ট্যাটাস রিফ্রেশ
    async function refreshQueueStats() {
      try {
        const res = await fetch('/admin/queues/api/stats');
        const j = await res.json();
        if (!j.success) return;
        const health = j.health;

        const banner = document.getElementById('redisBanner');
        const bannerText = document.getElementById('redisBannerText');
        banner.className = 'redis-banner ' + (health.redisConnected ? 'up' : 'down');
        bannerText.textContent = health.redisConnected
          ? 'Redis সংযুক্ত — Background Queue System সচল আছে'
          : 'Redis সংযুক্ত নেই — সব Job আপাতত সরাসরি (inline fallback) মোডে চলছে';

        const cards = document.querySelectorAll('.queue-card');
        health.queues.forEach((q, i) => {
          const card = cards[i];
          if (!card) return;
          const nums = card.querySelectorAll('.queue-stat-num');
          nums[0].textContent = q.counts.waiting || 0;
          nums[1].textContent = q.counts.active || 0;
          nums[2].textContent = q.counts.delayed || 0;
          nums[3].textContent = q.counts.completed || 0;
          nums[4].textContent = q.counts.failed || 0;
        });
      } catch (e) { /* silent */ }
    }
    setInterval(refreshQueueStats, 5000);

    async function retryDlq(id) {
      const res = await fetch('/admin/queues/dead-letter/' + id + '/retry', { method: 'POST' });
      const j = await res.json();
      if (j.success) {
        showAdminToast('জব আবার Queue-তে পাঠানো হয়েছে');
        const row = document.getElementById('dlq-row-' + id);
        if (row) row.remove();
      } else {
        showAdminToast('ব্যর্থ: ' + (j.error || 'অজানা সমস্যা'));
      }
    }

    async function deleteDlq(id) {
      if (!confirm('এই dead-letter জবটা স্থায়ীভাবে ডিলিট করবেন?')) return;
      const res = await fetch('/admin/queues/dead-letter/' + id + '/delete', { method: 'POST' });
      const j = await res.json();
      if (j.success) {
        showAdminToast('ডিলিট করা হয়েছে');
        const row = document.getElementById('dlq-row-' + id);
        if (row) row.remove();
      } else {
        showAdminToast('ব্যর্থ: ' + (j.error || 'অজানা সমস্যা'));
      }
    }
  
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-dlq-retry]').forEach(function (btn) {
    btn.addEventListener('click', function () { retryDlq(Number(btn.getAttribute('data-dlq-retry'))); });
  });
  document.querySelectorAll('[data-dlq-delete]').forEach(function (btn) {
    btn.addEventListener('click', function () { deleteDlq(Number(btn.getAttribute('data-dlq-delete'))); });
  });
});
