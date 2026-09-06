// views/games/baccarat.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।

(function(){
  var cfg = {};
  var el = document.getElementById('games-baccaratConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  (function () {
      // লেবেলগুলো সার্ভার-রেন্ডার করা (bn/en দুটোই), তাই ক্লায়েন্টে কোনো
      // হার্ডকোড করা ইউজার-ফেসিং টেক্সট নেই।
      var T = cfg;

      document.getElementById('gameUI').innerHTML =
          '<div id="baccaratGame">' +
              '<div id="bcStatus"></div>' +
              '<div class="bc-cards">' +
                  '<div class="bc-seat"><div id="bcBankerCard" class="bc-card">\u{1F0A0}</div><span>' + T.labels.Banker + '</span></div>' +
                  '<div class="bc-seat"><div id="bcPlayerCard" class="bc-card">\u{1F0A0}</div><span>' + T.labels.Player + '</span></div>' +
              '</div>' +
              '<div id="bcResult" role="status" aria-live="polite"></div>' +
          '</div>';

      // DOM লুকআপ একবারই — প্রতিটা বাজিতে বারবার query করা হয় না
      var statusEl  = document.getElementById('bcStatus');
      var resultEl  = document.getElementById('bcResult');
      var playerCrd = document.getElementById('bcPlayerCard');
      var bankerCrd = document.getElementById('bcBankerCard');
      var betBtn    = document.getElementById('mainGameBtn');
      var amountEl  = document.getElementById('betAmount');
      var options   = Array.prototype.slice.call(document.querySelectorAll('.bc-opt'));

      var selection = null;
      var inFlight  = false;   // ডাবল-ক্লিক / ডাবল-সাবমিট গার্ড

      statusEl.innerText = T.chooseBet;
      betBtn.innerText = T.deal;

      function setSelection(value) {
          if (inFlight) return;
          selection = value;
          options.forEach(function (b) {
              var on = b.getAttribute('data-selection') === value;
              b.setAttribute('aria-checked', on ? 'true' : 'false');
              b.tabIndex = on ? 0 : -1;
          });
          statusEl.innerText = T.labels[value];
      }

      function setBusy(busy) {
          inFlight = busy;
          betBtn.disabled = busy;
          amountEl.disabled = busy;
          options.forEach(function (b) { b.disabled = busy; });
      }

      function show(text, cls) {
          resultEl.className = cls || '';
          resultEl.innerText = text;
      }

      // ইভেন্ট লিসেনার প্রতি অপশনে একটাই — বারবার bind করা হয় না
      options.forEach(function (btn, i) {
          btn.tabIndex = i === 0 ? 0 : -1;
          btn.addEventListener('click', function () { setSelection(btn.getAttribute('data-selection')); });
          // radiogroup-এ তীরচিহ্ন দিয়ে চলাচল — কিবোর্ড ব্যবহারকারীর প্রত্যাশিত আচরণ
          btn.addEventListener('keydown', function (e) {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              var step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
              var next = options[(i + step + options.length) % options.length];
              next.focus();
              setSelection(next.getAttribute('data-selection'));
          });
      });

      async function deal() {
          if (inFlight) return;                       // দ্রুত পরপর ক্লিক — একটাই রিকোয়েস্ট
          if (!selection) { show(T.chooseFirst, 'err'); return; }

          var amount = parseInt(amountEl.value, 10);
          if (isNaN(amount) || amount < 1) { show(T.invalidAmount, 'err'); return; }

          setBusy(true);
          statusEl.innerText = T.placing;
          show('');
          playerCrd.innerText = '\u{1F0A0}';
          bankerCrd.innerText = '\u{1F0A0}';

          var data;
          try {
              // ক্লায়েন্ট শুধু পরিমাণ ও পক্ষ পাঠায় — কোনো পেআউট/গুণিতক/ফলাফল নয়।
              // placeBet() নিজেই HTTP ত্রুটিতে false ফেরত দেয়।
              data = await placeBet(amount, selection);
          } catch (err) {
              data = false;
          }

          if (!data || !data.success) {
              statusEl.innerText = T.chooseBet;
              show(T.failed, 'err');
              setBusy(false);
              return;
          }

          statusEl.innerText = T.dealing;
          var outcome = (data.gameResult && data.gameResult.outcome) || null;
          var won = Number(data.winAmount) > 0;

          setTimeout(function () {
              playerCrd.innerText = '\u{1F0A2}';
              bankerCrd.innerText = '\u{1F0B3}';

              var lines = [
                  T.yourBet + ': ' + T.labels[selection],
                  T.result + ': ' + (outcome ? (T.labels[outcome] || outcome) : '-'),
                  won ? T.win : T.loss
              ];
              if (won) lines.push(T.payout + ': ' + Number(data.winAmount).toFixed(2));

              show(lines.join('\n'), won ? 'win' : 'lose');
              statusEl.innerText = T.chooseBet;
              setBusy(false);
          }, 900);
      }

      betBtn.addEventListener('click', deal);
  })();
})();
