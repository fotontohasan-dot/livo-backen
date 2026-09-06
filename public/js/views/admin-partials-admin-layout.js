// views/admin/partials/admin-layout.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

function openMobileSidebar() {
            const sb = document.getElementById('adminSidebar');
            const bd = document.getElementById('adminSidebarBackdrop');
            if (sb) sb.classList.remove('-translate-x-full');
            if (bd) bd.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        }
        function closeMobileSidebar() {
            const sb = document.getElementById('adminSidebar');
            const bd = document.getElementById('adminSidebarBackdrop');
            if (sb) sb.classList.add('-translate-x-full');
            if (bd) bd.classList.add('hidden');
            document.body.style.overflow = '';
        }
        function toggleMobileSidebar() {
            const sb = document.getElementById('adminSidebar');
            if (!sb) return;
            if (sb.classList.contains('-translate-x-full')) openMobileSidebar();
            else closeMobileSidebar();
        }
        // Esc দিয়ে ড্রয়ার বন্ধ — কীবোর্ড ব্যবহারকারীর জন্য ফাঁদ তৈরি হয় না।
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeMobileSidebar();
        });

        // ---- নেভিগেশন গ্রুপ কোলাপস + মনে রাখা ----
        (function () {
            var KEY = 'livoAdminNavOpen';
            function saved() {
                try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
            }
            function store(state) {
                try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
            }
            var state = saved();
            document.querySelectorAll('[data-nav-group]').forEach(function (group) {
                var id = group.getAttribute('data-nav-group');
                var btn = group.querySelector('.nav-group-toggle');
                var body = group.querySelector('.nav-group-items');
                var chev = group.querySelector('.nav-chevron');
                // বর্তমান পেজ যে গ্রুপে, সেটা সবসময় খোলা — সংরক্ষিত অবস্থা তার উপরে যায় না।
                if (btn.getAttribute('aria-expanded') !== 'true' && state[id] === true) {
                    body.classList.remove('hidden');
                    btn.setAttribute('aria-expanded', 'true');
                    if (chev) chev.classList.add('rotate-180');
                }
                btn.addEventListener('click', function () {
                    var open = body.classList.toggle('hidden') === false;
                    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
                    if (chev) chev.classList.toggle('rotate-180', open);
                    state[id] = open;
                    store(state);
                });
            });

            // ---- নেভিগেশন ফিল্টার ----
            var search = document.getElementById('adminNavSearch');
            var noResult = document.getElementById('adminNavNoResult');
            if (search) search.addEventListener('input', function () {
                var q = (search.value || '').trim().toLowerCase();
                var shown = 0;
                document.querySelectorAll('[data-nav-item]').forEach(function (a) {
                    var hit = !q || a.getAttribute('data-nav-text').indexOf(q) !== -1;
                    a.style.display = hit ? '' : 'none';
                    if (hit) shown++;
                });
                document.querySelectorAll('[data-nav-group]').forEach(function (g) {
                    var body = g.querySelector('.nav-group-items');
                    var any = Array.prototype.slice.call(g.querySelectorAll('[data-nav-item]'))
                        .some(function (a) { return a.style.display !== 'none'; });
                    g.style.display = any ? '' : 'none';
                    // সার্চ চলাকালীন মিলে যাওয়া গ্রুপ জোর করে খোলা হয়, নাহলে
                    // ফলাফল কোলাপস করা গ্রুপের ভেতরে লুকিয়ে থাকত।
                    if (q && any) body.classList.remove('hidden');
                });
                if (noResult) noResult.classList.toggle('hidden', shown !== 0);
            });
        })();

        // ---- সাইডবার ব্যাজ (pending queue counts) ----
        // /admin/pending-counts আগেই ছিল কিন্তু সাইডবারে কোনো ব্যাজ ছিল না —
        // অ্যাডমিনকে জানতে হলে পেজে ঢুকতে হতো। এখন KYC ও পেমেন্ট কিউয়ের
        // সংখ্যা নেভিগেশনেই দেখা যায়। শূন্য হলে ব্যাজ লুকানো থাকে।
        (function () {
            function paint(cls, n) {
                document.querySelectorAll('.nav-badge-' + cls).forEach(function (el) {
                    if (n > 0) { el.textContent = n > 99 ? '99+' : n; el.classList.remove('hidden'); }
                    else { el.classList.add('hidden'); }
                });
            }
            function refresh() {
                fetch('/admin/pending-counts', { credentials: 'same-origin' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) {
                        if (!d || !d.success) return;
                        paint('kyc', d.kyc || 0);
                        paint('payments', (d.deposits || 0) + (d.withdrawals || 0));
                    })
                    .catch(function () { /* ব্যাজ ব্যর্থ হলে নেভিগেশন আগের মতোই কাজ করে */ });
            }
            refresh();
            setInterval(refresh, 60000);
        })();
        
        function logout() {
            if (confirm('Are you sure you want to logout?')) {
                window.location.href = '/admin/logout';
            }
        }
        
        // Tailwind script
        function initTailwind() {
            document.documentElement.style.setProperty('--accent', '#3b82f6');
        }
        
        // সাইডবার ও লগআউট — আগে ইনলাইন onclick ছিল (docs/CSP.md ধাপ ২)।
        document.addEventListener('DOMContentLoaded', function () {
            var actions = {
                'close-sidebar': closeMobileSidebar,
                'toggle-sidebar': toggleMobileSidebar,
                'logout': logout
            };
            document.querySelectorAll('[data-admin-nav]').forEach(function (el) {
                var fn = actions[el.getAttribute('data-admin-nav')];
                if (fn) el.addEventListener('click', fn);
            });
        });

        window.onload = function() {
            initTailwind();
        }
