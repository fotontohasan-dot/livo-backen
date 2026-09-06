// views/payment/admin.ejs-এর আচরণ। আগে একটা ইনলাইন <script> ব্লক আর ৯টা
// ইনলাইন হ্যান্ডলার ছিল — যার দুটো (সারির চেকবক্স আর বাতিল ফর্মের confirm)
// টেমপ্লেটে নয়, renderRows() রানটাইমে HTML স্ট্রিং জোড়া দিয়ে বানাত।
//
// সারির কন্ট্রোলগুলো প্রতিবার নতুন করে তৈরি হয়, তাই ওদের জন্য
// addEventListener প্রতি-এলিমেন্টে না বসিয়ে ডকুমেন্ট-লেভেল ডেলিগেশন ব্যবহার
// করা হয়েছে — নাহলে প্রতিটা re-render-এর পরে আবার bind করতে হত, আর একটা
// ভুলে গেলে চেকবক্স নীরবে কাজ করা বন্ধ করত।
//
// রিকোয়েস্টের ডেটা <script type="application/json"> ব্লক থেকে আসে।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  var allRequests = [];

  function readJsonBlock(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusBadge(status) {
    if (status === 'pending') return '<span class="badge badge-amber">পেন্ডিং</span>';
    if (status === 'approved') return '<span class="badge badge-green">অনুমোদিত</span>';
    return '<span class="badge badge-red">বাতিল</span>';
  }

  function renderRows(type, tableId, stripId, countId) {
    const rows = allRequests.filter(r => r.type === type);
    const pending = rows.filter(r => r.status === 'pending');
    document.getElementById(countId).textContent = pending.length;

    document.getElementById(stripId).innerHTML = pending.length > 0
      ? '<div class="pending-strip"><i class="fas fa-bell"></i> ' + pending.length + 'টি নতুন পেন্ডিং রিকোয়েস্ট অপেক্ষমাণ</div>'
      : '';

    const tbody = document.querySelector('#' + tableId + ' tbody');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">কোনো রিকোয়েস্ট নেই</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.status === 'pending' ? `<input type="checkbox" class="pay-row-check" data-id="${r.id}">` : ''}</td>
        <td style="font-weight:700;">${escHtml(r.username)}</td>
        <td style="text-transform:capitalize;">${escHtml(r.method || '—')}</td>
        <td style="color:#f59e0b;font-weight:700;">৳ ${Number(r.amount).toLocaleString('en-US')}</td>
        <td style="color:var(--text-muted);">${escHtml(r.transaction_id || '—')}</td>
        <td>${escHtml(r.account_number || '—')}</td>
        <td>${r.created_at ? new Date(r.created_at).toLocaleString('bn-BD') : '—'}</td>
        <td>${statusBadge(r.status)}</td>
        <td style="text-align:right;">
          ${r.status === 'pending' ? `
            <form action="/payment/admin/approve/${r.id}" method="POST" style="display:inline;">
              <button class="btn btn-sm btn-green" type="submit">অনুমোদন</button>
            </form>
            <form action="/payment/admin/reject/${r.id}" method="POST" style="display:inline;" data-confirm="বাতিল করবেন?">
              <button class="btn btn-sm btn-red" type="submit">বাতিল</button>
            </form>
          ` : ''}
        </td>
      </tr>
    `).join('');
  }

  function renderAll() {
    renderRows('deposit', 'depositTable', 'depositPendingStrip', 'depositCount');
    renderRows('withdraw', 'withdrawTable', 'withdrawPendingStrip', 'withdrawCount');
  }


  function showPayTab(i) {
    document.querySelectorAll('.pay-panel').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.pay-tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('pay-tab-' + i).classList.add('active');
    document.querySelectorAll('.pay-tab-btn')[i].classList.add('active');
  }

  function getSelectedPaymentIds() {
    return Array.from(document.querySelectorAll('.pay-row-check:checked')).map(el => el.getAttribute('data-id'));
  }
  function updatePaymentBulkBar() {
    const ids = getSelectedPaymentIds();
    const bar = document.getElementById('paymentBulkBar');
    document.getElementById('paymentBulkCount').textContent = ids.length;
    bar.classList.toggle('hidden', ids.length === 0);
    bar.style.display = ids.length > 0 ? 'flex' : 'none';
    document.querySelectorAll('.pay-select-all').forEach(sa => {
      const table = document.getElementById(sa.getAttribute('data-table'));
      const rowChecks = table.querySelectorAll('.pay-row-check');
      const checkedInTable = table.querySelectorAll('.pay-row-check:checked');
      sa.checked = rowChecks.length > 0 && checkedInTable.length === rowChecks.length;
    });
  }
  function togglePaySelectAll(checkbox) {
    const table = document.getElementById(checkbox.getAttribute('data-table'));
    table.querySelectorAll('.pay-row-check').forEach(el => { el.checked = checkbox.checked; });
    updatePaymentBulkBar();
  }
  function clearPaymentBulkSelection() {
    document.querySelectorAll('.pay-row-check').forEach(el => { el.checked = false; });
    document.querySelectorAll('.pay-select-all').forEach(el => { el.checked = false; });
    updatePaymentBulkBar();
  }
  function bulkPaymentAction(action) {
    const ids = getSelectedPaymentIds();
    if (ids.length === 0) return;
    const label = action === 'approve' ? 'অনুমোদন' : 'বাতিল';
    if (!confirm(ids.length + 'টা রিকোয়েস্ট ' + label + ' করবেন?')) return;
    fetch('/payment/admin/payments/bulk-' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          const msg = data.succeeded + 'টা সফল, ' + data.failed + 'টা ব্যর্থ';
          if (typeof showAdminToast === 'function') showAdminToast(msg); else alert(msg);
          setTimeout(() => window.location.reload(), 900);
        } else {
          const msg = data.error || 'সমস্যা হয়েছে';
          if (typeof showAdminToast === 'function') showAdminToast(msg); else alert(msg);
        }
      })
      .catch(() => {
        if (typeof showAdminToast === 'function') showAdminToast('নেটওয়ার্ক সমস্যা হয়েছে'); else alert('নেটওয়ার্ক সমস্যা হয়েছে');
      });
  }

  function init() {
    allRequests = readJsonBlock('paymentRequests') || [];
    renderAll();

    // বটম-নেভ থেকে সরাসরি ?tab=withdraw বা ?tab=deposit দিয়ে আসলে সেই ট্যাব
    var urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab === 'withdraw') showPayTab(1);

    document.querySelectorAll('[data-pay-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showPayTab(Number(btn.getAttribute('data-pay-tab')));
      });
    });

    document.querySelectorAll('[data-pay-bulk]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        bulkPaymentAction(btn.getAttribute('data-pay-bulk'));
      });
    });

    document.querySelectorAll('[data-pay-clear]').forEach(function (btn) {
      btn.addEventListener('click', clearPaymentBulkSelection);
    });

    document.querySelectorAll('.pay-select-all').forEach(function (cb) {
      cb.addEventListener('change', function () { togglePaySelectAll(cb); });
    });

    // সারির চেকবক্স ও বাতিল ফর্ম renderRows() প্রতিবার নতুন করে বানায় —
    // তাই ডেলিগেশন, প্রতি-এলিমেন্ট bind নয়।
    document.addEventListener('change', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('pay-row-check')) {
        updatePaymentBulkBar();
      }
    });
    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (form && form.matches && form.matches('form[data-confirm]')) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
