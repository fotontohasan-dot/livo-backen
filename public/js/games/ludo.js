// views/games/ludo.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
        <div id="ludoGame">
            <div id="ludoStatus" style="font-weight: bold;">ডাইস রোল করুন!</div>
            <div class="dice-container">
                <div class="dice-box">
                    <div id="dealerDice" class="dice">?</div>
                    <span>ডিলার</span>
                </div>
                <div class="dice-box">
                    <div id="playerDice" class="dice">?</div>
                    <span>আপনি</span>
                </div>
            </div>
        </div>
    `;

const ludoStatus = document.getElementById('ludoStatus');
    const ludoPlayBtn = document.getElementById('mainGameBtn');
    const pDice = document.getElementById('playerDice');
    const dDice = document.getElementById('dealerDice');

    async function playLudo() {
        const amount = parseInt(document.getElementById('betAmount').value);
        const data = await placeBet(amount);
        if (!data || !data.success) return;

        ludoPlayBtn.disabled = true;
        ludoStatus.innerText = 'রোল হচ্ছে...';
        pDice.classList.add('rolling');
        dDice.classList.add('rolling');

        setTimeout(() => {
            pDice.classList.remove('rolling');
            dDice.classList.remove('rolling');

            pDice.innerText = data.gameResult.playerRoll;
            dDice.innerText = data.gameResult.dealerRoll;

            if (data.winAmount > 0) {
                ludoStatus.innerText = `আপনি জিতেছেন! +${data.winAmount}`;
                ludoStatus.style.color = '#10b981';
            } else {
                ludoStatus.innerText = 'আপনি হেরেছেন!';
                ludoStatus.style.color = '#ef4444';
            }
            ludoPlayBtn.disabled = false;
        }, 1500);
    }

    ludoPlayBtn.innerText = 'রোল';
    ludoPlayBtn.onclick = playLudo;
