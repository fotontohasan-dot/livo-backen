// views/admin/dashboard.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

// Update time
    function updateTime() {
        const el = document.getElementById('current-time');
        if (el) el.textContent = new Date().toLocaleString('en-BD', { hour: 'numeric', minute: '2-digit', hour12: true });
    }
    setInterval(updateTime, 30000);
    updateTime();

    // ডেমো কারেন্সি উইজেট — রিয়েল-টাইম আপডেট
    (function() {
        const socket = io();
        socket.emit('join_admin');
        socket.on('demo_stats_update', function(stats) {
            const map = { 'demo-total': stats.totalDemo, 'demo-held': stats.userHeldDemo, 'demo-casino': stats.casinoDemoWagered, 'demo-sports': stats.sportsDemoWagered };
            Object.keys(map).forEach(function(id) {
                const el = document.getElementById(id);
                if (el) el.textContent = Number(map[id] || 0).toLocaleString('en-US');
            });
        });
    })();
