// views/admin/markets.ejs-এর ক্লায়েন্ট কোড।
// মার্কেট আইডি বাটনের data-settle-id অ্যাট্রিবিউট থেকে আসে (সার্ভার-কনফিগ ব্লক লাগে না)।

(function(){
  // runners: কমা-ভাগ করা রানার কী (over,under / 0,1,draw ...) — ফর্মের ফিল্ডটা `winning_runner`,
  // কারণ সার্ভার (routes/admin.js) ঠিক ওই নামেই খোঁজে। আগে ফিল্ডের নাম ছিল `result`, ফলে
  // কোনো মার্কেটই সেটেল করা যেত না ("বিজয়ী নির্বাচন করুন" এরর আসত)।
  function showSettleModal(marketId, marketName, runners) {
    document.getElementById('settle-modal').classList.remove('hidden');
    document.getElementById('settle-market-name').innerText = marketName;
    const form = document.getElementById('settle-form');
    form.action = `/admin/markets/${encodeURIComponent(marketId)}/settle`;

    const list = document.getElementById('settle-runner-list');
    const hint = document.getElementById('settle-runner-hint');
    const input = document.getElementById('settle-runner');
    const keys = (runners || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    if (list) {
      list.innerHTML = '';
      keys.forEach(function (k) {
        const opt = document.createElement('option');
        opt.value = k;
        list.appendChild(opt);
      });
    }
    if (hint) hint.textContent = keys.length ? ('Valid: ' + keys.join(', ')) : '';
    if (input) input.value = '';
  }

  function hideSettleModal() {
    document.getElementById('settle-modal').classList.add('hidden');
  }

  function exportMarketsCSV() {
    const table = document.getElementById('marketsTable');
    let csv = [];
    const rows = table.querySelectorAll('tr');
    
    rows.forEach((row, index) => {
      if (index === 0 || row.style.display === 'none') return; // skip header if needed
      const cols = row.querySelectorAll('td, th');
      let rowData = [];
      cols.forEach(col => rowData.push('"' + col.innerText.replace(/"/g, '""') + '"'));
      csv.push(rowData.join(','));
    });

    const csvContent = csv.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'markets_export.csv';
    link.click();
  }

  // সেটেল মডাল ও এক্সপোর্ট — আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-markets-export]').forEach(function (btn) {
      btn.addEventListener('click', exportMarketsCSV);
    });
    document.querySelectorAll('[data-settle-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showSettleModal(btn.getAttribute('data-settle-id'), btn.getAttribute('data-settle-name'), btn.getAttribute('data-settle-runners'));
      });
    });
    document.querySelectorAll('[data-settle-cancel]').forEach(function (btn) {
      btn.addEventListener('click', hideSettleModal);
    });
  });
})();
