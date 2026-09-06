// views/profile/cards.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function toggleModal(show) {
        const modal = document.getElementById('bottomSheet');
        const overlay = document.getElementById('modalOverlay');
        if (!modal || !overlay) return;
        if (show) {
            modal.classList.add('active');
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        } else {
            modal.classList.remove('active');
            overlay.classList.remove('active');
            document.body.style.overflow = '';
        }
    }
    window.toggleModal = toggleModal;
    document.addEventListener('DOMContentLoaded', function(){
        var fab = document.querySelector('.fab-btn');
        if (fab) fab.addEventListener('click', function(){ toggleModal(true); });
        var ov = document.getElementById('modalOverlay');
        if (ov) ov.addEventListener('click', function(){ toggleModal(false); });
        // শিট বন্ধ করার বাটন — আগে ইনলাইন onclick ছিল।
        document.querySelectorAll('[data-cards-close]').forEach(function (btn) {
            btn.addEventListener('click', function(){ toggleModal(false); });
        });
    });
