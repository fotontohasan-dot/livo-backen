// views/games/teen-patti.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
        <div id="teenPattiGame">
            <div id="tpStatus" style="color: #ffd700; font-weight: bold;">বাজি ধরুন!</div>
            <div class="cards-box">
                <div class="player-section">
                    <div id="dealerCard" class="card-display">🂠</div>
                    <span>ডিলার</span>
                </div>
                <div class="player-section">
                    <div id="playerCard" class="card-display">🂠</div>
                    <span>আপনি</span>
                </div>
            </div>
        </div>
    `;

const tpStatus = document.getElementById('tpStatus');
    const tpPlayBtn = document.getElementById('mainGameBtn');
    const pCard = document.getElementById('playerCard');
    const dCard = document.getElementById('dealerCard');

    async function playTP() {
        const amount = parseInt(document.getElementById('betAmount').value);
        const data = await placeBet(amount);
        if (!data || !data.success) return;

        tpPlayBtn.disabled = true;
        tpStatus.innerText = 'কার্ড দেখানো হচ্ছে...';
        pCard.innerText = '🂠';
        dCard.innerText = '🂠';

        setTimeout(() => {
            pCard.innerText = '🃏';
            dCard.innerText = '🃏';

            if (data.winAmount > 0) {
                tpStatus.innerText = `আপনি জিতেছেন! +${data.winAmount}`;
                tpStatus.style.color = '#10b981';
            } else {
                tpStatus.innerText = 'আপনি হেরেছেন!';
                tpStatus.style.color = '#ef4444';
            }
            tpPlayBtn.disabled = false;
        }, 1500);
    }

    tpPlayBtn.innerText = 'খেলুন';
    tpPlayBtn.onclick = playTP;
