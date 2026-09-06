// views/admin/markets.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: এই পেজের body একটা JS template literal, তাই সার্ভার
// মান ${...} দিয়ে আসত। এখন সেগুলো JSON ডেটা ব্লক থেকে পড়া হয়।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-marketsConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function showSettleModal(marketId, marketName) {
    document.getElementById('settle-modal').classList.remove('hidden');
    document.getElementById('settle-market-name').innerText = marketName;
    const form = document.getElementById('settle-form');
    form.action = `/admin/markets/cfg.marketId/settle`;
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
        showSettleModal(btn.getAttribute('data-settle-id'), btn.getAttribute('data-settle-name'));
      });
    });
    document.querySelectorAll('[data-settle-cancel]').forEach(function (btn) {
      btn.addEventListener('click', hideSettleModal);
    });
  });
})();
