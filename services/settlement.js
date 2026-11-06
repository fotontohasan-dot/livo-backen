// services/settlement.js
// ---------------------------------------------------------------------------
// Single-bet and whole-market settlement for Back and Lay bets.
// Every function takes an open transaction `client`; the caller does BEGIN/COMMIT.
//
//   Back wins  -> credit stake*odd              Back loses -> nothing
//   Lay  wins  -> credit stake + liability      Lay  loses -> liability stays with the house
//                 (runner lost)                      (runner won)
//
// Every settlement writes an append-only ledger row (coin_transactions /
// demo_transactions) tagged with ref_bet_id. A unique index on (ref_bet_id, type)
// plus the `status='pending'` guard make double-settlement impossible, and a DB
// trigger blocks UPDATEs of ledger rows that carry a ref_bet_id (migrations.js).
// ---------------------------------------------------------------------------
const { betWins, settlementCredit, calcLiability } = require('./layBet');

const TX = {
  back: { won: 'bet_win', lost: 'bet_loss' },
  lay:  { won: 'lay_win', lost: 'lay_loss' }
};

function describeTx(bet, won, credit) {
  if (bet.bet_type === 'lay') {
    return won
      ? `Lay won — stake ${bet.stake} + liability ${bet.liability} returned`
      : `Lay lost — liability ${bet.liability} retained by house`;
  }
  return won ? `Bet won — payout ${credit}` : `Bet lost — stake ${bet.stake}`;
}

// Settles ONE pending bet row (already selected FOR UPDATE by the caller).
// Returns { won, credit, notif } or null if the bet was not pending.
async function settleBet(client, bet, won) {
  const upd = await client.query(
    `UPDATE bets SET status = $1 WHERE id = $2 AND status = 'pending'`,
    [won ? 'won' : 'lost', bet.id]
  );
  if (upd.rowCount === 0) return null;

  const kind = bet.bet_type === 'lay' ? 'lay' : 'back';
  const credit = settlementCredit(bet, won);
  const type = TX[kind][won ? 'won' : 'lost'];
  const description = describeTx(bet, won, credit);

  if (bet.is_demo) {
    if (credit > 0) {
      await client.query('UPDATE users SET demo_balance = COALESCE(demo_balance,0) + $1 WHERE id = $2', [credit, bet.user_id]);
    }
    await client.query(
      `INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1,'sports',$2,$3,$4)`,
      [bet.user_id, type, credit, description + ' (demo)']
    );
  } else {
    if (credit > 0) {
      await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [credit, bet.user_id]);
    }
    // amount = 0 for losses: the money already left the wallet at placement,
    // this row is the audit record that the bet was resolved.
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description, ref_bet_id) VALUES ($1,$2,$3,$4,$5)`,
      [bet.user_id, credit, type, description, bet.id]
    );
  }

  const label = kind === 'lay' ? 'Lay' : '';
  const notif = await client.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4) RETURNING *`,
    won
      ? [bet.user_id, `${label} বেট জয়!`.trim(), `আপনি ${credit} কয়েন জিতেছেন!`, 'success']
      : [bet.user_id, 'বেট ফলাফল', kind === 'lay'
          ? `আপনার লে বেটটি হেরে গেছে — ${bet.liability} কয়েন লায়াবিলিটি হারিয়েছেন।`
          : 'আপনার বেটটি হেরে গেছে।', 'error']
  );
  return { won, credit, notif: notif.rows[0] };
}

// Settles every pending bet of a market for the given winning runner.
// Returns { total, winners, notifs: [{ userId, row }] }.
async function settleMarketBets(client, marketId, winningRunner) {
  const bets = await client.query(
    `SELECT * FROM bets WHERE market_id = $1 AND status = 'pending' FOR UPDATE`, [marketId]
  );
  let winners = 0;
  const notifs = [];
  for (const bet of bets.rows) {
    const won = betWins(bet, winningRunner);
    const res = await settleBet(client, bet, won);
    if (!res) continue;
    if (won) winners++;
    if (res.notif) notifs.push({ userId: bet.user_id, row: res.notif });
  }
  return { total: bets.rows.length, winners, notifs };
}

// What the user put at risk at placement = what a void/cancel must give back.
//   Back -> stake      Lay -> liability (the stake is never deducted from a layer)
function refundAmount(bet) {
  if (bet.bet_type === 'lay') {
    return bet.liability != null ? Number(bet.liability) : calcLiability(bet.stake, bet.odd);
  }
  return Number(bet.stake);
}

// Voids ONE pending bet (match cancelled / market voided): status -> 'void' and the reserved
// amount is returned. Same guards as settleBet: the status='pending' UPDATE plus the unique
// ledger index (ref_bet_id, type) make a second refund impossible.
async function voidBet(client, bet, reason) {
  const upd = await client.query(
    `UPDATE bets SET status = 'void' WHERE id = $1 AND status = 'pending'`, [bet.id]);
  if (upd.rowCount === 0) return null;

  const refund = refundAmount(bet);
  const type = bet.bet_type === 'lay' ? 'lay_void' : 'bet_void';
  const description = `Bet void${reason ? ' — ' + reason : ''} — ${refund} refunded`;

  if (bet.is_demo) {
    await client.query('UPDATE users SET demo_balance = COALESCE(demo_balance,0) + $1 WHERE id = $2', [refund, bet.user_id]);
    await client.query(
      `INSERT INTO demo_transactions (user_id, category, type, amount, description) VALUES ($1,'sports',$2,$3,$4)`,
      [bet.user_id, type, refund, description + ' (demo)']);
  } else {
    await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [refund, bet.user_id]);
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description, ref_bet_id) VALUES ($1,$2,$3,$4,$5)`,
      [bet.user_id, refund, type, description, bet.id]);
  }
  const notif = await client.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info') RETURNING *`,
    [bet.user_id, 'বেট বাতিল', `আপনার বেটটি বাতিল হয়েছে — ${refund} কয়েন ফেরত দেওয়া হয়েছে।`]);
  return { refund, notif: notif.rows[0] };
}

// Voids every pending bet of a market. Returns { total, refunded, notifs }.
async function voidMarketBets(client, marketId, reason) {
  const bets = await client.query(
    `SELECT * FROM bets WHERE market_id = $1 AND status = 'pending' ORDER BY id FOR UPDATE`, [marketId]);
  let refunded = 0;
  const notifs = [];
  for (const bet of bets.rows) {
    const res = await voidBet(client, bet, reason);
    if (!res) continue;
    refunded += res.refund;
    if (res.notif) notifs.push({ userId: bet.user_id, row: res.notif });
  }
  return { total: bets.rows.length, refunded, notifs };
}

// A winning_runner must be one of the market's actual runners. A typo used to settle every Back
// bet as lost and every Lay bet as won. Markets with no known runner list are not checked here.
function knownRunnerKeys(market) {
  const keys = new Set();
  for (const src of [market && market.odds, market && market.depth]) {
    if (src && typeof src === 'object') Object.keys(src).forEach((k) => keys.add(String(k)));
  }
  return keys;
}
function isValidWinningRunner(market, winningRunner) {
  const keys = knownRunnerKeys(market);
  if (keys.size === 0) return true;
  return keys.has(String(winningRunner));
}

module.exports = { settleBet, settleMarketBets, voidBet, voidMarketBets, refundAmount, isValidWinningRunner };
