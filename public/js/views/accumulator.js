// views/accumulator.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('accumulatorConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  let slip = [];
  const i18n = cfg;

  function boostFor(n){ if(n>=5) return 30; if(n===4) return 20; if(n===3) return 10; return 0; }

  function renderSlip() {
    const box = document.getElementById('betSlip');
    const items = document.getElementById('slipItems');
    document.getElementById('slipCount').innerText = slip.length;
    if (slip.length === 0) { box.style.display='none'; return; }
    box.style.display='block';
    items.innerHTML = slip.map((s,i) =>
      '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:var(--text-muted);">'
      + '<span>'+s.mname+' — '+s.runner+' <span style="color:#f59e0b;">'+s.odd+'</span></span>'
      + '<span data-remove-pick="'+i+'" style="color:#ef4444;cursor:pointer;">✕</span></div>'
    ).join('');

    let totalOdd = slip.reduce((a,s)=>a*parseFloat(s.odd),1);
    const boost = boostFor(slip.length);
    const stake = parseFloat(document.getElementById('slipStake').value) || 0;
    const win = Math.floor(stake * totalOdd * (1 + boost/100));
    document.getElementById('slipInfo').innerText =
      i18n.totalOdds + ': ' + totalOdd.toFixed(2) + (boost>0?(' · ' + i18n.boost + ' +' + boost + '%'):'') + (stake>0?(' · ' + i18n.potentialWin + ': ' + win):'');
  }

  function removePick(i){ slip.splice(i,1); document.querySelectorAll('.acca-pick').forEach(b=>b.style.borderColor=isPicked(b)?'#f59e0b':'#333'); renderSlip(); }
  function clearSlip(){ slip=[]; document.querySelectorAll('.acca-pick').forEach(b=>b.style.borderColor='#333'); renderSlip(); }
  function isPicked(btn){ return slip.some(s=>s.market==btn.dataset.market && s.runner==btn.dataset.runner); }

  document.querySelectorAll('.acca-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = btn.dataset;
      // একই ম্যাচ থেকে আগের সিলেকশন থাকলে সরাও
      const existIdx = slip.findIndex(s => s.match === d.match);
      if (existIdx >= 0 && slip[existIdx].market === d.market && slip[existIdx].runner === d.runner) {
        slip.splice(existIdx,1); // আবার চাপল বাদ
      } else {
        if (existIdx >= 0) slip.splice(existIdx,1); // ওই ম্যাচের পুরোনো বাদ
        slip.push({ match:d.match, market:d.market, mname:d.mname, runner:d.runner, odd:d.odd });
      }
      document.querySelectorAll('.acca-pick').forEach(b=>b.style.borderColor=isPicked(b)?'#f59e0b':'#333');
      renderSlip();
    });
  });

  document.getElementById('slipStake').addEventListener('input', renderSlip);

  async function placeAcca() {
    const stake = parseInt(document.getElementById('slipStake').value);
    if (!stake || stake < 10) { alert(i18n.minStake); return; }
    if (slip.length < 2) { alert(i18n.minSelections); return; }

    const selections = slip.map(s => ({ match_id:s.match, market_id:s.market, market_name:s.mname, runner:s.runner, odd:s.odd }));

    try {
      const res = await fetch('/accumulator/place', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ stake, selections })
      });
      const data = await res.json();
      alert(data.message);
      if (data.success) location.reload();
    } catch(e) {
      alert(i18n.error);
    }
  }

  // বেট স্লিপের সারি রানটাইমে স্ট্রিং জোড়া দিয়ে বানানো হয়, তাই removePick
  // ডেলিগেশনে। স্থির বাটন দুটো সরাসরি (docs/CSP.md ধাপ ২)।
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var rm = e.target.closest('[data-remove-pick]');
    if (rm) { removePick(Number(rm.getAttribute('data-remove-pick'))); return; }
    var btn = e.target.closest('[data-acca-action]');
    if (!btn) return;
    if (btn.getAttribute('data-acca-action') === 'clear') clearSlip();
    else placeAcca();
  });
})();
