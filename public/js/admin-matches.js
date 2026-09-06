// views/admin/matches.ejs-এর আচরণ। আগে একটা ইনলাইন <script> ব্লক আর ৭টা
// ইনলাইন হ্যান্ডলার ছিল (দুটোতে সরাসরি অ্যাট্রিবিউটের ভেতরেই DOM কল লেখা ছিল)।
//
// এই ফাইলে কোনো সার্ভার-সাইড মান লাগে না — ফিল্টারিং পুরোটাই সারির
// data-* অ্যাট্রিবিউট থেকে হয়, তাই কোনো JSON ডেটা ব্লকও দরকার নেই।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  function filterMatches() {
    var searchEl = document.getElementById('searchInput');
    var statusEl = document.getElementById('statusFilter');
    var sportEl = document.getElementById('sportFilter');
    if (!searchEl || !statusEl || !sportEl) return;

    var search = searchEl.value.toLowerCase();
    var status = statusEl.value;
    var sport = sportEl.value.toLowerCase();
    var rows = document.querySelectorAll('#matchesTable tbody tr.match-row');

    rows.forEach(function (row) {
      var team = row.dataset.team || '';
      var rowStatus = row.dataset.status || '';
      var rowSport = row.dataset.sport || '';

      var matchSearch = team.includes(search);
      var matchStatus = !status || rowStatus === status;
      var matchSport = !sport || rowSport === sport;

      row.style.display = (matchSearch && matchStatus && matchSport) ? '' : 'none';
    });
  }

  function exportMatchesCSV() {
    var table = document.getElementById('matchesTable');
    if (!table) return;
    var csv = [];

    table.querySelectorAll('tr').forEach(function (row) {
      if (row.style.display === 'none') return;
      var rowData = [];
      row.querySelectorAll('td, th').forEach(function (col) {
        rowData.push('"' + col.innerText.replace(/"/g, '""') + '"');
      });
      csv.push(rowData.join(','));
    });

    var blob = new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    var url = URL.createObjectURL(blob);
    link.href = url;
    link.download = 'matches_export.csv';
    link.click();
    // আগে objectURL কখনো ছাড়া হত না — প্রতিবার এক্সপোর্টে একটা করে blob
    // মেমরিতে ধরে থাকত। পেজ রিফ্রেশ না হওয়া পর্যন্ত ওগুলো জমতেই থাকত।
    URL.revokeObjectURL(url);
  }

  function init() {
    // সাধারণ hook (data-confirm, data-modal-open/close, data-auto-submit,
    // data-loading-*) এখন public/js/ui-hooks.js সামলায় — partials/head.ejs ও
    // admin-layout.ejs দুটোতেই লোড হয়। এখানে আবার বাঁধলে হ্যান্ডলার দুবার
    // চলত: confirm দুবার দেখাত, ফর্ম দুবার সাবমিট হত।

    document.querySelectorAll('[data-match-filter]').forEach(function (el) {
      var evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, filterMatches);
    });

    document.querySelectorAll('[data-export-matches]').forEach(function (btn) {
      btn.addEventListener('click', exportMatchesCSV);
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
