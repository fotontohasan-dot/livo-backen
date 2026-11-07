// Lay/Back maths, settlement outcomes and sport tabs — no database needed.
const lay = require('../../services/layBet');
const { settleBet, settleMarketBets } = require('../../services/settlement');
const { buildMarketView, filterMarketView } = require('../../services/marketLayout');
const { resolveLayOdd, isRunnerSuspended } = require('../../services/oddsResolver');

describe('liability maths', () => {
  test('liability = stake * (odd - 1), rounded up, float-safe', () => {
    expect(lay.calcLiability(100, 3)).toBe(200);
    expect(lay.calcLiability(100, 1.85)).toBe(85);   // not 86 from 85.00000000000001
    expect(lay.calcLiability(10, 1.55)).toBe(6);     // 5.5 -> 6 (house-favourable)
  });
  test('risk and potential payout per bet type', () => {
    expect(lay.calcRisk('back', 100, 2.5)).toBe(100);
    expect(lay.calcRisk('lay', 100, 2.5)).toBe(150);
    expect(lay.calcPotentialPayout('back', 100, 2.5)).toBe(250);
    expect(lay.calcPotentialPayout('lay', 100, 2.5)).toBe(250); // stake 100 + liability 150 returned
  });
  test('bet_type validation', () => {
    expect(lay.normalizeBetType(undefined)).toBe('back');
    expect(lay.normalizeBetType('LAY')).toBe('lay');
    expect(lay.normalizeBetType('exchange')).toBeNull();
  });
});

describe('outcomes', () => {
  const layBet = { bet_type: 'lay', runner: '0', stake: 100, odd: 3, liability: 200 };
  const backBet = { bet_type: 'back', runner: '0', stake: 100, odd: 3 };
  test('lay loses when the runner wins, wins when it loses', () => {
    expect(lay.betWins(layBet, '0')).toBe(false);
    expect(lay.betWins(layBet, '1')).toBe(true);
  });
  test('credits', () => {
    expect(lay.settlementCredit(layBet, true)).toBe(300);  // stake + liability back
    expect(lay.settlementCredit(layBet, false)).toBe(0);   // liability kept by house
    expect(lay.settlementCredit(backBet, true)).toBe(300);
    expect(lay.settlementCredit({ ...backBet, bet_type: undefined }, true)).toBe(300); // legacy rows
  });
});

function fakeClient(pendingBets) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT \* FROM bets/i.test(sql.trim())) return { rows: pendingBets, rowCount: pendingBets.length };
      if (/^UPDATE bets/i.test(sql.trim())) return { rows: [], rowCount: 1 };
      if (/INSERT INTO notifications/i.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
}

describe('settlement engine', () => {
  test('lay that wins credits stake+liability and logs a lay_win ledger row', async () => {
    const bet = { id: 7, user_id: 5, bet_type: 'lay', runner: '0', stake: 100, odd: 3, liability: 200, is_demo: false };
    const c = fakeClient([bet]);
    const r = await settleMarketBets(c, 1, '1');
    expect(r).toMatchObject({ total: 1, winners: 1 });
    const bal = c.calls.find((x) => /UPDATE users SET coins/.test(x.sql));
    expect(bal.params).toEqual([300, 5]);
    const tx = c.calls.find((x) => /INSERT INTO coin_transactions/.test(x.sql));
    expect(tx.params.slice(0, 3)).toEqual([5, 300, 'lay_win']);
    expect(tx.params[4]).toBe(7); // ref_bet_id
  });
  test('lay that loses moves no coins but still writes a zero-amount lay_loss row', async () => {
    const bet = { id: 8, user_id: 5, bet_type: 'lay', runner: '0', stake: 100, odd: 3, liability: 200, is_demo: false };
    const c = fakeClient([bet]);
    const r = await settleMarketBets(c, 1, '0');
    expect(r.winners).toBe(0);
    expect(c.calls.some((x) => /UPDATE users SET coins/.test(x.sql))).toBe(false);
    const tx = c.calls.find((x) => /INSERT INTO coin_transactions/.test(x.sql));
    expect(tx.params.slice(0, 3)).toEqual([5, 0, 'lay_loss']);
  });
  test('back bet unchanged: pays stake*odd', async () => {
    const bet = { id: 9, user_id: 5, bet_type: 'back', runner: '0', stake: 100, odd: 1.85, is_demo: false };
    const c = fakeClient([bet]);
    await settleMarketBets(c, 1, '0');
    expect(c.calls.find((x) => /UPDATE users SET coins/.test(x.sql)).params).toEqual([185, 5]);
  });
  test('an already-settled bet is skipped (no double credit)', async () => {
    const c = fakeClient([]);
    c.query = async (sql) => (/^UPDATE bets/i.test(sql.trim()) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 });
    expect(await settleBet(c, { id: 1, user_id: 1, bet_type: 'back', stake: 10, odd: 2, runner: 'a' }, true)).toBeNull();
  });
});

describe('lay price + runner suspension', () => {
  test('lay price comes only from depth; none -> null', () => {
    expect(resolveLayOdd({ depth: { 0: { lay: 2.2 } } }, '0')).toBe(2.2);
    expect(resolveLayOdd({ depth: { 0: { back: 2.1 } } }, '0')).toBeNull();
    expect(resolveLayOdd({ odds: { 0: 2 } }, '0')).toBeNull();
  });
  test('runner suspension', () => {
    expect(isRunnerSuspended({ runner_status: { 0: 'suspended' } }, '0')).toBe(true);
    expect(isRunnerSuspended({ runner_status: { 0: 'open' } }, '0')).toBe(false);
    expect(isRunnerSuspended({}, '0')).toBe(false);
  });
});

describe('sport tabs', () => {
  const ou = (n) => ({ id: n, type: 'over_under', name: 'Total Goals Over/Under 2.5', odds: { over: 1.9, under: 1.9 } });
  test('football: Full Time Result / Goals / BTTS', () => {
    const view = buildMarketView([
      { id: 1, type: 'match_odds', name: 'Match Result (1X2)', odds: { 0: 2, draw: 3, 1: 3 } },
      ou(2),
      { id: 3, type: 'yes_no', name: 'Both Teams To Score — Yes/No', odds: { yes: 1.8, no: 1.95 } }
    ], { sport: 'football', teams: ['A', 'B'] });
    expect(view.tabs.map((t) => t.label)).toEqual(expect.arrayContaining(['Full Time Result', 'Goals (Over/Under)', 'Both Teams to Score']));
    expect(filterMarketView(view, 'btts').map((m) => m.id)).toEqual([3]);
    expect(filterMarketView(view, 'goals').map((m) => m.id)).toEqual([2]);
    expect(filterMarketView(view, 'match').map((m) => m.id)).toEqual([1]);
  });
  test('tennis: Match Winner / Set Winner / Game Totals', () => {
    const view = buildMarketView([
      { id: 1, type: 'bookmaker', name: 'Match Winner', odds: { 0: 1.5, 1: 2.6 } },
      { id: 2, type: 'bookmaker', name: 'Set 1 Winner', odds: { 0: 1.9, 1: 1.9 } },
      { id: 3, type: 'over_under', name: 'Total Games Over/Under 21.5', odds: { over: 1.9, under: 1.9 } },
      { id: 4, type: 'over_under', name: 'Set 1 Total Games Over/Under 9.5', odds: { over: 1.9, under: 1.9 } }
    ], { sport: 'tennis', teams: ['A', 'B'] });
    expect(view.tabs.map((t) => t.label)).toEqual(expect.arrayContaining(['Match Winner', 'Set Winner', 'Game Totals']));
    expect(filterMarketView(view, 'match').map((m) => m.id)).toEqual([1]);
    expect(filterMarketView(view, 'set').map((m) => m.id)).toEqual([2]);
    expect(filterMarketView(view, 'games').map((m) => m.id)).toEqual([3, 4]);
  });
  test('cricket: Match Winner / Bookmaker / Fancy / Over-Under / Odd-Even / Player Performance', () => {
    const view = buildMarketView([
      { id: 1, type: 'bookmaker', name: 'Match Winner', odds: { 0: 1.8, 1: 2 } },
      { id: 2, type: 'bookmaker', name: 'Bookmaker 2', odds: { 0: 1.8, 1: 2 } },
      { id: 3, type: 'fancy', name: '6 Over Session', odds: { over: 1.9, under: 1.9 } },
      { id: 4, type: 'over_under', name: 'Alpha Total Runs Over/Under 160.5', odds: { over: 1.9, under: 1.9 } },
      { id: 5, type: 'odd_even', name: 'Alpha Total Runs (Odd/Even)', odds: { odd: 1.9, even: 1.9 } },
      { id: 6, type: 'yes_no', name: 'Fifty scored — Yes/No', odds: { yes: 1.4, no: 2.6 } }
    ], { sport: 'cricket', teams: ['A', 'B'] });
    const by = (tab) => filterMarketView(view, tab).map((m) => m.id);
    expect([by('match'), by('bookmaker'), by('fancy'), by('ou'), by('oe'), by('player')]).toEqual([[1], [2], [3], [4], [5], [6]]);
  });
  test('depth sizes flow into runners (matched volume under odds)', () => {
    const view = buildMarketView([{ id: 1, type: 'bookmaker', name: 'Match Winner', odds: { 0: 2, 1: 2 },
      depth: { 0: { lay: 2.1, back_size: 1500, lay_size: 900 } } }], { sport: 'tennis', teams: ['A', 'B'] });
    expect(view.markets[0].runners[0]).toMatchObject({ backSize: 1500, laySize: 900 });
  });
  test('runner lay price and status flow into the view', () => {
    const view = buildMarketView([{ id: 1, type: 'bookmaker', name: 'Match Winner', odds: { 0: 2, 1: 2 },
      depth: { 0: { lay: 2.1 } }, runner_status: { 1: 'suspended' } }], { sport: 'tennis', teams: ['A', 'B'] });
    const [r0, r1] = view.markets[0].runners;
    expect(r0.lay).toBe(2.1);
    expect(r1.status).toBe('suspended');
  });
});
