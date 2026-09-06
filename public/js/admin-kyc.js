// views/admin/kyc.ejs-এর আচরণ। আগে এটা একটা ইনলাইন <script> ব্লক ছিল আর
// ১৫টা ইনলাইন onclick/onchange হ্যান্ডলার টেমপ্লেটে ছড়ানো ছিল।
//
// দুটো জিনিস বিশেষভাবে খেয়াল রাখা হয়েছে:
//
// ১. আগে প্রতিটা "বিস্তারিত" বাটনে গোটা KYC অবজেক্টটা JSON হিসেবে
//    onclick অ্যাট্রিবিউটের ভেতরে বসানো হত। jsonScriptSafe() `<`, `>`, `&`
//    escape করে কিন্তু উদ্ধৃতিচিহ্ন করে না — অর্থাৎ HTML অ্যাট্রিবিউটের ভেতরে
//    ওটা বসানো নিরাপদ ছিল না। এখন ডেটা যায় একটা
//    `<script type="application/json">` ব্লকে (এটা executable নয়, তাই CSP
//    এতে বাধা দেয় না) আর বাটন শুধু id বহন করে।
//
// ২. viewKyc() আগে innerHTML-এ error-হ্যান্ডলার অ্যাট্রিবিউটসহ <img> বসাত —
//    অর্থাৎ রানটাইমে একটা নতুন ইনলাইন হ্যান্ডলার তৈরি হত, যা
//    script-src-attr 'none' এ ব্লক হত। এখন <img> DOM API দিয়ে বানানো হয়
//    আর error হ্যান্ডলার addEventListener দিয়ে যুক্ত হয়।

(function () {
  'use strict';

  var pendingRejectId = null;
  var KYC_DOC_ALT = '';
  var kycById = {};

  function readJsonBlock(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ডকুমেন্ট সার্ভার-প্রক্সি হয়ে আসে, Cloudinary URL সরাসরি নয়। আগে আসল URL
     পেইজের HTML-এ বসত — জাতীয় পরিচয়পত্রের ঠিকানা ব্রাউজার ইতিহাস, রেফারার
     হেডার ও এক্সটেনশনে ছড়িয়ে পড়ত, আর URL জানা থাকলে যে কেউ প্রমাণীকরণ
     ছাড়াই দেখতে পারত। প্রক্সি রুটে অনুমতি যাচাই হয় এবং প্রতিটা দেখা অডিট
     লগে যায়। */
  function docProxyUrl(k) {
    // has_document একটা boolean — আসল Cloudinary URL ক্লায়েন্টে পাঠানোই হয় না।
    if (!k || !k.id || !k.has_document) return null;
    return '/admin/kyc/' + encodeURIComponent(k.id) + '/document';
  }

  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('show');
  }

  function kvRow(label, value) {
    return '<div class="kv-row"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value) + '</span></div>';
  }

  function viewKyc(k) {
    if (!k) return;
    var body = document.getElementById('viewModalBody');
    if (!body) return;

    var html = '';
    html += kvRow('নাম', k.full_name || '—');
    html += kvRow('ইউজারনেম', '@' + (k.username || '—'));
    html += kvRow('ফোন', k.phone || '—');
    html += kvRow('ডকুমেন্ট টাইপ', k.document_type || '—');
    html += kvRow('ডকুমেন্ট নম্বর', k.document_number || '—');
    html += kvRow('জমার তারিখ', k.created_at ? new Date(k.created_at).toLocaleString('bn-BD') : '—');
    body.innerHTML = html;

    var docUrl = docProxyUrl(k);
    if (docUrl) {
      // <img onerror=...> আর স্ট্রিং হিসেবে বসানো হয় না — DOM API দিয়ে
      // বানিয়ে হ্যান্ডলার JS থেকে যুক্ত করা হয়, তাই ইনলাইন হ্যান্ডলার নেই।
      var previewLink = document.createElement('a');
      previewLink.href = docUrl;
      previewLink.target = '_blank';
      previewLink.rel = 'noopener noreferrer';

      var img = document.createElement('img');
      img.alt = KYC_DOC_ALT;
      img.className = 'doc-preview';
      img.src = docUrl;
      img.addEventListener('error', function () { img.style.display = 'none'; });
      previewLink.appendChild(img);
      body.appendChild(previewLink);

      var openLink = document.createElement('a');
      openLink.className = 'btn btn-sm';
      openLink.style.marginTop = '8px';
      openLink.href = docUrl;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.innerHTML = '<i class="fas fa-external-link-alt"></i> ';
      openLink.appendChild(document.createTextNode('মূল ডকুমেন্ট দেখুন'));
      body.appendChild(openLink);
    } else if (k.has_document) {
      var warn = document.createElement('p');
      warn.style.color = '#dc2626';
      warn.style.fontSize = '12px';
      warn.textContent = '⚠️ অবৈধ ডকুমেন্ট URL — দেখানো যাচ্ছে না';
      body.appendChild(warn);
    }

    document.getElementById('viewModal').classList.add('show');
  }

  function approveKyc(id) {
    if (!window.confirm('এই KYC আবেদনটি অনুমোদন করবেন?')) return;
    fetch('/admin/kyc/' + id + '/approve', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success) {
          window.showAdminToast('অনুমোদন সম্পন্ন হয়েছে');
          setTimeout(function () { location.reload(); }, 700);
        } else {
          window.alert(data.message || 'সমস্যা হয়েছে');
        }
      })
      .catch(function () { window.alert('সার্ভার এরর'); });
  }

  function rejectKyc(id) {
    pendingRejectId = id;
    document.getElementById('rejectReason').value = '';
    document.getElementById('rejectModal').classList.add('show');
  }

  // ==================== বাল্ক নির্বাচন ও অ্যাকশন ====================
  function getKycSelectedIds() {
    return Array.prototype.slice.call(document.querySelectorAll('.kyc-row-check:checked'))
      .map(function (el) { return el.value; });
  }

  function updateKycBulkBar() {
    var count = getKycSelectedIds().length;
    var bar = document.getElementById('kycBulkBar');
    var countEl = document.getElementById('kycSelectedCount');
    if (countEl) countEl.textContent = count;
    if (bar) bar.style.display = count > 0 ? 'block' : 'none';
    var selectAll = document.getElementById('kycSelectAll');
    var rowChecks = document.querySelectorAll('.kyc-row-check');
    if (selectAll) selectAll.checked = rowChecks.length > 0 && count === rowChecks.length;
  }

  function toggleKycSelectAll(el) {
    document.querySelectorAll('.kyc-row-check').forEach(function (cb) { cb.checked = el.checked; });
    updateKycBulkBar();
  }

  function clearKycSelection() {
    document.querySelectorAll('.kyc-row-check').forEach(function (cb) { cb.checked = false; });
    var selectAll = document.getElementById('kycSelectAll');
    if (selectAll) selectAll.checked = false;
    updateKycBulkBar();
  }

  function bulkResultSummary(data) {
    var msg = data.succeeded + ' টি সফল';
    if (data.failed > 0) {
      var failedReasons = (data.results || []).filter(function (r) { return !r.success; })
        .map(function (r) { return '#' + r.id + ': ' + (r.error || 'ব্যর্থ'); }).join('\n');
      msg += ', ' + data.failed + ' টি ব্যর্থ\n\n' + failedReasons;
    }
    return msg;
  }

  function bulkApproveKyc() {
    var ids = getKycSelectedIds();
    if (!ids.length) return;
    if (!window.confirm(ids.length + ' টি KYC আবেদন অনুমোদন করবেন?')) return;
    fetch('/admin/kyc/bulk-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success) {
          window.showAdminToast(bulkResultSummary(data));
          setTimeout(function () { location.reload(); }, data.failed > 0 ? 1500 : 700);
        } else {
          window.alert(data.error || 'সমস্যা হয়েছে');
        }
      })
      .catch(function () { window.alert('সার্ভার এরর'); });
  }

  function bulkRejectKyc() {
    var ids = getKycSelectedIds();
    if (!ids.length) return;
    document.getElementById('bulkRejectCount').textContent = ids.length;
    document.getElementById('bulkRejectReason').value = '';
    document.getElementById('bulkRejectModal').classList.add('show');
  }

  function init() {
    // সাধারণ hook (data-confirm, data-modal-open/close, data-auto-submit,
    // data-loading-*) এখন public/js/ui-hooks.js সামলায় — partials/head.ejs ও
    // admin-layout.ejs দুটোতেই লোড হয়। এখানে আবার বাঁধলে হ্যান্ডলার দুবার
    // চলত: confirm দুবার দেখাত, ফর্ম দুবার সাবমিট হত।

    var config = readJsonBlock('kycConfig') || {};
    KYC_DOC_ALT = config.docAlt || '';

    (readJsonBlock('kycData') || []).forEach(function (k) {
      if (k && k.id != null) kycById[String(k.id)] = k;
    });

    // সারি ও "সব নির্বাচন" চেকবক্স
    document.querySelectorAll('.kyc-row-check').forEach(function (cb) {
      cb.addEventListener('change', updateKycBulkBar);
    });
    var selectAll = document.getElementById('kycSelectAll');
    if (selectAll) {
      selectAll.addEventListener('change', function () { toggleKycSelectAll(selectAll); });
    }

    // সারি-প্রতি অ্যাকশন — id বাটনের data-* থেকে, JSON আর অ্যাট্রিবিউটে নয়
    document.querySelectorAll('[data-kyc-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        viewKyc(kycById[btn.getAttribute('data-kyc-view')]);
      });
    });
    document.querySelectorAll('[data-kyc-approve]').forEach(function (btn) {
      btn.addEventListener('click', function () { approveKyc(btn.getAttribute('data-kyc-approve')); });
    });
    document.querySelectorAll('[data-kyc-reject]').forEach(function (btn) {
      btn.addEventListener('click', function () { rejectKyc(btn.getAttribute('data-kyc-reject')); });
    });

    // বাল্ক অ্যাকশন বার
    document.querySelectorAll('[data-kyc-bulk-approve]').forEach(function (btn) {
      btn.addEventListener('click', bulkApproveKyc);
    });
    document.querySelectorAll('[data-kyc-bulk-reject]').forEach(function (btn) {
      btn.addEventListener('click', bulkRejectKyc);
    });
    document.querySelectorAll('[data-kyc-clear-selection]').forEach(function (btn) {
      btn.addEventListener('click', clearKycSelection);
    });

    var confirmReject = document.getElementById('confirmRejectBtn');
    if (confirmReject) {
      confirmReject.addEventListener('click', function () {
        var reason = document.getElementById('rejectReason').value.trim();
        if (!pendingRejectId) return;
        fetch('/admin/kyc/' + pendingRejectId + '/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason })
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            closeModal('rejectModal');
            if (data.success) {
              window.showAdminToast('আবেদন বাতিল করা হয়েছে');
              setTimeout(function () { location.reload(); }, 700);
            } else {
              window.alert(data.message || 'সমস্যা হয়েছে');
            }
          })
          .catch(function () { window.alert('সার্ভার এরর'); });
      });
    }

    var confirmBulkReject = document.getElementById('confirmBulkRejectBtn');
    if (confirmBulkReject) {
      confirmBulkReject.addEventListener('click', function () {
        var ids = getKycSelectedIds();
        if (!ids.length) { closeModal('bulkRejectModal'); return; }
        var reason = document.getElementById('bulkRejectReason').value.trim();
        fetch('/admin/kyc/bulk-reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids, reason: reason })
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            closeModal('bulkRejectModal');
            if (data.success) {
              window.showAdminToast(bulkResultSummary(data));
              setTimeout(function () { location.reload(); }, data.failed > 0 ? 1500 : 700);
            } else {
              window.alert(data.error || 'সমস্যা হয়েছে');
            }
          })
          .catch(function () { window.alert('সার্ভার এরর'); });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
