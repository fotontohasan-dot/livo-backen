// views/games/play.ejs-এর জেনেরিক গেম UI (যেসব গেমের নিজস্ব টেমপ্লেট নেই)।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('games-playConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  (function(){
          var ui = document.getElementById('gameUI');
          ui.innerHTML =
              '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:linear-gradient(180deg,#0a0a0a,#1a0000);padding:15px;">' +
                  '<div style="font-size:50px;">🎰</div>' +
                  '<div id="g_status" style="color:#ffd700;font-weight:700;font-size:15px;">' + cfg.gameDisplayName + ' - বাজি ধরুন!</div>' +
                  '<div id="g_result" style="font-size:34px;font-weight:900;color:#fff;min-height:44px;"></div>' +
              '</div>';

          var btn = document.getElementById('mainGameBtn');
          var statusEl = document.getElementById('g_status');
          var resultEl = document.getElementById('g_result');
          var defaultStatus = cfg.gameDisplayName + ' - বাজি ধরুন!';

          btn.addEventListener('click', async function(){
              var amount = parseInt(document.getElementById('betAmount').value);
              if (isNaN(amount) || amount < 1) { alert('সর্বনিম্ন ১ কয়েন বাজি ধরুন'); return; }

              btn.disabled = true;
              resultEl.innerText = '⏳';
              statusEl.innerText = 'খেলা চলছে...';
              statusEl.style.color = '#ffd700';

              var data = await placeBet(amount);
              if (!data) { btn.disabled = false; statusEl.innerText = defaultStatus; resultEl.innerText = ''; return; }

              setTimeout(function(){
                  if (data.winAmount > 0) {
                      statusEl.innerText = '🎉 জিতেছেন! +' + data.winAmount + ' কয়েন';
                      statusEl.style.color = '#10b981';
                      resultEl.innerText = '✅';
                  } else {
                      statusEl.innerText = '😢 হেরেছেন! -' + amount + ' কয়েন';
                      statusEl.style.color = '#e60000';
                      resultEl.innerText = '❌';
                  }
                  setTimeout(function(){
                      statusEl.innerText = defaultStatus;
                      statusEl.style.color = '#ffd700';
                      resultEl.innerText = '';
                      btn.disabled = false;
                  }, 2500);
              }, 1200);
          });
      })();
})();
