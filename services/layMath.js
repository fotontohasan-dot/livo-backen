// services/layMath.js
// ---------------------------------------------------------------------------
// Back/Lay বাজির অর্থের হিসাব এক জায়গায়, যাতে বেট নেওয়া, সেটেলমেন্ট আর
// রিপোর্ট একই সূত্র ব্যবহার করে।
//
// Back : স্টেক S, অডস O  → জিতলে S × O ফেরত (স্টেক সহ), হারলে ০।
// Lay  : ব্যাকারের স্টেক S, লে-অডস O
//        লায়াবিলিটি L = S × (O − 1) — বাজির সময়ই ব্যালেন্স থেকে কাটা হয়।
//        রানার হারলে (লে জিতলে) S + L ফেরত, রানার জিতলে ০।
// সব হিসাব সেন্ট (অডস × ১০০) পূর্ণসংখ্যায়, যাতে ফ্লোটিং-পয়েন্ট ভুল না ঢোকে।
// ---------------------------------------------------------------------------

function oddCents(odd) {
  return Math.round(Number(odd) * 100);
}

// লে-বাজির ঝুঁকি (লায়াবিলিটি), ২ দশমিক পর্যন্ত নির্ভুল
function liabilityFor(stake, odd) {
  const cents = Number(stake) * (oddCents(odd) - 100);
  return cents / 100;
}

// বাজি জিতলে ব্যালেন্সে কত ফেরত যাবে
function payoutFor(bet) {
  if (bet && bet.side === 'lay') {
    return (Math.round(Number(bet.stake) * 100) + Math.round(Number(bet.liability || 0) * 100)) / 100;
  }
  return Math.floor(Number(bet.stake) * Number(bet.odd));
}

// winning_runner দিয়ে বাজিটা জিতল কি না
function betWins(bet, winningRunner) {
  const same = String(bet.runner) === String(winningRunner);
  return bet && bet.side === 'lay' ? !same : same;
}

module.exports = { liabilityFor, payoutFor, betWins, oddCents };
