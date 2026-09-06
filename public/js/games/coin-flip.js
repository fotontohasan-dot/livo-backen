// views/games/coin-flip.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
  <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;background:linear-gradient(180deg,#0a0a0a,#1a0a00);">
    <div id="coinEl" style="font-size:90px;transition:all 0.1s;">🪙</div>
    <div id="cfStatus" style="font-size:16px;color:#ffd700;font-weight:700;">হেড না টেইল? (2x)</div>
    <div style="display:flex;gap:20px;">
      <button data-game-select="head" id="btnHead" style="padding:12px 28px;border-radius:8px;background:#1e1e1e;color:#fff;border:2px solid #333;cursor:pointer;font-size:15px;font-weight:600;">👑 হেড</button>
      <button data-game-select="tail" id="btnTail" style="padding:12px 28px;border-radius:8px;background:#1e1e1e;color:#fff;border:2px solid #333;cursor:pointer;font-size:15px;font-weight:600;">🦅 টেইল</button>
    </div>
    <div id="cfSelected" style="font-size:13px;color:#888;">কিছু সিলেক্ট করা হয়নি</div>
  </div>
`;
let cfSelected=null;
function selectSide(side){cfSelected=side;document.getElementById('btnHead').style.borderColor=side==='head'?'#ffd700':'#333';document.getElementById('btnTail').style.borderColor=side==='tail'?'#ffd700':'#333';document.getElementById('cfSelected').innerText='সিলেক্ট: '+(side==='head'?'👑 হেড':'🦅 টেইল');}
document.getElementById('mainGameBtn').addEventListener('click',async()=>{
  if(!cfSelected){alert('আগে হেড বা টেইল বেছে নিন!');return;}
  const amount=parseInt(document.getElementById('betAmount').value);
  if(isNaN(amount)||amount<10){alert('ন্যূনতম বাজি ১০ কয়েন');return;}
  document.getElementById('mainGameBtn').disabled=true;
  const coinEl=document.getElementById('coinEl');let flips=0;
  const flipInterval=setInterval(()=>{coinEl.innerText=flips%2===0?'👑':'🦅';flips++;if(flips>10)clearInterval(flipInterval);},100);
  const data=await placeBet(amount,cfSelected);
  if(!data){clearInterval(flipInterval);document.getElementById('mainGameBtn').disabled=false;return;}
  setTimeout(()=>{
    clearInterval(flipInterval);const result=data.gameResult.result;coinEl.innerText=result==='head'?'👑':'🦅';
    if(data.winAmount>0){document.getElementById('cfStatus').innerText=`🎉 জিতেছেন! +${data.winAmount} কয়েন`;document.getElementById('cfStatus').style.color='#10b981';}
    else{document.getElementById('cfStatus').innerText=`😢 হেরেছেন! -${amount} কয়েন`;document.getElementById('cfStatus').style.color='#e60000';}
    cfSelected=null;document.getElementById('btnHead').style.borderColor='#333';document.getElementById('btnTail').style.borderColor='#333';document.getElementById('cfSelected').innerText='কিছু সিলেক্ট করা হয়নি';
    setTimeout(()=>{document.getElementById('cfStatus').innerText='হেড না টেইল? (2x)';document.getElementById('cfStatus').style.color='#ffd700';coinEl.innerText='🪙';document.getElementById('mainGameBtn').disabled=false;},2500);
  },1500);
});

// ডেলিগেটেড [data-game-select] hook (public/js/ui-hooks.js) এই ফাংশনটা ডাকে।
window.LivoGameSelect = selectSide;
