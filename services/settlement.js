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
const { betWins, settlementCredit } = require('./layBet');

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

module.exports = { settleBet, settleMarketBets };
