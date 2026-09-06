// views/games/dice.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
  <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;background:linear-gradient(180deg,#0a0a0a,#0a0a1a);padding:15px;">
    <div id="diceStatus" style="color:#ffd700;font-weight:700;font-size:15px;">ডাইসের মোট কত হবে আন্দাজ করুন</div>
    <div style="display:flex;gap:15px;align-items:center;">
      <div id="dice1" style="width:70px;height:70px;background:#fff;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:40px;box-shadow:0 4px 10px rgba(0,0,0,0.5);">🎲</div>
      <div style="color:#ffd700;font-size:25px;font-weight:900;">+</div>
      <div id="dice2" style="width:70px;height:70px;background:#fff;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:40px;box-shadow:0 4px 10px rgba(0,0,0,0.5);">🎲</div>
    </div>
    <div id="diceTotal" style="font-size:30px;font-weight:900;color:#fff;min-height:40px;"></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:280px;">
      <button data-game-select="low" id="dBtnLow" style="padding:10px;background:#1e1e1e;color:#10b981;border:2px solid #10b981;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;">LOW<br><span style='font-size:11px;color:#888'>2-6 (2x)</span></button>
      <button data-game-select="seven" id="dBtnSeven" style="padding:10px;background:#1e1e1e;color:#ffd700;border:2px solid #ffd700;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;">7<br><span style='font-size:11px;color:#888'>ঠিক ৭ (5x)</span></button>
      <button data-game-select="high" id="dBtnHigh" style="padding:10px;background:#1e1e1e;color:#e60000;border:2px solid #e60000;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;">HIGH<br><span style='font-size:11px;color:#888'>8-12 (2x)</span></button>
    </div>
  </div>
`;

const diceFaces = ['⚀','⚁','⚂','⚃','⚄','⚅'];
let diceSelected = null;

function selectDice(opt, el) {
  diceSelected = opt;
  ['dBtnLow','dBtnSeven','dBtnHigh'].forEach(id => {
    document.getElementById(id).style.opacity = '0.5';
  });
  el.style.opacity = '1';
}

document.getElementById('mainGameBtn').addEventListener('click', async () => {
  if (!diceSelected) { alert('একটি অপশন বেছে নিন!'); return; }
  const amount = parseInt(document.getElementById('betAmount').value);
  if (isNaN(amount) || amount < 10) { alert('ন্যূনতম বাজি ১০ কয়েন'); return; }

  document.getElementById('mainGameBtn').disabled = true;
  document.getElementById('diceStatus').innerText = 'ডাইস রোল হচ্ছে...';
  document.getElementById('diceTotal').innerText = '';

  const data = await placeBet(amount, diceSelected);
  if (!data) { document.getElementById('mainGameBtn').disabled = false; return; }

  let rolls = 0;
  const rollInterval = setInterval(() => {
    document.getElementById('dice1').innerText = diceFaces[Math.floor(Math.random()*6)];
    document.getElementById('dice2').innerText = diceFaces[Math.floor(Math.random()*6)];
    if(++rolls > 10) clearInterval(rollInterval);
  }, 100);

  setTimeout(() => {
    clearInterval(rollInterval);
    const d1 = Math.floor(Math.random()*6)+1;
    const d2 = Math.floor(Math.random()*6)+1;
    const total = d1 + d2;
    document.getElementById('dice1').innerText = diceFaces[d1-1];
    document.getElementById('dice2').innerText = diceFaces[d2-1];
    document.getElementById('diceTotal').innerText = `মোট: ${total}`;

    if (data.winAmount > 0) {
      document.getElementById('diceStatus').innerText = `🎉 জিতেছেন! +${data.winAmount} কয়েন`;
      document.getElementById('diceStatus').style.color = '#10b981';
    } else {
      document.getElementById('diceStatus').innerText = `😢 হেরেছেন! মোট ছিল ${total}`;
      document.getElementById('diceStatus').style.color = '#e60000';
    }

    diceSelected = null;
    ['dBtnLow','dBtnSeven','dBtnHigh'].forEach(id => document.getElementById(id).style.opacity = '1');

    setTimeout(() => {
      document.getElementById('diceStatus').innerText = 'ডাইসের মোট কত হবে আন্দাজ করুন';
      document.getElementById('diceStatus').style.color = '#ffd700';
      document.getElementById('diceTotal').innerText = '';
      document.getElementById('dice1').innerText = '🎲';
      document.getElementById('dice2').innerText = '🎲';
      document.getElementById('mainGameBtn').disabled = false;
    }, 2500);
  }, 1500);
});

// ডেলিগেটেড [data-game-select] hook (public/js/ui-hooks.js) এই ফাংশনটা ডাকে।
window.LivoGameSelect = selectDice;
