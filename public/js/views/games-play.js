// views/games/play.ejs-এর বাজি ইঞ্জিন ও ব্যালেন্স।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।
//
// ইচ্ছাকৃতভাবে IIFE-তে মোড়ানো হয়নি। placeBet() ও recordWin() গ্লোবাল
// থাকতেই হবে — public/js/games/-এর ১৭টা গেম স্ক্রিপ্ট এগুলো সরাসরি ডাকে।
// মুড়লে প্রতিটা গেমের বাজি ধরা নীরবে বন্ধ হয়ে যেত।

var cfg = {};
var el = document.getElementById('games-playConfig');
if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

const gameSlug = cfg.gameSlug;
    let currentBalance = cfg.coins;
    let currentDemoBalance = cfg.demoBalance;
    let isDemoMode = false;

    function toggleDemoMode() {
        isDemoMode = !isDemoMode;
        const sw = document.getElementById('demoSwitch');
        const label = document.getElementById('demoLabel');
        sw.classList.toggle('active', isDemoMode);
        label.classList.toggle('active', isDemoMode);
        label.innerText = isDemoMode ? '🎮 ডেমো মোড চালু (কোনো রিয়েল টাকা ব্যবহার হচ্ছে না)' : '🎮 ডেমো মোড (প্র্যাকটিস, রিয়েল টাকা লাগবে না)';
        document.getElementById('userBalance').innerText = isDemoMode ? currentDemoBalance : currentBalance;
    }

    function setBet(amount) {
        var inp = document.getElementById('betAmount');
        if (inp) inp.value = amount;
    }

    // ==================== শেয়ার্ড বাজি ইঞ্জিন ====================
    // LIVO-05: প্রায় ১২০টা গেম ভিউ এই দুটো হেল্পার ব্যবহার করে, তাই এদের ত্রুটি
    // একশোর বেশি গেমে একসাথে দেখা দিত। আগে `response.json()` সরাসরি ডাকা হতো —
    // ৪২৯-এ express-rate-limit v7 প্লেইন টেক্সট পাঠায় আর ৫০০-তে HTML এরর পেজ
    // আসতে পারে; দুটোতেই json() throw করত, catch নীরবে false ফেরত দিত এবং
    // ইউজার কোনো বার্তাই দেখত না। আর `{ error: ... }` আকারের বডিতে
    // `alert(data.message)` আক্ষরিক "undefined" দেখাত।
    //
    // রিটার্ন কনট্রাক্ট ইচ্ছাকৃতভাবে অপরিবর্তিত — সফলে ডেটা, ব্যর্থতায় false —
    // কারণ কলাররা `if (!data) return;` করে। ব্যর্থতার বিস্তারিত জানতে চাইলে
    // window.lastBetError { status, message } পড়া যায় (স্ট্যাটাস ০ = নেটওয়ার্ক)।
    const BET_ERRORS = cfg.betErrors || {};

    // স্ট্যাটাস অনুযায়ী ফলব্যাক বার্তা। সার্ভার নিজে বোধগম্য বার্তা দিলে সেটাই
    // অগ্রাধিকার পায়; নইলে এখান থেকে লোকালাইজড বার্তা যায়।
    function betErrorMessage(status, body) {
        var fromServer = body && typeof body === 'object'
            ? (typeof body.message === 'string' ? body.message
              : (typeof body.error === 'string' ? body.error : null))
            : null;
        if (status === 0) return BET_ERRORS.network;
        if (status === 429) return BET_ERRORS.limited;
        if (status === 401 || status === 403) return fromServer || BET_ERRORS.expired;
        if (status >= 500) return BET_ERRORS.server;
        return fromServer || BET_ERRORS.generic;
    }

    // json() কখনো throw করতে পারে (প্লেইন টেক্সট, HTML, খালি বডি) — তাই সবসময় মুড়ে রাখা
    async function safeJson(response) {
        try { return await response.json(); } catch (e) { return null; }
    }

    async function betRequest(url, payload) {
        var response;
        try {
            response = await fetch(url, {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify(payload)
            });
        } catch (err) {
            window.lastBetError = { status: 0, message: BET_ERRORS.network };
            alert(BET_ERRORS.network);
            return false;
        }

        var data = await safeJson(response);
        if (response.ok && data && data.success) {
            window.lastBetError = null;
            updateBalance(data.newBalance);
            return data;
        }

        var message = betErrorMessage(response.status, data);
        window.lastBetError = { status: response.status, message: message };
        alert(message);
        return false;
    }

    async function placeBet(amount, selection=null) {
        return betRequest('/games/play', { gameSlug, amount, selection, demo: isDemoMode });
    }

    async function recordWin(multiplier) {
        return betRequest('/games/cashout', { gameSlug, multiplier });
    }

    function updateBalance(newBalance) {
        if (isDemoMode) { currentDemoBalance = newBalance; }
        else { currentBalance = newBalance; }
        document.getElementById('userBalance').innerText = newBalance;
    }

    // বাজির প্রিসেট ও ডেমো টগল — আগে ইনলাইন onclick ছিল।
    document.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('[data-set-bet]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setBet(Number(btn.getAttribute('data-set-bet')));
            });
        });
        document.querySelectorAll('[data-toggle-demo]').forEach(function (btn) {
            btn.addEventListener('click', toggleDemoMode);
        });
    });
