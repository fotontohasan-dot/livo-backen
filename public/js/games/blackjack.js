// views/games/blackjack.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
        <div id="blackjackGame">
            <div id="bjStatus" style="color: #ffd700; font-weight: bold;">বাজি ধরুন!</div>
            <div class="cards-box">
                <div class="player-section">
                    <div id="bjDealerCard" class="card-display">🂠</div>
                    <span>ডিলার</span>
                </div>
                <div class="player-section">
                    <div id="bjPlayerCard" class="card-display">🂠</div>
                    <span>আপনি</span>
                </div>
            </div>
        </div>
    `;

const bjStatus = document.getElementById('bjStatus');
    const bjPlayBtn = document.getElementById('mainGameBtn');
    const bjpCard = document.getElementById('bjPlayerCard');
    const bjdCard = document.getElementById('bjDealerCard');

    async function playBJ() {
        const amount = parseInt(document.getElementById('betAmount').value);
        const data = await placeBet(amount);
        if (!data || !data.success) return;

        bjPlayBtn.disabled = true;
        bjStatus.innerText = 'কার্ড ডিল হচ্ছে...';
        bjpCard.innerText = '🂠';
        bjdCard.innerText = '🂠';

        setTimeout(() => {
            bjpCard.innerText = '♠️';
            bjdCard.innerText = '♥️';

            if (data.winAmount > 0) {
                bjStatus.innerText = `আপনি জিতেছেন! +${data.winAmount}`;
                bjStatus.style.color = '#10b981';
            } else {
                bjStatus.innerText = 'আপনি হেরেছেন!';
                bjStatus.style.color = '#ef4444';
            }
            bjPlayBtn.disabled = false;
        }, 1500);
    }

    bjPlayBtn.innerText = 'ডিল';
    bjPlayBtn.onclick = playBJ;
