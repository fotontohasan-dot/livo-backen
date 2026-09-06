// views/admin/analytics.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মানগুলো এখন JSON ডেটা ব্লক থেকে আসে,
// স্ক্রিপ্টের ভেতরে ইনজেক্ট হয় না।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-analyticsConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  const revenueLabels = cfg.revenueLabels || [];
          const revenueDeposit = cfg.revenueDeposit || [];
          const revenueWithdraw = cfg.revenueWithdraw || [];
          new Chart(document.getElementById('revenueChart'), {
            type: 'line',
            data: { labels: revenueLabels, datasets: [
              { label: 'Deposit', data: revenueDeposit, borderColor: '#10b981', tension: 0.3 },
              { label: 'Withdraw', data: revenueWithdraw, borderColor: '#ef4444', tension: 0.3 }
            ]},
            options: { plugins: { legend: { labels: { color: '#cbd5e1' } } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }
          });

          const growthLabels = cfg.growthLabels || [];
          const growthVals = cfg.growthVals || [];
          new Chart(document.getElementById('growthChart'), {
            type: 'bar',
            data: { labels: growthLabels, datasets: [{ label: 'New Users', data: growthVals, backgroundColor: '#EAB308' }] },
            options: { plugins: { legend: { labels: { color: '#cbd5e1' } } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }
          });

          let autoRefreshTimer = null;
          function startAutoRefresh() {
            autoRefreshTimer = setInterval(() => { window.location.reload(); }, 30000);
          }
          document.getElementById('autoRefreshToggle').addEventListener('change', function () {
            if (this.checked) startAutoRefresh(); else clearInterval(autoRefreshTimer);
          });
          startAutoRefresh();
          document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString('bn-BD');
})();
