// views/admin/reports.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: এই পেজের body একটা JS template literal, তাই সার্ভার
// মান ${...} দিয়ে আসত। এখন সেগুলো JSON ডেটা ব্লক থেকে পড়া হয়।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-reportsConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  const ctx1 = document.getElementById('ggrChart');
  new Chart(ctx1, {
      type: 'line',
      data: {
          labels: cfg.ggrLabels,
          datasets: [{
              label: 'GGR (৳)',
              data: cfg.ggrData,
              borderColor: '#3b82f6',
              tension: 0.4,
              fill: true,
              backgroundColor: 'rgba(59, 130, 246, 0.1)'
          }]
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });

  const ctx2 = document.getElementById('userChart');
  new Chart(ctx2, {
      type: 'bar',
      data: {
          labels: cfg.userLabels,
          datasets: [{
              label: 'New Users',
              data: cfg.userData,
              backgroundColor: '#10b981'
          }]
      },
      options: { plugins: { legend: { display: false } } }
  });
})();
