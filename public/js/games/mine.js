// views/games/mine.ejs-এর গেম লজিক।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে আনা হয়েছে,
// যাতে CSP-র script-src থেকে ভবিষ্যতে unsafe-inline সরানো যায়।
// কোনো সার্ভার-সাইড মান লাগে না, তাই ফাইলটা স্ট্যাটিকভাবে পরিবেশিত হয়।

document.getElementById('gameUI').innerHTML = `
  <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:10px;background:linear-gradient(180deg,#0a0a0a,#001a1a);">
    <div id="mineStatus" style="color:#ffd700;font-weight:700;font-size:14px;">💣 মাইন এড়িয়ে 💎 ডায়মন্ড খুঁজুন!</div>
    <div id="mineGrid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:5px;width:100%;max-width:270px;"></div>
    <div id="mineMulti" style="font-size:13px;color:#888;">মাল্টিপ্লায়ার: 1.00x</div>
    <button id="cashoutBtn" style="display:none;background:#10b981;color:#fff;border:none;padding:8px 20px;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px;">💰 Cash Out</button>
  </div>
`;
const GRID_SIZE=25,MINES=5;
let revealed=[],minePositions=[],gameActive=false,currentMultiplier=1.0,betAmount=0;
function initGrid(){
  revealed=new Array(GRID_SIZE).fill(false);minePositions=[];
  while(minePositions.length<MINES){const pos=Math.floor(Math.random()*GRID_SIZE);if(!minePositions.includes(pos))minePositions.push(pos);}
  currentMultiplier=1.0;document.getElementById('mineMulti').innerText='মাল্টিপ্লায়ার: 1.00x';document.getElementById('cashoutBtn').style.display='none';
  const grid=document.getElementById('mineGrid');grid.innerHTML='';
  for(let i=0;i<GRID_SIZE;i++){const cell=document.createElement('button');cell.style.cssText='width:100%;aspect-ratio:1;background:#1e1e1e;border:1px solid #333;border-radius:6px;font-size:16px;cursor:pointer;';cell.innerText='❓';cell.onclick=()=>revealCell(i,cell);grid.appendChild(cell);}
}
function revealCell(index,cell){
  if(!gameActive||revealed[index])return;revealed[index]=true;
  if(minePositions.includes(index)){cell.innerText='💣';cell.style.background='#3a0000';gameOver();}
  else{cell.innerText='💎';cell.style.background='#0a2a1a';currentMultiplier=parseFloat((currentMultiplier*1.2).toFixed(2));document.getElementById('mineMulti').innerText=`মাল্টিপ্লায়ার: ${currentMultiplier}x`;document.getElementById('cashoutBtn').style.display='block';document.getElementById('mineStatus').innerText=`💎 ভালো! আরো খুঁজুন বা Cash Out করুন`;}
}
function gameOver(){
  gameActive=false;document.getElementById('mineStatus').innerText='💥 বোমা! হেরেছেন!';document.getElementById('mineStatus').style.color='#e60000';document.getElementById('cashoutBtn').style.display='none';document.getElementById('mainGameBtn').disabled=false;
  minePositions.forEach(pos=>{document.getElementById('mineGrid').children[pos].innerText='💣';document.getElementById('mineGrid').children[pos].style.background='#3a0000';});
}
document.getElementById('cashoutBtn').addEventListener('click',async()=>{
  if(!gameActive)return;gameActive=false;
  const winAmt=Math.floor(betAmount*currentMultiplier);await recordWin(currentMultiplier);
  document.getElementById('mineStatus').innerText=`🎉 Cash Out! +${winAmt} কয়েন`;document.getElementById('mineStatus').style.color='#10b981';document.getElementById('cashoutBtn').style.display='none';document.getElementById('mainGameBtn').disabled=false;
});
document.getElementById('mainGameBtn').addEventListener('click',async()=>{
  betAmount=parseInt(document.getElementById('betAmount').value);
  if(isNaN(betAmount)||betAmount<10){alert('ন্যূনতম বাজি ১০ কয়েন');return;}
  const data=await placeBet(betAmount);if(!data)return;
  document.getElementById('mainGameBtn').disabled=true;document.getElementById('mineStatus').style.color='#ffd700';gameActive=true;initGrid();document.getElementById('mineStatus').innerText='💣 মাইন এড়িয়ে 💎 ডায়মন্ড খুঁজুন!';
});
initGrid();
