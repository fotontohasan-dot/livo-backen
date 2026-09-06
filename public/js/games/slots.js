// views/games/slots.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
        <div id="slotsGame">
            <div id="slotResult"></div>
            <div class="slot-machine">
                <div id="reel1" class="reel">🍒</div>
                <div id="reel2" class="reel">🍒</div>
                <div id="reel3" class="reel">🍒</div>
            </div>
        </div>
    `;

const reels = [document.getElementById('reel1'), document.getElementById('reel2'), document.getElementById('reel3')];
    const resultEl = document.getElementById('slotResult');
    const playBtn = document.getElementById('mainGameBtn');
    const betInp = document.getElementById('betAmount');

    let isSpinning = false;

    async function spin() {
        if (isSpinning) return;

        const amount = parseInt(betInp.value);
        if (isNaN(amount) || amount < 10) {
            alert('ন্যূনতম বাজি ১০ কয়েন');
            return;
        }

        // Get secure result from server
        const data = await placeBet(amount);
        if (!data || !data.success) return;

        isSpinning = true;
        resultEl.innerText = 'স্পিন হচ্ছে...';
        playBtn.disabled = true;

        reels.forEach(reel => reel.classList.add('spinning'));

        // Delay to show animation
        setTimeout(() => {
            const results = data.gameResult.results;

            reels.forEach((reel, i) => {
                reel.classList.remove('spinning');
                reel.innerText = results[i];
            });

            if (data.winAmount > 0) {
                resultEl.innerText = `আপনি জিতেছেন! +${data.winAmount} কয়েন`;
            } else {
                resultEl.innerText = 'আবার চেষ্টা করুন';
            }

            isSpinning = false;
            playBtn.disabled = false;
        }, 2000);
    }

    playBtn.innerText = 'স্পিন';
    playBtn.onclick = spin;
