// views/payment/deposit.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

// ==================== অ্যাডমিন-নিয়ন্ত্রিত পেমেন্ট মেথড ====================
  // তালিকাটা সবসময় সার্ভার থেকে আসা active সারি থেকে তৈরি হয়। কখনো ক্লায়েন্টে
  // হার্ডকোড করা নম্বর দেখানো হয় না — অ্যাডমিন কোনো নম্বর নিষ্ক্রিয় করলে সেটা
  // এখান থেকে সঙ্গে সঙ্গে অদৃশ্য হয়।
  var PM_META = {
    bkash:  { label: 'bKash',  short: 'bK', color: '#E2136E' },
    nagad:  { label: 'Nagad',  short: 'Ng', color: '#EE3123' },
    rocket: { label: 'Rocket', short: 'Rk', color: '#8C3494' },
    upay:   { label: 'Upay',   short: 'Up', color: '#D4145A' },
    bank:   { label: 'Bank',   short: 'Bk', color: '#334155' },
    crypto: { label: 'Crypto', short: 'Cr', color: '#f59e0b' }
  };

  var activeMethods = [];
  var selectedAccountId = null;
  // স্টেল ইভেন্ট গার্ড — দেরিতে পৌঁছানো পুরনো রেসপন্স যেন নতুন অবস্থাকে
  // চাপা দিতে না পারে (একাধিক socket ইভেন্ট দ্রুত এলে সম্ভব)।
  var refreshSeq = 0;

  function readInitialMethods() {
    try {
      var raw = document.getElementById('activeMethodsData');
      return raw ? (JSON.parse(raw.textContent) || []) : [];
    } catch (e) { return []; }
  }

  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  function renderMethods() {
    var grid = document.getElementById('methodGrid');
    var empty = document.getElementById('methodEmpty');
    var errBox = document.getElementById('methodError');
    if (!grid) return;
    grid.innerHTML = '';

    if (!activeMethods.length) {
      grid.classList.add('hidden');
      if (errBox && !errBox.classList.contains('hidden')) { empty.classList.add('hidden'); }
      else if (empty) empty.classList.remove('hidden');
      selectedAccountId = null;
      updateStep2();
      return;
    }
    grid.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    if (errBox) errBox.classList.add('hidden');

    activeMethods.forEach(function (item) {
      var meta = PM_META[item.method] || { label: item.method, short: '••', color: '#475569' };
      var card = el('div', 'method-card border-2 border-glass bg-surface rounded-2xl p-4 flex flex-col items-center justify-center cursor-pointer');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.dataset.accountId = String(item.id);
      card.dataset.method = item.method;
      // textContent ব্যবহার করা হচ্ছে, innerHTML নয় — DB থেকে আসা মান কখনো
      // HTML হিসেবে ব্যাখ্যা হবে না (XSS)।
      var badge = el('div', 'check-badge'); badge.textContent = '✓';
      var logo = el('div', 'h-12 w-12 rounded-2xl flex items-center justify-center mb-2 shadow-sm');
      logo.style.backgroundColor = meta.color;
      var logoText = el('span', 'text-white font-black text-lg');
      logoText.style.letterSpacing = '-1px';
      logoText.textContent = meta.short;
      logo.appendChild(logoText);
      var name = el('span', 'text-sm font-bold text-main');
      name.textContent = meta.label;
      var num = el('span', 'text-[11px] text-muted font-mono mt-1 break-all text-center');
      num.textContent = item.accountNumber;
      card.appendChild(badge); card.appendChild(logo); card.appendChild(name); card.appendChild(num);
      card.addEventListener('click', function () { selectAccount(item.id); });
      card.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectAccount(item.id); }
      });
      grid.appendChild(card);
    });

    // আগের নির্বাচন এখনো বৈধ কিনা; না হলে প্রথমটা
    var stillThere = activeMethods.some(function (m) { return m.id === selectedAccountId; });
    selectAccount(stillThere ? selectedAccountId : activeMethods[0].id);
  }

  function currentAccount() {
    for (var i = 0; i < activeMethods.length; i++) {
      if (activeMethods[i].id === selectedAccountId) return activeMethods[i];
    }
    return null;
  }

  function selectAccount(id) {
    selectedAccountId = id;
    document.querySelectorAll('.method-card').forEach(function (c) {
      c.classList.toggle('selected', c.dataset.accountId === String(id));
    });
    var acc = currentAccount();
    var hidden = document.getElementById('methodInput');
    if (hidden) hidden.value = acc ? acc.method : '';
    updateStep2();
  }

  function updateStep2() {
    var acc = currentAccount();
    var numEl = document.getElementById('displayNumber');
    var nameEl = document.getElementById('selectedMethodName');
    var submitBtn = document.getElementById('depSubmitBtn');
    var nextBtn = document.getElementById('depNextBtn');
    if (numEl) numEl.textContent = acc ? acc.accountNumber : '—';
    if (nameEl) nameEl.textContent = acc ? ((PM_META[acc.method] || {}).label || acc.method) : '—';
    if (submitBtn) submitBtn.disabled = !acc;
    if (nextBtn) nextBtn.disabled = !acc;
    // অ্যাডমিন নম্বরটা মুছে/নিষ্ক্রিয় করে দিলে ইউজার যেন আর ওই নম্বরের
    // স্ক্রিনে বসে না থাকেন — ধাপ ১-এ ফিরিয়ে আনা হয়।
    if (!acc) {
      var s2 = document.getElementById('step2');
      if (s2 && s2.style.display === 'block') goToStep1();
    }
  }

  function refreshMethods() {
    var seq = ++refreshSeq;
    var loading = document.getElementById('methodLoading');
    if (loading) loading.classList.remove('hidden');
    fetch('/payment/deposit/methods', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (data) {
        if (seq !== refreshSeq) return; // স্টেল রেসপন্স — উপেক্ষা
        if (!data || !data.success) throw new Error('bad payload');
        var errBox = document.getElementById('methodError');
        if (errBox) errBox.classList.add('hidden');
        activeMethods = data.methods || [];
        renderMethods();
      })
      .catch(function () {
        if (seq !== refreshSeq) return;
        var errBox = document.getElementById('methodError');
        // আগের তালিকা থাকলে সেটাই রাখা হয় — একটা ব্যর্থ রিফ্রেশে ইউজারের
        // স্ক্রিন খালি করে দেওয়ার দরকার নেই।
        if (errBox && !activeMethods.length) errBox.classList.remove('hidden');
      })
      .finally(function () {
        if (seq === refreshSeq && loading) loading.classList.add('hidden');
      });
  }

  function selectChannel(el) {
    document.querySelectorAll('.channel-btn').forEach(b => {
      b.classList.remove('selected');
    });
    el.classList.add('selected');
  }

  function setAmount(amt, el) {
    document.getElementById('amountInput').value = amt;
    document.querySelectorAll('.amount-btn').forEach(b => {
      b.classList.remove('selected');
    });
    el.classList.add('selected');
  }

  function goToStep2() {
    if (!currentAccount()) { return; }
    const amt = document.getElementById('amountInput').value;
    if(!amt || amt < 100) {
      alert('সর্বনিম্ন ১০০ টাকা জমা দিন');
      return;
    }
    document.getElementById('step1').style.display = 'none';
    document.getElementById('step2').style.display = 'block';
    window.scrollTo(0,0);
  }

  function goToStep1() {
    document.getElementById('step1').style.display = 'block';
    document.getElementById('step2').style.display = 'none';
  }

  function copyNumber() {
    var acc = currentAccount();
    if (!acc) return;
    var btn = document.getElementById('depCopyBtn');
    var done = function () {
      if (!btn) return;
      var original = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', original);
      btn.textContent = btn.getAttribute('data-copied-label') || 'Copied';
      setTimeout(function () { btn.textContent = original; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(acc.accountNumber).then(done).catch(done);
    } else {
      // পুরনো/insecure-context ব্রাউজারে clipboard API নেই — তখনও কপি কাজ করবে
      var tmp = document.createElement('textarea');
      tmp.value = acc.accountNumber;
      document.body.appendChild(tmp); tmp.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(tmp);
      done();
    }
  }

  document.addEventListener('DOMContentLoaded', function(){
    activeMethods = readInitialMethods();
    renderMethods();

    // ===== রিয়েল-টাইম =====
    // ইভেন্টের পে-লোড বিশ্বাস করা হয় না; সংকেত পেলে সার্ভার থেকে অনুমোদিত
    // তালিকা আবার আনা হয়। দ্রুত পরপর ইভেন্ট এলে debounce করা হয়, যাতে
    // একটা অ্যাডমিন-সেশনের কয়েকটা পরিবর্তন ইভেন্ট-ঝড় তৈরি না করে।
    try {
      if (typeof io === 'function') {
        var pmTimer = null;
        var socket = io({ withCredentials: true });
        socket.on('payment-methods:updated', function () {
          clearTimeout(pmTimer);
          pmTimer = setTimeout(refreshMethods, 400);
        });
        // পুনঃসংযোগে একবারই সিঙ্ক — ডুপ্লিকেট এন্ট্রি হয় না, কারণ তালিকা
        // প্রতিবার সম্পূর্ণ নতুন করে রেন্ডার হয়, append হয় না।
        socket.on('reconnect', refreshMethods);
      }
    } catch (e) {}

    document.querySelectorAll('.amount-btn').forEach(function(b){
      b.addEventListener('click', function(){ setAmount(parseInt(b.getAttribute('data-amt')), b); });
    });
        var nb = document.getElementById('depNextBtn');
    if (nb) nb.addEventListener('click', goToStep2);
    document.querySelectorAll('.channel-btn').forEach(function(b){
      b.addEventListener('click', function(){ selectChannel(b); });
    });
    var cb = document.getElementById('depCopyBtn');
    if (cb) cb.addEventListener('click', copyNumber);
    var bb = document.getElementById('depBackBtn');
    if (bb) bb.addEventListener('click', goToStep1);

    var apBtn = document.getElementById('autoPayBtn');
    if (apBtn) apBtn.addEventListener('click', function () {
      var amt = document.getElementById('amountInput').value;
      if (!amt || amt < 100) { alert('সর্বনিম্ন ১০০ টাকা জমা দিন'); return; }
      var wantBonus = document.getElementById('autoBonusCheck').checked ? 'yes' : 'no';
      var f = document.createElement('form');
      f.method = 'POST';
      f.action = '/payment/sslcommerz/init';
      var csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      f.innerHTML = '<input type="hidden" name="amount" value="' + amt + '">' +
                    '<input type="hidden" name="want_bonus" value="' + wantBonus + '">' +
                    '<input type="hidden" name="_csrf" value="' + csrf + '">';
      document.body.appendChild(f);
      f.submit();
    });
  });

// চ্যানেল কার্ড — আগে প্রতিটাতে ইনলাইন onclick ছিল।
document.querySelectorAll('[data-select-channel]').forEach(function (el) {
  el.addEventListener('click', function () { selectChannel(el); });
});
