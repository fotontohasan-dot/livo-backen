// views/match-detail.ejs-এর বাজি ধরার কোড।
// docs/CSP.md ধাপ ৩: অনুবাদ, লগইন অবস্থা আর ম্যাচ id এখন JSON ডেটা ব্লক
// থেকে আসে। আগে `if (!<%= ... %>)` দিয়ে সার্ভার থেকে সরাসরি JS টোকেন
// লেখা হত — অর্থাৎ টেমপ্লেট মান কোড হয়ে যেত, স্ট্রিং নয়।

(function(){
  var cfg = {};
  var el = document.getElementById('match-detailConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  document.querySelectorAll('.odds').forEach(btn => {
      btn.addEventListener('click', function() {
        if (!cfg.loggedIn) {
          alert(cfg.loginToBet);
          return;
        }

        const oddText = this.textContent.trim();
        const stake = prompt(cfg.minBetMsg, "50");
        const stakeAmount = parseInt(stake);

        if (!stakeAmount || stakeAmount < 10) {
          alert(cfg.minBetMsg);
          return;
        }

        const confirmMsg = String(cfg.betConfirmMsg).replace('{odd}', oddText).replace('{stake}', stakeAmount);
        if (!confirm(confirmMsg)) return;

        fetch('/matches/' + encodeURIComponent(cfg.matchId) + '/bet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            market_id: this.dataset.marketId,
            runner: this.dataset.runner,
            odd: parseFloat(this.dataset.odd),
            stake: stakeAmount
          })
        })
        .then(r => r.json())
        .then(data => {
          alert(data.message || data.error);
          if (data.success) location.reload();
        })
        .catch(() => alert(cfg.networkError));
      });
    });
})();
