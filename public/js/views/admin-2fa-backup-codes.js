// views/admin/2fa-backup-codes.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: আগে ইনলাইন ব্লক ছিল আর সার্ভার-সাইড মান সরাসরি
// JS স্ট্রিং-এর ভেতরে ইনজেক্ট হত। EJS-এর আউটপুট ট্যাগ HTML-এস্কেপ করে, যা
// JS কনটেক্সটের জন্য সঠিক নয়। এখন মানগুলো JSON ডেটা ব্লক থেকে আসে —
// JSON.parse বাদে আর কোনো ব্যাখ্যা লাগে না।

(function(){
  var cfg = {};
  var el = document.getElementById('admin-2fa-backup-codesConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function copyAll() {
              const codes = cfg.codes || [];
              navigator.clipboard.writeText(codes.join('\n')).then(() => {
                  const btn = document.getElementById('copyBtn');
                  btn.innerHTML = '<i class="fas fa-check"></i> কপি হয়েছে!';
                  setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i> সব কোড কপি করুন'; }, 2000);
              });
          }
      
  // আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-copy-all]').forEach(function (el) {
      el.addEventListener('click', copyAll);
    });
  });
})();
