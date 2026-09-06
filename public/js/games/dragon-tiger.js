// views/games/dragon-tiger.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
  <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:linear-gradient(180deg,#0a0a0a,#1a0000);padding:15px;">
    <div id="dtStatus" style="color:#ffd700;font-weight:700;font-size:15px;">ড্রাগন না টাইগার?</div>
    <div style="display:flex;gap:30px;align-items:center;">
      <div style="text-align:center;">
        <div id="dragonCard" style="width:70px;height:100px;background:#1e1e1e;border:2px solid #e60000;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:30px;">🐉</div>
        <div style="color:#e60000;font-weight:700;margin-top:5px;">ড্রাগন</div>
      </div>
      <div style="font-size:25px;color:#ffd700;">VS</div>
      <div style="text-align:center;">
        <div id="tigerCard" style="width:70px;height:100px;background:#1e1e1e;border:2px solid #ff8800;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:30px;">🐯</div>
        <div style="color:#ff8800;font-weight:700;margin-top:5px;">টাইগার</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <button data-game-select="Dragon" id="btnDragon" style="padding:10px 20px;background:#1e1e1e;color:#e60000;border:2px solid #e60000;border-radius:8px;cursor:pointer;font-weight:700;">🐉 ড্রাগন (2x)</button>
      <button data-game-select="Tie" id="btnTie" style="padding:10px 20px;background:#1e1e1e;color:#ffd700;border:2px solid #ffd700;border-radius:8px;cursor:pointer;font-weight:700;">🤝 টাই (8x)</button>
      <button data-game-select="Tiger" id="btnTiger" style="padding:10px 20px;background:#1e1e1e;color:#ff8800;border:2px solid #ff8800;border-radius:8px;cursor:pointer;font-weight:700;">🐯 টাইগার (2x)</button>
    </div>
  </div>
`;

let dtSelected = null;
const cardValues = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const cardSuits = ['♠','♥','♦','♣'];

function randomCard() {
  return cardValues[Math.floor(Math.random()*13)] + cardSuits[Math.floor(Math.random()*4)];
}

function selectDT(side, el) {
  dtSelected = side;
  ['btnDragon','btnTie','btnTiger'].forEach(id => {
    document.getElementById(id).style.opacity = '0.5';
  });
  el.style.opacity = '1';
  el.style.transform = 'scale(1.05)';
  document.getElementById('dtStatus').innerText = side + ' বেছে নেওয়া হয়েছে!';
}

document.getElementById('mainGameBtn').addEventListener('click', async () => {
  if (!dtSelected) { alert('আগে একটা সাইড বেছে নিন!'); return; }
  const amount = parseInt(document.getElementById('betAmount').value);
  if (isNaN(amount) || amount < 10) { alert('ন্যূনতম বাজি ১০ কয়েন'); return; }

  document.getElementById('mainGameBtn').disabled = true;
  document.getElementById('dtStatus').innerText = 'কার্ড ডিল হচ্ছে...';
  document.getElementById('dragonCard').innerText = '🂠';
  document.getElementById('tigerCard').innerText = '🂠';

  const data = await placeBet(amount, dtSelected);
  if (!data) { document.getElementById('mainGameBtn').disabled = false; return; }

  setTimeout(() => {
    const dc = randomCard();
    const tc = randomCard();
    document.getElementById('dragonCard').innerHTML = `<div style="font-size:16px;font-weight:700;">${dc}</div>`;
    document.getElementById('tigerCard').innerHTML = `<div style="font-size:16px;font-weight:700;">${tc}</div>`;

    if (data.winAmount > 0) {
      document.getElementById('dtStatus').innerText = `🎉 জিতেছেন! +${data.winAmount} কয়েন`;
      document.getElementById('dtStatus').style.color = '#10b981';
    } else {
      document.getElementById('dtStatus').innerText = `😢 হেরেছেন! -${amount} কয়েন`;
      document.getElementById('dtStatus').style.color = '#e60000';
    }

    dtSelected = null;
    ['btnDragon','btnTie','btnTiger'].forEach(id => {
      document.getElementById(id).style.opacity = '1';
      document.getElementById(id).style.transform = 'scale(1)';
    });

    setTimeout(() => {
      document.getElementById('dtStatus').innerText = 'ড্রাগন না টাইগার?';
      document.getElementById('dtStatus').style.color = '#ffd700';
      document.getElementById('dragonCard').innerText = '🐉';
      document.getElementById('tigerCard').innerText = '🐯';
      document.getElementById('mainGameBtn').disabled = false;
    }, 2500);
  }, 1500);
});

// ডেলিগেটেড [data-game-select] hook (public/js/ui-hooks.js) এই ফাংশনটা ডাকে।
window.LivoGameSelect = selectDT;
