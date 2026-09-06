// views/admin/games.ejs-এর আচরণ। আগে একটা ইনলাইন <script> ব্লক আর ১১টা
// ইনলাইন onclick/onchange/onsubmit হ্যান্ডলার ছিল।
//
// সবচেয়ে ভঙ্গুর অংশটা ছিল এডিট বাটন: প্রতিটা গেমের সাতটা ফিল্ড `','` দিয়ে
// জোড়া দিয়ে একটা স্ট্রিং বানিয়ে `onclick="openEdit('...')"`-এর ভেতরে বসানো
// হত। গেমের নামে একটা apostrophe থাকলেই আর্গুমেন্ট তালিকা ভেঙে যেত (esc()
// HTML-escape করে, JS-string-escape নয়)। এখন গেমের ডেটা একটা
// <script type="application/json"> ব্লকে যায় আর বাটন শুধু id বহন করে।
//
// docs/CSP.md, ধাপ ২।

(function () {
  'use strict';

  var gamesById = {};

  function readJsonBlock(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }

  function setValue(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value == null ? '' : value;
  }

  function openEdit(game) {
    if (!game) return;
    var title = document.getElementById('editTitle');
    if (title) title.textContent = 'গেম এডিট: ' + (game.name || '');
    var form = document.getElementById('editForm');
    if (form) form.action = '/admin/games/' + encodeURIComponent(game.id) + '/edit';
    setValue('e_name', game.name);
    setValue('e_slug', game.slug);
    setValue('e_emoji', game.emoji);
    setValue('e_category', game.category);
    setValue('e_provider', game.provider);
    setValue('e_badge', game.badge);
    document.getElementById('editModal').classList.remove('hidden');
  }

  function toggleAll(cb) {
    document.querySelectorAll('.row-check').forEach(function (c) { c.checked = cb.checked; });
  }

  function setBulk(action) {
    var checked = document.querySelectorAll('.row-check:checked');
    if (!checked.length) { window.alert('কোনো গেম নির্বাচিত হয়নি'); return; }
    var verb = action === 'activate' ? 'সক্রিয়' : 'নিষ্ক্রিয়';
    if (!window.confirm(checked.length + 'টি গেম ' + verb + ' করবেন?')) return;
    document.getElementById('bulkAction').value = action;
    document.getElementById('bulkForm').submit();
  }

  function init() {
    (readJsonBlock('gamesData') || []).forEach(function (g) {
      if (g && g.id != null) gamesById[String(g.id)] = g;
    });

    // মডাল খোলা/বন্ধ, data-auto-submit ও data-confirm এখন
    // public/js/admin-ui-hooks.js সামলায় (admin-layout থেকে লোড হয়)।
    // এখানে আবার বাঁধলে হ্যান্ডলার দুবার চলত।

    // এডিট — id থেকে ডেটা লুকআপ
    document.querySelectorAll('[data-edit-game]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openEdit(gamesById[btn.getAttribute('data-edit-game')]);
      });
    });

    // বাল্ক সক্রিয়/নিষ্ক্রিয়
    document.querySelectorAll('[data-bulk-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setBulk(btn.getAttribute('data-bulk-action'));
      });
    });

    // সব নির্বাচন
    document.querySelectorAll('[data-toggle-all]').forEach(function (cb) {
      cb.addEventListener('change', function () { toggleAll(cb); });
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
