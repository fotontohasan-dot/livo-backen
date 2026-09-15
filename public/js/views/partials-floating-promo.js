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

  // ===== WebP support detection + resolver =====
  // Accepts either a plain PNG path string, or an { webp, src } pair.
  // Falls back to the 3200px PNG (`p.src` / the string itself) whenever
  // WebP isn't supported or the WebP file 404s.
  var _webpSupport = null;
  function supportsWebP(){
    if (_webpSupport !== null) return _webpSupport;
    try {
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      _webpSupport = canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { _webpSupport = false; }
    return _webpSupport;
  }
  function pngFallbackOf(p){ return (typeof p === 'string') ? p : p.src; }
  function resolveImgSrc(p){
    if (typeof p === 'string') {
      // Derive the WebP variant from the PNG path, e.g. foo.png -> foo.webp
      return supportsWebP() ? p.replace(/\.(png|jpe?g)$/i, '.webp') : p;
    }
    return (supportsWebP() && p.webp) ? p.webp : p.src;
  }

  var LP_IMG = cfg.images || [];
  var LP_TIT = ["রহস্যময় পুরস্কার — ৫০০ কোটি টাকা!","সদস্য উদযাপন দিবস","প্রথম জমায় ৫০% পর্যন্ত বোনাস","বন্ধুকে আমন্ত্রণ জানান, পান ৫০০ টাকা"];
  var LP_TXT = ["প্রতি মাসের ২০ তারিখ — ৫০০ কোটি টাকার ফ্রি এক্সক্লুসিভ পুরস্কার, পরবর্তী সৌভাগ্যবান ব্যক্তি হতে পারেন আপনি।","প্রতি মাসের ১০ তারিখ — ৮০০ কোটি টাকার নগদ পুরস্কার, যত বেশি বাজি তত বেশি ভাগ্যবান।","আপনার প্রথম জমায় সর্বোচ্চ ৫০% পর্যন্ত বোনাস — একটি অনন্য সুযোগ মিস করবেন না।","প্রতিটি বন্ধুর প্রথম ডিপোজিটে আপনি পাবেন ৫০০ টাকা বোনাস, এজেন্ট কমিশন সর্বোচ্চ ১.০% পর্যন্ত।"];
  var lpCur=0, lpSlide=null;
  function lpRender(){
    var b=_g('lpPopupBody'); if(!b) return;
    var raw = LP_IMG[lpCur];
    var chosenSrc = resolveImgSrc(raw);
    var fallbackSrc = pngFallbackOf(raw);
    var img = document.createElement('img');
    img.className = 'pp-img';
    img.src = chosenSrc;
    img.onerror = function(){ this.onerror = null; this.src = fallbackSrc; };
    var caption = document.createElement('div');
    caption.className = 'pp-caption';
    caption.innerHTML = '<h2>'+LP_TIT[lpCur]+'</h2><p>'+LP_TXT[lpCur]+'</p>';
    b.innerHTML = '';
    b.appendChild(img);
    b.appendChild(caption);
    var dt=''; for(var i=0;i<LP_IMG.length;i++) dt+='<span class="'+(i===lpCur?'on':'')+'"></span>'; _g('lpPopupDots').innerHTML=dt;
  }
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

      // ===== 24h localStorage popup gate (replaces the old once-per-session check) =====
      var LP_STORAGE_KEY = 'bk_last_popup';
      var LP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
      var now = Date.now();
      var last = 0;
      try { last = parseInt(localStorage.getItem(LP_STORAGE_KEY), 10) || 0; } catch (e) { last = 0; }
      if (now - last > LP_INTERVAL_MS) {
        setTimeout(function(){
          lpShowPopup();
          try { localStorage.setItem(LP_STORAGE_KEY, String(Date.now())); } catch (e) {}
        }, 1200);
      }

      schedule();
    } catch(e){ console.log('promo err',e); }
  })();
})();
