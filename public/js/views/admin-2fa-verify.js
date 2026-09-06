// views/admin/2fa-verify.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function toggleBackup() {
            document.getElementById('totpForm').classList.toggle('hidden');
            document.getElementById('backupForm').classList.toggle('hidden');
        }
        // ৬ ডিজিট হয়ে গেলে অটো-সাবমিট
        const tokenInput = document.querySelector('input[name="token"]');
        if (tokenInput) {
            tokenInput.addEventListener('input', function () {
                this.value = this.value.replace(/\D/g, '');
                if (this.value.length === 6) document.getElementById('totpForm').submit();
            });
        }
    
// আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-toggle-backup]').forEach(function (el) {
    el.addEventListener('click', toggleBackup);
  });
});
