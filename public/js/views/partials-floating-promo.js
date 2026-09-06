// views/partials/floating-promo.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('partials-floating-promoConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  function _g(id){ return document.getElementById(id); }
  var lpStatus = { redPacket:{claimed:false}, goldenEgg:{claimed:false} };

  function lpShowPromo(){ var pr=_g('lpPromo'); if(pr) pr.classList.remove('hide'); }
  function lpClosePanelFn(){ var p=_g('lpPanel'); if(p) p.classList.remove('open'); lpShowPromo(); }
  window.lpClosePanel = lpClosePanelFn;

  function lpOpenFrame(url){ lpClosePanelFn(); var f=_g('lpFrame'); if(f) f.src=url; var ov=_g('lpFrameOverlay'); if(ov) ov.style.display='flex'; }
  function lpCloseFrame(){ var ov=_g('lpFrameOverlay'); if(ov) ov.style.display='none'; var f=_g('lpFrame'); if(f) f.src='about:blank'; }

  function drOpenRedFn(){ lpClosePanelFn(); var rr=_g('drRedResult'); if(rr) rr.innerHTML=''; var btn=_g('drRedBtn'); if(btn){ if(lpStatus.redPacket.claimed){btn.disabled=true;btn.textContent='আজ নওয়া হয়েছে';}else if(lpStatus.redPacket.locked){btn.disabled=true;btn.textContent='🔒 আজ ডিপোজিট করুন';}else{btn.disabled=false;btn.textContent='দাবি করুন';} } var ov=_g('drRedOverlay'); if(ov) ov.style.display='flex'; }
  function drCloseRedFn(){ var e=_g('drRedOverlay'); if(e) e.style.display='none'; }
  function drClaimRedFn(){ var btn=_g('drRedBtn'); if(!btn) return; btn.disabled=true; btn.textContent='অপেক্ষা করুন...'; fetch('/profile/daily-rewards/red-packet/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(r){return r.json();}).then(function(d){ if(d.ok){ lpStatus.redPacket.claimed=true; _g('drRedResult').innerHTML='<div class="dr-success">🎉 আপনি পেলেন '+d.amount+' কযন!</div>'; btn.textContent='সফল হয়েছে'; if(window.confetti) confetti({particleCount:120,spread:80,origin:{y:0.6}}); setTimeout(drCloseRedFn,2500); }else{ _g('drRedResult').innerHTML='<div class="dr-hint">'+(d.message||'সমস্যা')+'</div>'; btn.disabled=false; btn.textContent='দাব করুন'; } }).catch(function(){ btn.disabled=false; btn.textContent='দাবি করুন'; }); }

  var _eggClaimed=false;
  function drOpenEggFn(){ lpClosePanelFn(); var grid=_g('drEggGrid'); if(grid){ grid.innerHTML=''; for(var i=0;i<8;i++){ var d=document.createElement('div'); d.className='dr-egg-item'; d.innerHTML='<div class="egg-glow"></div><span class="egg-emoji">🥚</span><div class="egg-stand"></div><span class="egg-amt"></span>'; d.onclick=(function(idx){return function(){drPickEgg(idx);};})(i); grid.appendChild(d); } } var hint=_g('drEggHint'); if(hint) hint.textContent='একটি ডিমে চাপ দিন'; var rr=_g('drEggResult'); if(rr) rr.innerHTML=''; _eggClaimed=false; if(lpStatus.goldenEgg.claimed){ if(hint) hint.textContent='আজকের ডিম ইতিমধ্যে নেওয়া হয়েছে'; var items=document.querySelectorAll('#drEggGrid .dr-egg-item'); for(var j=0;j<items.length;j++){ items[j].style.opacity='.4'; items[j].onclick=null; } } else if(lpStatus.goldenEgg.locked){ if(hint) hint.textContent='🔒 ডিম লক করা আছে। আজ ডিপোজিট করুন।'; var items2=document.querySelectorAll('#drEggGrid .dr-egg-item'); for(var k=0;k<items2.length;k++){ items2[k].style.opacity='.4'; items2[k].onclick=null; } } var ov=_g('drEggOverlay'); if(ov) ov.style.display='flex'; }
  function drCloseEggFn(){ var e=_g('drEggOverlay'); if(e) e.style.display='none'; }
  function drPickEgg(idx){ if(_eggClaimed||lpStatus.goldenEgg.claimed) return; _eggClaimed=true; var hint=_g('drEggHint'); if(hint) hint.textContent='অপেক্ষা করুন...'; fetch('/profile/daily-rewards/golden-egg/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pickedIndex:idx})}).then(function(r){return r.json();}).then(function(d){ if(d.ok){ lpStatus.goldenEgg.claimed=true; var items=document.querySelectorAll('#drEggGrid .dr-egg-item'); for(var i=0;i<items.length;i++){ items[i].classList.add('opened'); if(i===d.pickedIndex) items[i].classList.add('win'); items[i].querySelector('.egg-amt').textContent=d.reveal[i]; items[i].onclick=null; } _g('drEggResult').innerHTML='<div class="dr-success">🎉 আপনি পেলেন '+d.amount+' কয়েন!</div>'; if(window.confetti) confetti({particleCount:150,spread:90,origin:{y:0.6}}); if(hint) hint.textContent='অন্যান্য ডিমে আরও বড় পুরস্কার ছিল!'; setTimeout(drCloseEggFn,4000); }else{ if(hint) hint.textContent=d.message||'সমস্যা'; _eggClaimed=false; } }).catch(function(){ _eggClaimed=false; if(hint) hint.textContent='সমস্যা হয়েছে'; }); }

  var LP_IMG = cfg.images || [];
  var LP_TIT = ["সদস্য উদযাপন দিবস","VIP সদস্যদের জন্য আরও সুবিধা","এখনই অযাপ ডাউনলোড করুন"];
  var LP_TXT = ["প্রতি মাসের ১০ তারিখ বিশাল নগদ পুরস্কার!","প্রতি মাসে সর্বোচ্চ বোনাস + সপ্তাহিক রিওয়ার্ড।","অ্যাপ ডাউনলোড করে জিতে নিন আকর্ষণীয় বোনাস!"];
  var lpCur=0, lpSlide=null;
  function lpRender(){ var b=_g('lpPopupBody'); if(!b) return; b.innerHTML='<img class="pp-img" src="'+LP_IMG[lpCur]+'"><div class="pp-caption"><h2>'+LP_TIT[lpCur]+'</h2><p>'+LP_TXT[lpCur]+'</p></div>'; var dt=''; for(var i=0;i<LP_IMG.length;i++) dt+='<span class="'+(i===lpCur?'on':'')+'"></span>'; _g('lpPopupDots').innerHTML=dt; }
  function lpStop(){ if(lpSlide){clearInterval(lpSlide);lpSlide=null;} }
  function lpNextFn(){ lpStop(); if(lpCur<LP_IMG.length-1){lpCur++;lpRender();}else{lpClosePopupFn();} }
  function lpPrevFn(){ lpStop(); if(lpCur>0){lpCur--;lpRender();} }
  function lpClosePopupFn(){ lpStop(); var e=_g('lpPopup'); if(e) e.style.display='none'; }
  function lpShowPopup(){ var e=_g('lpPopup'); if(!e) return; lpCur=0; lpRender(); e.style.display='flex'; var st=1; lpSlide=setInterval(function(){ if(st<LP_IMG.length){lpCur=st;lpRender();st++;}else{lpClosePopupFn();} },1000); }

  function lpTimer(h,m,s){ function tk(){ var n=new Date(); var e=new Date(n); e.setHours(24,0,0,0); var df=Math.max(0,Math.floor((e-n)/1000)); function p(x){return x<10?'0'+x:''+x;} var a=_g(h),b=_g(m),c=_g(s); if(a)a.textContent=p(Math.floor(df/3600)); if(b)b.textContent=p(Math.floor((df%3600)/60)); if(c)c.textContent=p(df%60); } tk(); setInterval(tk,1000); }

  (function(){
    try {
      var promo=_g('lpPromo'), panel=_g('lpPanel'), hideT=null, showT=null;
      function bind(id,fn){ var el=_g(id); if(el) el.addEventListener('click', fn); }
      if(promo){ promo.addEventListener('click', function(){ if(panel){ if(panel.classList.contains('open')){ panel.classList.remove('open'); } else { panel.classList.add('open'); } } schedule(); }); }
      bind('lpBtnClose', lpClosePanelFn);
      bind('lpBtnUp', lpClosePanelFn);
      bind('lpBtnTour', function(){ lpOpenFrame('/tournaments'); });
      bind('lpBtnWheel', function(){ lpOpenFrame('/profile/wheel'); });
      bind('lpBtnEgg', drOpenEggFn);
      bind('lpBtnRed', drOpenRedFn);
      bind('drRedClose', drCloseRedFn);
      bind('drRedBtn', drClaimRedFn);
      bind('drEggClose', drCloseEggFn);
      bind('lpFrameClose', lpCloseFrame);
      bind('lpPopClose', lpClosePopupFn);
      bind('lpPopPrev', lpPrevFn);
      bind('lpPopNext', lpNextFn);
      var ro=_g('drRedOverlay'); if(ro) ro.addEventListener('click', function(e){ if(e.target===ro) drCloseRedFn(); });
      var eo=_g('drEggOverlay'); if(eo) eo.addEventListener('click', function(e){ if(e.target===eo) drCloseEggFn(); });
      var fo=_g('lpFrameOverlay'); if(fo) fo.addEventListener('click', function(e){ if(e.target===fo) lpCloseFrame(); });
      var po=_g('lpPopup'); if(po) po.addEventListener('click', function(e){ if(e.target===po) lpClosePopupFn(); });

      function schedule(){ if(!promo) return; if(hideT) clearTimeout(hideT); hideT=setTimeout(function(){ promo.classList.add('hide'); if(panel) panel.classList.remove('open'); if(showT) clearTimeout(showT); showT=setTimeout(function(){ promo.classList.remove('hide'); schedule(); },90000); },90000); }
      lpTimer('drRedH','drRedM','drRedS'); lpTimer('drEggH','drEggM','drEggS');
      fetch('/profile/daily-rewards/status').then(function(r){return r.json();}).then(function(d){ if(d&&d.ok&&d.status) lpStatus=d.status; }).catch(function(){});
      var LP_SESSION_KEY = 'lpPopupShownThisSession';
  var alreadyShown = false;
  try { alreadyShown = sessionStorage.getItem(LP_SESSION_KEY) === '1'; } catch(e) { alreadyShown = false; }
  if (!alreadyShown) {
    setTimeout(function(){ lpShowPopup(); try { sessionStorage.setItem(LP_SESSION_KEY, '1'); } catch(e){} }, 1200);
  }

      schedule();
    } catch(e){ console.log('promo err',e); }
  })();
})();
