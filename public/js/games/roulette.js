// views/games/roulette.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
        <div id="rouletteGame">
            <div id="rouletteStatus" style="color: #ffd700; margin-bottom: 10px;">অপশন বেছে নিন</div>
            <div class="wheel-container">
                <div class="pointer"></div>
                <div id="wheel" class="wheel">🎡</div>
            </div>
            <div class="betting-board">
                <div class="bet-option" data-game-select="Red">লাল</div>
                <div class="bet-option" data-game-select="Black">কালো</div>
                <div class="bet-option" data-game-select="Even">জোড়</div>
                <div class="bet-option" data-game-select="Odd">বিজোড়</div>
            </div>
        </div>
    `;

let selectedOption = null;
    let isSpinningRoulette = false;
    const wheelEl = document.getElementById('wheel');
    const statusEl = document.getElementById('rouletteStatus');
    const playBtn = document.getElementById('mainGameBtn');

    function selectOption(opt, el) {
        if (isSpinningRoulette) return;
        selectedOption = opt;
        document.querySelectorAll('.bet-option').forEach(btn => btn.classList.remove('active'));
        el.classList.add('active');
        statusEl.innerText = opt + ' বেছে নেওয়া হয়েছে';
    }

    async function spinRoulette() {
        if (isSpinningRoulette || !selectedOption) {
            alert('একটি অপশন বেছে নিন');
            return;
        }

        const amount = parseInt(document.getElementById('betAmount').value);

        // Get secure result from server
        const data = await placeBet(amount, selectedOption);
        if (!data || !data.success) return;

        isSpinningRoulette = true;
        playBtn.disabled = true;
        statusEl.innerText = 'ঘুরছে...';

        const rotation = 1440 + Math.random() * 360;
        wheelEl.style.transform = `rotate(${rotation}deg)`;

        setTimeout(() => {
            const result = data.gameResult.result;
            statusEl.innerText = 'ফলাফল: ' + result;

            if (data.winAmount > 0) {
                statusEl.innerText = `আপনি জিতেছেন! +${data.winAmount}`;
            } else {
                statusEl.innerText = 'আপনি হেরেছেন!';
            }

            isSpinningRoulette = false;
            playBtn.disabled = false;
            wheelEl.style.transition = 'none';
            wheelEl.style.transform = 'rotate(0deg)';
            setTimeout(() => { wheelEl.style.transition = 'transform 4s cubic-bezier(0.1, 0, 0.1, 1)'; }, 50);
        }, 4000);
    }

    playBtn.innerText = 'স্পিন';
    playBtn.onclick = spinRoulette;

// ডেলিগেটেড [data-game-select] hook (public/js/ui-hooks.js) এই ফাংশনটা ডাকে।
window.LivoGameSelect = selectOption;
