// views/games/andar-bahar.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
        <div id="andarBaharGame">
            <div id="abStatus" style="color: #ffd700; margin-bottom: 10px;">জোকার এবং সাইড বেছে নিন</div>
            <div class="joker-card">
                <div class="playing-card">🃏</div>
                <small>জোকার</small>
            </div>
            <div class="cards-container">
                <div class="card-slot" id="slotAndar">
                    <div id="andarCard" class="playing-card" style="visibility: hidden;">🂠</div>
                    <span>অন্দর</span>
                </div>
                <div class="card-slot" id="slotBahar">
                    <div id="baharCard" class="playing-card" style="visibility: hidden;">🂠</div>
                    <span>বাহার</span>
                </div>
            </div>
            <div class="bet-options">
                <div class="bet-opt" data-game-select="Andar">অন্দর</div>
                <div class="bet-opt" data-game-select="Bahar">বাহার</div>
            </div>
        </div>
    `;

let selectedAB = null;
    let isPlayingAB = false;
    const statusAB = document.getElementById('abStatus');
    const playBtnAB = document.getElementById('mainGameBtn');

    function selectAB(opt, el) {
        if (isPlayingAB) return;
        selectedAB = opt;
        document.querySelectorAll('.bet-opt').forEach(btn => btn.classList.remove('active'));
        el.classList.add('active');
        statusAB.innerText = opt + ' বেছে নেওয়া হয়েছে';
    }

    async function playAB() {
        if (isPlayingAB || !selectedAB) {
            alert('অন্দর বা বাহার বেছে নিন');
            return;
        }

        const amount = parseInt(document.getElementById('betAmount').value);
        const data = await placeBet(amount, selectedAB);
        if (!data || !data.success) return;

        isPlayingAB = true;
        playBtnAB.disabled = true;
        statusAB.innerText = 'কার্ড ডিল হচ্ছে...';

        const andarCard = document.getElementById('andarCard');
        const baharCard = document.getElementById('baharCard');
        andarCard.style.visibility = 'hidden';
        baharCard.style.visibility = 'hidden';

        setTimeout(() => {
            const winSide = data.gameResult.winSide;
            if (winSide === 'Andar') {
                andarCard.innerText = '🂡';
                andarCard.style.visibility = 'visible';
            } else {
                baharCard.innerText = '🂡';
                baharCard.style.visibility = 'visible';
            }

            if (data.winAmount > 0) {
                statusAB.innerText = `আপনি জিতেছেন! +${data.winAmount}`;
            } else {
                statusAB.innerText = 'আপনি হেরেছেন!';
            }

            isPlayingAB = false;
            playBtnAB.disabled = false;
        }, 2000);
    }

    playBtnAB.innerText = 'ডিল';
    playBtnAB.onclick = playAB;

// ডেলিগেটেড [data-game-select] hook (public/js/ui-hooks.js) এই ফাংশনটা ডাকে।
window.LivoGameSelect = selectAB;
