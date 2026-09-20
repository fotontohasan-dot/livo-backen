// views/partials/announcements.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function livoDismissAnnouncement(id, el) {
      fetch('/announcements/' + id + '/dismiss', { method: 'POST' }).catch(()=>{});
      if (el) el.remove();
    }
  
    // বন্ধ করার বাটন — আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
    // ব্যানারটা closest() দিয়ে খোঁজা হয়, পপআপটা id দিয়ে — দুটো আলাদা
    // কাঠামো, তাই দুটো আলাদা অ্যাট্রিবিউট।
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('[data-dismiss-announcement]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-dismiss-announcement');
          var sel = btn.getAttribute('data-dismiss-target');
          var byId = btn.getAttribute('data-dismiss-id');
          var el = sel ? btn.closest(sel) : (byId ? document.getElementById(byId) : null);
          livoDismissAnnouncement(id, el);
        });
      });

      // ===== bk666 টিকার: রিফ্রেশ ছাড়াই রিয়েল-টাইম আপডেট =====
      var bkNotice = document.getElementById('bkNotice');
      if (!bkNotice) return;

      function loadNotice() {
        fetch('/api/ticker/active')
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var notices = (data && data.notices) || [];
            if (!notices.length) return;
            bkNotice.innerHTML = notices
              .map(function (n) {
                var span = document.createElement('span');
                span.textContent = n.message;
                return span.outerHTML;
              })
              .join('<span class="bk-ticker-sep">&nbsp;&nbsp;★&nbsp;&nbsp;</span>');
            // অ্যানিমেশন রিস্টার্ট — নতুন কন্টেন্ট শুরু থেকে স্ক্রল হয়
            bkNotice.style.animation = 'none';
            void bkNotice.offsetWidth; // reflow
            bkNotice.style.animation = '';
          })
          .catch(function () {});
      }

      if (window.io) {
        var socket = window.io();
        socket.on('new_notice', loadNotice);
      }
    });
