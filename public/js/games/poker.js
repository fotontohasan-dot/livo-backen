// views/games/poker.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
        <div id="pokerGame">
            <div id="pkStatus" style="color: #ffd700; font-weight: bold;">বাজি ধরুন!</div>
            <div class="cards-box">
                <div class="player-section">
                    <div id="pkDealerCard" class="card-display">🂠</div>
                    <span>ডিলার</span>
                </div>
                <div class="player-section">
                    <div id="pkPlayerCard" class="card-display">🂠</div>
                    <span>আপনি</span>
                </div>
            </div>
        </div>
    `;

const pkStatus = document.getElementById('pkStatus');
    const pkPlayBtn = document.getElementById('mainGameBtn');
    const pkpCard = document.getElementById('pkPlayerCard');
    const pkdCard = document.getElementById('pkDealerCard');

    async function playPK() {
        const amount = parseInt(document.getElementById('betAmount').value);
        const data = await placeBet(amount);
        if (!data || !data.success) return;

        pkPlayBtn.disabled = true;
        pkStatus.innerText = 'কার্ড ডিল হচ্ছে...';
        pkpCard.innerText = '🂠';
        pkdCard.innerText = '🂠';

        setTimeout(() => {
            pkpCard.innerText = '🂱';
            pkdCard.innerText = '🃑';

            if (data.winAmount > 0) {
                pkStatus.innerText = `আপনি জিতেছেন! +${data.winAmount}`;
                pkStatus.style.color = '#10b981';
            } else {
                pkStatus.innerText = 'আপনি হেরেছেন!';
                pkStatus.style.color = '#ef4444';
            }
            pkPlayBtn.disabled = false;
        }, 1500);
    }

    pkPlayBtn.innerText = 'ডিল';
    pkPlayBtn.onclick = playPK;
