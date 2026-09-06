// views/games/color-prediction.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
  <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;background:linear-gradient(180deg,#0a0a0a,#0a001a);padding:20px;">
    <div id="cpResult" style="font-size:50px;font-weight:900;min-height:60px;">🎯</div>
    <div id="cpStatus" style="font-size:15px;color:#ffd700;font-weight:700;">রং বেছে বাজি ধরুন!</div>
    <div style="display:flex;gap:20px;">
      <button data-game-select="red" id="btn-red" style="width:75px;height:75px;border-radius:50%;background:#e60000;border:3px solid transparent;cursor:pointer;font-size:26px;">🔴</button>
      <button data-game-select="violet" id="btn-violet" style="width:75px;height:75px;border-radius:50%;background:#7c3aed;border:3px solid transparent;cursor:pointer;font-size:26px;">🟣</button>
      <button data-game-select="green" id="btn-green" style="width:75px;height:75px;border-radius:50%;background:#10b981;border:3px solid transparent;cursor:pointer;font-size:26px;">🟢</button>
    </div>
    <div style="display:flex;gap:15px;font-size:12px;color:#888;">
      <span>🔴 লাল = 2x</span><span>🟣 বেগুনি = 3x</span><span>🟢 সবুজ = 2x</span>
    </div>
    <div id="selectedColor" style="font-size:13px;color:#888;">কোনো রং সিলেক্ট করা হয়নি</div>
  </div>
`;
let selectedColor=null;
function selectColor(color){
  selectedColor=color;
  ['red','violet','green'].forEach(c=>document.getElementById('btn-'+c).style.border='3px solid transparent');
  document.getElementById('btn-'+color).style.border='3px solid #ffd700';
  const names={red:'লাল 🔴',violet:'বেগুনি 🟣',green:'সবুজ 🟢'};
  document.getElementById('selectedColor').innerText='সিলেক্ট: '+names[color];
}
document.getElementById('mainGameBtn').addEventListener('click',async()=>{
  if(!selectedColor){alert('আগে একটা রং বেছে নিন!');return;}
  const amount=parseInt(document.getElementById('betAmount').value);
  if(isNaN(amount)||amount<10){alert('ন্যূনতম বাজি ১০ কয়েন');return;}
  document.getElementById('mainGameBtn').disabled=true;
  document.getElementById('cpResult').innerText='⏳';
  document.getElementById('cpStatus').innerText='খেলা চলছে...';
  const data=await placeBet(amount,selectedColor);
  if(!data){document.getElementById('mainGameBtn').disabled=false;return;}
  const emojis={red:'🔴',violet:'🟣',green:'🟢'};
  setTimeout(()=>{
    document.getElementById('cpResult').innerText=emojis[data.gameResult.winColor]||'🔴';
    if(data.winAmount>0){document.getElementById('cpStatus').innerText=`🎉 জিতেছেন! +${data.winAmount} কয়েন`;document.getElementById('cpStatus').style.color='#10b981';}
    else{document.getElementById('cpStatus').innerText=`😢 হেরেছেন! -${amount} কয়েন`;document.getElementById('cpStatus').style.color='#e60000';}
    selectedColor=null;
    ['red','violet','green'].forEach(c=>document.getElementById('btn-'+c).style.border='3px solid transparent');
    document.getElementById('selectedColor').innerText='কোনো রং সিলেক্ট করা হয়নি';
    setTimeout(()=>{document.getElementById('cpStatus').innerText='রং বেছে বাজি ধরুন!';document.getElementById('cpStatus').style.color='#ffd700';document.getElementById('cpResult').innerText='🎯';document.getElementById('mainGameBtn').disabled=false;},2500);
  },1500);
});

// ডেলিগেটেড [data-game-select] hook (public/js/ui-hooks.js) এই ফাংশনটা ডাকে।
window.LivoGameSelect = selectColor;
