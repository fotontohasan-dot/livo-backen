// services/layBet.js
// ---------------------------------------------------------------------------
// Back/Lay bet maths — pure functions, no DB access, so they can be unit-tested
// and shared by the bet route and the settlement engine.
//
//   BACK  risk = stake                      win  -> stake * odd
//   LAY   risk = liability = stake*(odd-1)  win  -> stake (+ liability returned)
//
// All coin amounts are whole coins (bets.stake is INTEGER). Liability is rounded
// UP so the house is never short-changed by rounding.
// ---------------------------------------------------------------------------

function normalizeBetType(raw) {
  const t = String(raw == null ? 'back' : raw).trim().toLowerCase();
  return t === 'lay' ? 'lay' : t === 'back' ? 'back' : null; // null = invalid
}

// round to cents first so 100 * (1.85 - 1) = 85.00000000000001 does not become 86
function calcLiability(stake, layOdd) {
  const raw = Math.round(Number(stake) * (Number(layOdd) - 1) * 100) / 100;
  return Math.ceil(raw);
}

// What the user risks at placement (and what is deducted from the wallet).
function calcRisk(betType, stake, odd) {
  return betType === 'lay' ? calcLiability(stake, odd) : Number(stake);
}

// Total credited back to the wallet if the bet wins (stake returned for back
// bets is already inside stake*odd).
function calcPotentialPayout(betType, stake, odd) {
  if (betType === 'lay') return Number(stake) + calcLiability(stake, odd);
  return Math.floor(Number(stake) * Number(odd));
}

// Did the BET win, given the market's winning runner?
//   back: wins if its runner won      lay: wins if its runner did NOT win
function betWins(bet, winningRunner) {
  const runnerWon = String(bet.runner) === String(winningRunner);
  return bet.bet_type === 'lay' ? !runnerWon : runnerWon;
}

// Coins credited at settlement. A losing bet credits nothing: for Back the stake
// is gone, for Lay the liability reserved at placement stays with the house.
function settlementCredit(bet, won) {
  if (!won) return 0;
  if (bet.bet_type === 'lay') {
    const liability = bet.liability != null ? Number(bet.liability) : calcLiability(bet.stake, bet.odd);
    return Number(bet.stake) + liability;
  }
  return Math.floor(Number(bet.stake) * Number(bet.odd));
}

module.exports = { normalizeBetType, calcLiability, calcRisk, calcPotentialPayout, betWins, settlementCredit };
